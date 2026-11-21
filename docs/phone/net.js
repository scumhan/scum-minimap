/* 第一百一十八批：手机端跨网传输
   出门在外，手机跟家里电脑不在一个网，局域网那套 http + SSE 到不了。
   这里换成：连公共 broker（wss）→ 订阅一条由「房间号 + 密码」派生的主题 →
   收发都是 AES-256-GCM 整包密文。

   跟局域网那套的差别只有一个：怎么把字节送到对面。
   配对、权限、限速、踢人全在电脑那边判定，这边只管搬。

   暴露给 phone.js 的接口：
     PN.init({ room, pass, devId })   派生密钥、连 broker（返回 Promise）
     PN.req(path, body)               发一条请求，等对面回（Promise）
     PN.onFrame(fn) / PN.onMarks(fn)  订阅推送
     PN.close()
     PN.st                       '' | 'connecting' | 'online' | 'error'
*/
(function () {
  'use strict';

  // 第一百三十批：国际节点在国内移动网络下时通时不通（实测 1 秒通 / 6 秒超时来回跳），
  // 换成国内节点。两端必须用同一个 broker，否则派生的主题对不上。
  var BROKER = 'wss://broker-cn.emqx.io:8084/mqtt';
  var BROKER_HOST = 'broker-cn.emqx.io';
  var REQ_TIMEOUT = 12000;
  var PING_MS = 25000;
  var RETRY_MAX = 20000;

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  var st = '';
  var err = '';
  var ws = null;
  var pingTimer = null;
  var retryTimer = null;
  var retryDelay = 1500;
  var started = false;
  var pid = 1;
  var topicUp = '';
  var topicDn = '';
  var aesKey = null;
  var room = '';
  var pass = '';
  var devId = '';
  var seq = 0;
  var waiters = {};       // 请求号 -> { ok, fail, timer }
  var frameCb = null;
  var marksCb = null;
  var openWaiters = [];

  function b64(bytes) {
    var s = '';
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function unb64(str) {
    var raw = atob(String(str || ''));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function randHex(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  // 密钥：房间号和密码拼一起做 PBKDF2。二十万轮在手机上大约半秒，
  // 只在首次进来算一次，之后这次会话里一直用
  function derive() {
    var seed = enc.encode('scum-minimap-v2|P\u0000' + room + '\u0000' + pass);
    return crypto.subtle.importKey('raw', seed, 'PBKDF2', false, ['deriveBits'])
      .then(function (k) {
        return crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: enc.encode('scum-minimap-v2-salt'), iterations: 200000, hash: 'SHA-256' },
          k, 256
        );
      })
      .then(function (bits) {
        return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          .then(function (hk) { return crypto.subtle.sign('HMAC', hk, enc.encode('scum-minimap-phone-v1')); })
          .then(function (sig) {
            var h = '';
            var b = new Uint8Array(sig);
            for (var i = 0; i < 12; i++) h += ('0' + b[i].toString(16)).slice(-2);
            topicUp = 'smm4/' + h + '/u';
            topicDn = 'smm4/' + h + '/d';
            return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
          });
      })
      .then(function (k) { aesKey = k; });
  }

  function seal(obj) {
    var iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, aesKey, enc.encode(JSON.stringify(obj)))
      .then(function (buf) {
        var all = new Uint8Array(buf);
        var ct = all.subarray(0, all.length - 16);
        var tag = all.subarray(all.length - 16);
        var out = new Uint8Array(12 + 16 + ct.length);
        out.set(iv, 0);
        out.set(tag, 12);
        out.set(ct, 28);
        return b64(out);
      });
  }

  function open(str) {
    return Promise.resolve().then(function () {
      var buf = unb64(str);
      if (buf.length < 30) return null;
      var iv = buf.subarray(0, 12);
      var tag = buf.subarray(12, 28);
      var ct = buf.subarray(28);
      var joined = new Uint8Array(ct.length + 16);
      joined.set(ct, 0);
      joined.set(tag, ct.length);
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, aesKey, joined)
        .then(function (plain) {
          var j = JSON.parse(dec.decode(plain));
          return (j && j.t === 'smm4') ? j : null;
        })
        .catch(function () { return null; });
    });
  }

  /* ---------- 最小 MQTT（只够用 QoS0 这一档） ---------- */
  function varint(n) {
    var out = [];
    do {
      var d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d = d | 128;
      out.push(d);
    } while (n > 0);
    return new Uint8Array(out);
  }

  function pack(type, body) {
    var v = varint(body.length);
    var out = new Uint8Array(1 + v.length + body.length);
    out[0] = type;
    out.set(v, 1);
    out.set(body, 1 + v.length);
    return out;
  }

  function str(s) {
    var b = enc.encode(s);
    var out = new Uint8Array(2 + b.length);
    out[0] = (b.length >> 8) & 255;
    out[1] = b.length & 255;
    out.set(b, 2);
    return out;
  }

  function cat(arrs) {
    var n = 0, i;
    for (i = 0; i < arrs.length; i++) n += arrs[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < arrs.length; i++) { out.set(arrs[i], o); o += arrs[i].length; }
    return out;
  }

  function mqConnect(cid) {
    var vh = cat([str('MQTT'), new Uint8Array([4, 2, 0, 60])]);  // 4=MQTT3.1.1, 2=clean session, keepalive 60s
    return pack(0x10, cat([vh, str(cid)]));
  }

  function mqSubscribe(topic) {
    var pidb = new Uint8Array([(pid >> 8) & 255, pid & 255]);
    return pack(0x82, cat([pidb, str(topic), new Uint8Array([0])]));
  }

  function mqPublish(topic, payload) {
    return pack(0x30, cat([str(topic), payload]));
  }

  var PINGREQ = new Uint8Array([0xc0, 0]);
  var DISCONNECT = new Uint8Array([0xe0, 0]);

  function parse(buf) {
    var i = 0;
    while (i < buf.length) {
      var type = buf[i] >> 4;
      var mult = 1, len = 0, b, j = i + 1;
      do {
        if (j >= buf.length) return;
        b = buf[j++];
        len += (b & 127) * mult;
        mult *= 128;
      } while (b & 128);
      if (j + len > buf.length) return;

      if (type === 2) {
        var rc = len >= 2 ? buf[j + 1] : 1;
        if (rc === 0) {
          st = 'online';
          err = '';
          retryDelay = 1500;
          // 第一百二十四批：这里原来订的是 topicUp，等于订了自己发出去的那条，
          // 电脑把回包发在 topicDn 上，手机永远收不到 —— 表现就是每次卡满 12 秒
          // 然后说「电脑没回话」。订阅下行才对得上。
          try { ws.send(mqSubscribe(topicDn)); } catch (e) {}
          if (pingTimer) clearInterval(pingTimer);
          pingTimer = setInterval(function () {
            if (ws && ws.readyState === 1) { try { ws.send(PINGREQ); } catch (e) {} }
          }, PING_MS);
          var w = openWaiters;
          openWaiters = [];
          w.forEach(function (fn) { fn(true); });
        } else {
          st = 'error';
          err = '服务器拒了（' + rc + '）';
          var w2 = openWaiters;
          openWaiters = [];
          w2.forEach(function (fn) { fn(false); });
        }
      } else if (type === 3 && len >= 2) {
        var tlen = (buf[j] << 8) | buf[j + 1];
        var t1 = j + 2 + tlen;
        if (t1 <= j + len) {
          var topic = dec.decode(buf.subarray(j + 2, t1));
          if (topic === topicDn) {
            // 第一百三十批：这里原来是 b64(...)，等于把 broker 上那串 base64 文本
            // 又编了一次 base64 —— open() 里 unb64 解出来的还是文本字节，IV/tag 全错位，
            // 解密必然失败、还静默返回 null。表现就是电脑明明回了包，手机永远「没回话」。
            // 电脑端发的是 base64 文本，这里按文本取出来直接交给 open() 才对。
            var raw = dec.decode(buf.subarray(t1, j + len));
            open(raw).then(function (m) {
              if (!m) return;
              if (m.k === 'frame' && frameCb) frameCb(m.b);
              else if (m.k === 'marks' && marksCb) marksCb(m.b);
              else if (m.k === 'res') {
                var w = waiters[String(m.i || '')];
                if (w) {
                  delete waiters[String(m.i || '')];
                  clearTimeout(w.timer);
                  w.ok(m.b);
                }
              }
            });
          }
        }
      }
      i = j + len;
    }
  }

  function scheduleRetry() {
    if (retryTimer || !started) return;
    var d = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (started) connect();
    }, d);
  }

  function connect() {
    var w;
    try { w = new WebSocket(BROKER, 'mqtt'); } catch (e) {
      st = 'error'; err = '连不上中转服务器'; scheduleRetry(); return;
    }
    w.binaryType = 'arraybuffer';
    ws = w;
    st = 'connecting';
    w.onopen = function () {
      try { w.send(mqConnect('smm' + randHex(5))); } catch (e) {}
    };
    w.onmessage = function (ev) {
      try { parse(new Uint8Array(ev.data)); } catch (e) {}
    };
    w.onerror = function () { st = 'error'; err = '连不上 ' + BROKER_HOST; };
    w.onclose = function () {
      if (ws !== w) return;
      ws = null;
      st = '';
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (started) scheduleRetry();
    };
  }

  /* ---------- 对外 ---------- */
  function init(opts) {
    var o = opts || {};
    close();
    room = String(o.room || '').trim();
    // 第一百二十四批：密码也去空格。手机键盘选词、粘贴时常带个尾巴空格，
    // 差一个字符派出来的主题就完全是另一条，电脑那边等于没人在听。
    pass = String(o.pass || '').trim();
    devId = String(o.devId || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
    if (devId.length < 6) devId = randHex(8);
    started = true;
    st = 'connecting';
    err = '';
    return derive().then(function () {
      return new Promise(function (res) {
        openWaiters.push(function (ok) {
          if (!ok) err = err || '连不上 ' + BROKER_HOST;
          res({ ok: ok, st: st, err: err });
        });
        connect();
        setTimeout(function () {
          // 第一百三十批：十五秒太长，八秒没连上就报，后台继续重试。
          // 人盯着「正在连中转」转十五秒，只会以为程序坏了。
          if (st !== 'online') {
            var idx = openWaiters.length;
            openWaiters = [];
            if (idx) res({ ok: false, st: st || 'error', err: err || '连不上 ' + BROKER_HOST });
          }
        }, 8000);
      });
    }).catch(function (e) {
      // 第一百三十批：派生密钥这步以前没有 catch —— 一旦抛异常（老浏览器的
      // crypto.subtle、隐私模式下的配额限制），Promise 直接悬着，页面永远停在
      // 「正在连中转」。现在失败要立刻说清楚是哪一步。
      st = 'error';
      started = false;
      err = '加密初始化失败：' + ((e && (e.name || e.message)) || String(e));
      return { ok: false, st: st, err: err };
    });
  }

  function req(path, body) {
    if (!aesKey) return Promise.resolve({ ok: false, why: 'nokey' });
    if (!ws || ws.readyState !== 1 || st !== 'online') return Promise.resolve({ ok: false, why: 'offline' });
    var id = 'q' + (++seq).toString(36) + randHex(3);
    return new Promise(function (res) {
      var timer = setTimeout(function () {
        delete waiters[id];
        res({ ok: false, why: 'timeout' });
      }, REQ_TIMEOUT);
      waiters[id] = { ok: res, timer: timer };
      seal({ t: 'smm4', k: 'req', i: id, d: devId, p: path, b: body || null }).then(function (txt) {
        try { ws.send(mqPublish(topicUp, enc.encode(txt))); } catch (e) {
          clearTimeout(timer);
          delete waiters[id];
          res({ ok: false, why: 'send' });
        }
      });
    });
  }

  function close() {
    started = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    Object.keys(waiters).forEach(function (k) {
      clearTimeout(waiters[k].timer);
      waiters[k].ok({ ok: false, why: 'closed' });
      delete waiters[k];
    });
    openWaiters = [];
    var w = ws;
    ws = null;
    st = '';
    if (w) {
      try {
        if (w.readyState === 1) w.send(DISCONNECT);
        w.onopen = w.onmessage = w.onerror = w.onclose = null;
        w.close();
      } catch (e) {}
    }
  }

  window.PN = {
    init: init,
    req: req,
    close: close,
    onFrame: function (fn) { frameCb = fn; },
    onMarks: function (fn) { marksCb = fn; },
    devId: function () { return devId; },
    status: function () { return { st: st, err: err }; }
  };
})();
