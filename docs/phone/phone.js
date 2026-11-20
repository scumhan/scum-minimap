/* 手机端主脚本 —— 零依赖，配对 → SSE 收状态 → canvas 画 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  // 手机页自己有套 i18n（pi18n.js 挂在 window.T 上），电脑那套在这边用不上
  function T(s, v) { return (window.PI && window.PI.t) ? window.PI.t(s, v) : s; }
  var LS_T = 'smm_phone_token';
  var LS_N = 'smm_phone_name';
  var LS_O = 'smm_phone_opt';
  // 第一百一十八批：跨网存的房间号 + 密码，以及这台手机在中转上的设备号
  var LS_R = 'smm_phone_relay';
  var LS_D = 'smm_phone_dev';
  var LS_X = 'smm_phone_net';

  // 跨网模式：?net=1 进来就记住，刷新还是跨网；?net=0 清掉，回局域网
  var NET = false;
  try {
    if (/[?&]net=1/.test(location.search)) { NET = true; localStorage.setItem(LS_X, '1'); }
    else if (/[?&]net=0/.test(location.search)) { NET = false; localStorage.removeItem(LS_X); }
    else NET = localStorage.getItem(LS_X) === '1';
  } catch (e) {}
  var netPing = null;

  var token = '';
  var state = null;
  var es = null;
  var baseImg = null;
  var baseOk = false;

  // 视图：世界坐标中心 + 缩放（屏幕像素 / 世界像素）
  var vx = 0, vy = 0, vs = 0.14;
  var follow = true;
  var opt = { peer: true, mark: true, base: true, me: true, coord: false, wake: true, follow: true };

  // 标点类型 → 颜色。电脑那边是按类型分组的四色，手机屏幕小不画分组，
  // 但至少让人一眼分出「这是危险点还是物资点」
  var MK_COLOR = {
    danger: '#ff6b6b', target: '#ff6b6b', trap: '#ff6b6b',
    base: '#c084fc', home: '#c084fc', vehicle: '#c084fc', heli: '#c084fc',
    boat: '#c084fc', bunker: '#c084fc', camp: '#c084fc',
    custom: '#e879f9'
  };

  var cv = $('cv');
  var ctx = cv.getContext('2d');
  var W = 0, H = 0, DPR = 1;
  var dirty = true;
  // 最近一份标点（marks 事件给的）。帧里不再带标点，两份拼在一起画
  var phMk = null;
  var lastFrame = 0;

  /* ---------- 小工具 ---------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // 电脑那头「允许手机显示什么」。手机自己那排开关是临时遮罩，
  // 两边都开才画 —— 设置页关掉的，手机上点不回来
  function shOn(k, dflt) {
    var s = state && state.sh;
    if (!s) return dflt;
    var v = s[k];
    return v === undefined ? dflt : v !== false;
  }

  // 电脑那头「允许手机改什么」。只读开着时三个全是 false，
  // 按钮直接灰掉 —— 拦得住误触，真正的防线在主进程
  function pm(k) {
    var p = state && state.pm;
    return !!(p && p[k]);
  }

  // 速度：电脑给的是 cm/s，手机上换算成人看的单位
  function fmtSpd(cmps, unit) {
    var v = Number(cmps) || 0;
    if (unit === 'ms') return (v / 100).toFixed(1) + ' m/s';
    if (unit === 'mph') return (v * 0.0223694).toFixed(0) + ' mph';
    return (v * 0.036).toFixed(0) + ' km/h';
  }

  // 记一份原文：切语言时得拿原文重翻，不能拿已经翻过的再翻
  var statRaw = null;
  function setStat(txt, cls) {
    var el = $('stat');
    statRaw = { txt: txt, cls: cls || '' };
    el.textContent = T(txt);
    el.className = 'pill' + (cls ? ' ' + cls : '');
  }

  // 换语言：静态文案重扫一遍，状态条和只读提示拿原文重写
  function applyLang(code) {
    if (!window.PI || PI.lang === code) return;
    PI.setLang(code);
    PI.apply(document.body);
    document.title = T(document.title);
    if (statRaw) setStat(statRaw.txt, statRaw.cls);
    var rt = $('roTip');
    if (rt && !rt.classList.contains('hide')) {
      rt.innerHTML = T('这台手机现在是<b>只读</b>，只能看，改不了。');
    }
    capTip();
    renderList();
    buildPick();
    dirty = true;
  }

  function api(p, body, t) {
    // 第一百一十八批：跨网走中转。路径里的查询串（令牌）在这边没意义 ——
    // 中转那头的身份是 devId，由 net.js 自己带上
    if (NET && window.PN) return window.PN.req(String(p).split('?')[0], body || null);
    var h = { 'Content-Type': 'application/json' };
    if (t) h['X-Token'] = t;
    return fetch(p, {
      method: body ? 'POST' : 'GET',
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        j.__status = r.status;
        return j;
      });
    });
  }

  /* ---------- 配对 ---------- */
  function showPair(msg) {
    $('pair').classList.remove('hide');
    $('main').classList.add('hide');
    $('err').textContent = msg ? T(msg) : '';
    if (es) { try { es.close(); } catch (e) {} es = null; }
  }

  function doPair() {
    if (NET) return doPairNet();
    var c = ($('code').value || '').replace(/\D/g, '');
    if (c.length !== 6) { $('err').textContent = T('配对码是 6 位数字'); return; }
    var n = ($('name').value || '').trim();
    $('go').disabled = true;
    $('err').textContent = '';
    api('/api/pair', { c: c, n: n }).then(function (j) {
      $('go').disabled = false;
      if (!j.ok) {
        var m = { expired: '配对码过期了，回电脑上点「重新生成」', code: '配对码不对', locked: '错太多次，等 5 分钟再试', full: '电脑上连的手机太多了，先踢掉一台' };
        $('err').textContent = m[j.why] ? T(m[j.why]) : T('配对失败：{why}', { why: j.why || j.__status });
        return;
      }
      token = j.token;
      try {
        localStorage.setItem(LS_T, token);
        if (n) localStorage.setItem(LS_N, n);
      } catch (e) {}
      enter();
    }).catch(function () {
      $('go').disabled = false;
      $('err').textContent = '连不上电脑，检查是否同一个 WiFi';
    });
  }

  /* ---------- 第一百一十八批：跨网配对 ----------
     不在同一个网里，没有 6 位码这回事：房间号决定「找哪条通道」，
     密码决定「能不能解开」。两个都对，电脑那头才会把你登记成一台设备 */
  function doPairNet() {
    var r = ($('nroom').value || '').trim();
    var p = $('npass').value || '';
    var n = ($('name').value || '').trim();
    if (!r || !p) { $('err').textContent = T('房间号和密码都要填'); return; }
    if (!window.PN) { $('err').textContent = T('这个页面缺了 net.js，重开一次'); return; }
    $('go').disabled = true;
    $('err').textContent = T('正在连中转…');
    var dev = '';
    try { dev = localStorage.getItem(LS_D) || ''; } catch (e) {}
    window.PN.init({ room: r, pass: p, devId: dev }).then(function (x) {
      if (!x.ok) {
        $('go').disabled = false;
        $('err').textContent = T('连不上中转：{why}', { why: x.err || x.st || '' });
        return null;
      }
      return window.PN.req('/api/ping', { n: n }).then(function (j) {
        $('go').disabled = false;
        if (!j || !j.ok) {
          var m = { full: '电脑上连的手机太多了，先踢掉一台', auth: '房间号或密码不对', timeout: '密码不对，或者电脑那边没开跨网中继' };
          $('err').textContent = m[j && j.why] ? T(m[j.why]) : T('连不上电脑：{why}', { why: (j && j.why) || '' });
          return;
        }
        try {
          localStorage.setItem(LS_R, JSON.stringify({ room: r, pass: p }));
          localStorage.setItem(LS_D, window.PN.devId());
          if (n) localStorage.setItem(LS_N, n);
        } catch (e) {}
        token = 'net';
        enter();
      });
    });
  }

  // 两种配对方式只显示一种，别让人在两个框里猜该填哪个
  function pairMode() {
    if ($('pairLan')) $('pairLan').classList.toggle('hide', NET);
    if ($('pairNet')) $('pairNet').classList.toggle('hide', !NET);
  }

  /* ---------- 电脑那三项「画面」设置 ---------- */
  // 第一百零九批：底图质量 / 界面缩放 / 强制横屏以前只存在设置页里，
  // 帧也带过来了，但这边一个字都没读，等于摆着三颗没接线的开关。
  var curBm = 0, curSc = 0, curLand = null;

  // 底图：2048 省流量、4096 清楚。换尺寸时先让旧图下场，别拿旧图硬画
  function applyBase(bm) {
    var v = Number(bm) === 4096 ? 4096 : 2048;
    if (v === curBm) return;
    curBm = v;
    if (!baseImg) {
      baseImg = new Image();
      baseImg.onload = function () { baseOk = true; dirty = true; };
      baseImg.onerror = function () { baseOk = false; dirty = true; };
    }
    baseOk = false;
    // 相对路径：局域网页面在根（/map.webp），公网托管在子目录（…/phone/map.webp）
    baseImg.src = 'map.webp?s=' + v;
    dirty = true;
  }

  // 界面缩放：一个 CSS 变量管所有尺寸，改完画布要重新量一遍
  function applyScale(sc) {
    var v = Math.min(2, Math.max(0.6, Number(sc) || 1));
    if (v === curSc) return;
    curSc = v;
    document.documentElement.style.setProperty('--ui', String(v));
    resize();
  }

  // 强制横屏：勾上之后竖着拿也按横屏那套紧凑排布，小屏能多露一截地图
  function applyLand(land) {
    var v = land === true;
    if (v === curLand) return;
    curLand = v;
    document.body.classList.toggle('land', v);
    resize();
  }

  /* ---------- 主界面 ---------- */
  function enter() {
    $('pair').classList.add('hide');
    $('main').classList.remove('hide');
    resize();
    applyBase(2048);
    connect();
    wakeOn();
  }

  // 一帧到了：局域网 SSE 和跨网中转都走这里，画法只有一份
  function applyFrame(s) {
    if (!s) return;
    state = s;
    // 第一百一十批：标点改成单独一条事件了，帧里没有。整份替换会把它冲掉，
    // 所以每次新帧都把最近一份标点贴回去
    if (phMk) { state.mk = phMk.mk; state.mkt = phMk.mkt; }
    setStat('已连接', 'on');
    applyBase(state.bm);
    applyScale(state.sc);
    applyLand(state.land);
    lastFrame = Date.now();
    if (state.lang) applyLang(state.lang);
    if (follow && state.me) { vx = state.me.gx; vy = state.me.gy; }
    else if (!state.__init) { state.__init = 1; if (state.me) { vx = state.me.gx; vy = state.me.gy; } }
    var sp = $('spd');
    if (state.me && state.me.spd != null && shOn('spd', true)) {
      sp.classList.remove('hide');
      sp.textContent = fmtSpd(state.me.spd, state.unit);
    } else sp.classList.add('hide');
    // 权限变了当场生效，不用重连
    $('mark').disabled = !pm('mark');
    var ro = !!(state.pm && !state.pm.mark && !state.pm.toggle && !state.pm.del);
    // 整句由这边写：HTML 里 <b> 会把句子拆成三段文本节点，语言包翻不了
    if (ro) $('roTip').innerHTML = T('这台手机现在是<b>只读</b>，只能看，改不了。');
    $('roTip').classList.toggle('hide', !ro);
    dirty = true;
  }

  // 标点只在真变了才来（主窗口一秒对一次指纹）。服务端新连接会补推一份，
  // 顺序是帧在前、标点在后 —— 反了就会先拿到一批不知道画在哪的点
  function applyMarks(d) {
    if (!d || typeof d !== 'object') return;
    phMk = {
      mk: Array.isArray(d.mk) ? d.mk : [],
      mkt: Array.isArray(d.mkt) ? d.mkt : null,
      tot: Number(d.tot) || 0,
      cap: Number(d.cap) || 0
    };
    if (state) { state.mk = phMk.mk; state.mkt = phMk.mkt; }
    capTip();
    // 第一百一十五批：列表开着的时候标点变了，当场重排，不用关了再开
    if ($('plist') && !$('plist').classList.contains('hide')) renderList();
    dirty = true;
  }

  function connect() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    setStat('连接中…');

    // 第一百一十八批：跨网没有 SSE。中转推什么就画什么，
    // 断线由 net.js 自己按退避重连，这边每 15 秒 ping 一次探活
    if (NET) {
      if (window.PN) {
        window.PN.onFrame(applyFrame);
        window.PN.onMarks(applyMarks);
      }
      if (netPing) clearInterval(netPing);
      netPing = setInterval(function () {
        if (!NET || !window.PN) return;
        window.PN.req('/api/ping', null).then(function (j) {
          if (j && j.ok) setStat('已连接', 'on');
          else setStat('重连中…', 'off');
        });
      }, 15000);
      return;
    }

    var url = '/api/stream?t=' + encodeURIComponent(token);
    es = new EventSource(url);
    es.addEventListener('frame', function (e) {
      try { applyFrame(JSON.parse(e.data)); } catch (x) {}
    });
    es.addEventListener('marks', function (e) {
      try { applyMarks(JSON.parse(e.data)); } catch (x) {}
    });
    es.onopen = function () { setStat('已连接', 'on'); };
    es.onerror = function () {
      setStat('重连中…', 'off');
      // token 失效就别傻等了，回配对页。ping 永远回 200，看的是 auth 字段
      api('/api/ping?t=' + encodeURIComponent(token), null).then(function (j) {
        if (j.__status === 401 || j.auth === false) {
          try { localStorage.removeItem(LS_T); } catch (e) {}
          showPair('电脑那头断开了，重新配一次');
        }
      }).catch(function () {});
    };
  }

  /* ---------- 画布 ---------- */
  // 第一百一十四批：像素密度按设备收。
  // DPR 3 的手机上，1080×2400 的屏意味着 canvas 是 3240×7200 = 2300 万像素 ——
  // 每帧一次 clearRect 加一次整张底图绘制，中端机根本扛不住。底图是照片不是文字，
  // 2 倍已经看不出差别；内存 3G 及以下的老机器再往下收一档到 1.5。
  // navigator.deviceMemory 只有 Chromium 系有，拿不到就按 2 算（Safari 走这条）
  function pickDpr() {
    var raw = window.devicePixelRatio || 1;
    var mem = Number(navigator.deviceMemory) || 0;
    return Math.min(raw, mem && mem <= 3 ? 1.5 : 2);
  }

  function resize() {
    DPR = pickDpr();
    W = cv.clientWidth || window.innerWidth;
    H = cv.clientHeight || window.innerHeight;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    dirty = true;
  }

  function draw() {
    if (!W || !H) resize();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#080d11';
    ctx.fillRect(0, 0, W, H);

    var MAP = (state && state.map) || 10161;
    var s = vs;
    var cx = W / 2, cy = H / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-vx, -vy);

    // 底图
    if (opt.base && shOn('base', true) && baseOk && baseImg && baseImg.complete) {
      ctx.globalAlpha = 0.92;
      ctx.drawImage(baseImg, 0, 0, MAP, MAP);
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = 'rgba(127,212,255,.12)';
      ctx.lineWidth = 1 / s;
      ctx.strokeRect(0, 0, MAP, MAP);
    }

    if (!state) { ctx.restore(); return; }

    // 标点
    if (opt.mark && shOn('mark', true) && state.mk && state.mk.length) {
      var arr = state.mk;
      var fs = Math.max(11 / s, 1);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        if (m.gx == null) continue;
        ctx.beginPath();
        ctx.arc(m.gx, m.gy, Math.max(3 / s, 1.6), 0, 6.2832);
        ctx.fillStyle = m.c || MK_COLOR[m.t] || '#ff7a7a';
        ctx.fill();
        if (s > 0.08) {
          ctx.font = '600 ' + fs + 'px system-ui, sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,.86)';
          ctx.fillText(m.n || '', m.gx, m.gy - fs * 1.3);
        }
      }
    }

    // 队友
    if (opt.peer && shOn('peer', true) && state.pr && state.pr.length) {
      var ps = state.pr;
      var fs2 = Math.max(11 / s, 1);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var k = 0; k < ps.length; k++) {
        var p = ps[k];
        if (p.gx == null) continue;
        ctx.beginPath();
        ctx.arc(p.gx, p.gy, Math.max(4 / s, 2), 0, 6.2832);
        ctx.fillStyle = p.c || '#7fd4ff';
        ctx.fill();
        ctx.lineWidth = Math.max(1.2 / s, 0.6);
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.stroke();
        if (s > 0.06) {
          ctx.font = '600 ' + fs2 + 'px system-ui, sans-serif';
          ctx.fillStyle = 'rgba(230,241,247,.9)';
          ctx.fillText(p.n || '', p.gx, p.gy - fs2 * 1.4);
        }
      }
    }

    // 自己
    var me = state.me;
    if (me && me.gx != null && opt.me && shOn('me', true)) {
      var a = ((me.brg == null ? 0 : me.brg) * Math.PI) / 180;
      var r = Math.max(9 / s, 4);
      ctx.save();
      ctx.translate(me.gx, me.gy);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.72, r * 0.78);
      ctx.lineTo(0, r * 0.36);
      ctx.lineTo(-r * 0.72, r * 0.78);
      ctx.closePath();
      ctx.fillStyle = '#8ef2b4';
      ctx.fill();
      ctx.lineWidth = Math.max(1.4 / s, 0.7);
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // 暗角
    var g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.32, cx, cy, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.42)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function loop() {
    var now = Date.now();
    // 断线超过 8 秒改提示（SSE 自己会重连）
    if (lastFrame && now - lastFrame > 8000) setStat('信号丢了…', 'off');
    if (dirty) { dirty = false; draw(); }
    requestAnimationFrame(loop);
  }

  /* ---------- 触控 ---------- */
  var pts = new Map();
  var drag = null;
  var pinch = null;

  function localPt(e) {
    var r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  cv.addEventListener('pointerdown', function (e) {
    cv.setPointerCapture(e.pointerId);
    var p = localPt(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      drag = { x: p.x, y: p.y, vx: vx, vy: vy, moved: 0 };
      lp = { id: e.pointerId, x: p.x, y: p.y, t: Date.now() };
    } else if (pts.size === 2) {
      lp = null;
      var it = Array.from(pts.values());
      var d = Math.hypot(it[0].x - it[1].x, it[0].y - it[1].y);
      var mx = (it[0].x + it[1].x) / 2, my = (it[0].y + it[1].y) / 2;
      pinch = { d: d || 1, s: vs, mx: mx, my: my, vx: vx, vy: vy };
      drag = null;
    }
  });

  cv.addEventListener('pointermove', function (e) {
    if (!pts.has(e.pointerId)) return;
    var p = localPt(e);
    pts.set(e.pointerId, p);

    if (pts.size >= 2 && pinch) {
      var it = Array.from(pts.values());
      var d = Math.hypot(it[0].x - it[1].x, it[0].y - it[1].y);
      var ns = clamp(pinch.s * (d / pinch.d), 0.02, 3);
      // 以双指中点为锚缩放
      var cx = W / 2, cy = H / 2;
      var wx = pinch.vx + (pinch.mx - cx) / pinch.s;
      var wy = pinch.vy + (pinch.my - cy) / pinch.s;
      vs = ns;
      vx = wx - (pinch.mx - cx) / ns;
      vy = wy - (pinch.my - cy) / ns;
      follow = false; opt.follow = false; $('oFollow').checked = false;
      dirty = true;
      return;
    }

    if (drag) {
      var dx = p.x - drag.x, dy = p.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = 1;
        follow = false; opt.follow = false; $('oFollow').checked = false;
      }
      vx = drag.vx - dx / vs;
      vy = drag.vy - dy / vs;
      dirty = true;
    }
  });

  function up(e) {
    var longHit = 0;
    if (lp && lp.id === e.pointerId) {
      var p = localPt(e);
      var dt = Date.now() - lp.t;
      var mv = Math.abs(p.x - lp.x) + Math.abs(p.y - lp.y);
      // 按够半秒、手指基本没挪 → 当成「长按这个标点」
      if (dt > 520 && mv < 12) {
        var hit = hitMark(p.x, p.y);
        if (hit) { longHit = 1; askDel(hit); }
      }
      lp = null;
    }
    if (longHit) suppressClick = 1;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) drag = null;
  }
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', function (e) { lp = null; up(e); });

  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = localPt(e);
    var cx = W / 2, cy = H / 2;
    var wx = vx + (p.x - cx) / vs;
    var wy = vy + (p.y - cy) / vs;
    vs = clamp(vs * (e.deltaY > 0 ? 0.9 : 1.1), 0.02, 3);
    vx = wx - (p.x - cx) / vs;
    vy = wy - (p.y - cy) / vs;
    dirty = true;
  }, { passive: false });

  /* ---------- 按钮 ---------- */
  function zoomBy(f) {
    vs = clamp(vs * f, 0.02, 3);
    dirty = true;
  }

  function fitAll() {
    var MAP = (state && state.map) || 10161;
    vs = Math.min(W, H) / MAP * 0.96;
    vx = MAP / 2; vy = MAP / 2;
    follow = false; opt.follow = false; $('oFollow').checked = false;
    dirty = true;
  }

  function goMe() {
    follow = true; opt.follow = true; $('oFollow').checked = true;
    if (state && state.me) { vx = state.me.gx; vy = state.me.gy; }
    if (vs < 0.05) vs = 0.14;
    dirty = true;
  }

  /* 第一百一十五批：标点列表。
     地图上点一多就找不着，列表按类型分组、组内按离自己远近排。
     点一条把视图挪过去 —— 顺手把「跟随自己」关掉，不然下一帧就被拽回原地 */
  function flyTo(gx, gy) {
    vx = gx; vy = gy;
    follow = false; opt.follow = false;
    if ($('oFollow')) $('oFollow').checked = false;
    if (vs < 0.1) vs = 0.22;
    dirty = true;
  }

  function renderList() {
    var box = $('plistBody');
    // mklist.js 没拿到（老缓存、加载失败）就当没这个功能，别把整个页面拖崩
    if (!box || typeof ML === 'undefined') return;
    box.innerHTML = '';
    var gs = ML.group((phMk && phMk.mk) || [], state && state.me);
    if (!gs.length) {
      var e = document.createElement('p');
      e.className = 'pempty';
      e.textContent = T('现在没有标点。电脑上加的、手机上打的都会出现在这里。');
      box.appendChild(e);
      return;
    }
    for (var g = 0; g < gs.length; g++) {
      var h = document.createElement('div');
      h.className = 'pgh';
      h.textContent = gs[g].label + ' · ' + gs[g].items.length;
      box.appendChild(h);
      for (var i = 0; i < gs[g].items.length; i++) {
        (function (it, idx) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'prow';
          var nm = document.createElement('span');
          nm.className = 'pn';
          nm.textContent = ML.titleOf(it, idx);
          var ds = document.createElement('span');
          ds.className = 'pd';
          ds.textContent = it.ds || '';
          b.appendChild(nm);
          b.appendChild(ds);
          b.onclick = function () {
            flyTo(it.gx, it.gy);
            if ($('plist')) $('plist').classList.add('hide');
            if ($('sheet')) $('sheet').classList.add('hide');
          };
          box.appendChild(b);
        })(gs[g].items[i], i);
      }
    }
  }

  $('zin').onclick = function () { zoomBy(1.35); };  $('zout').onclick = function () { zoomBy(1 / 1.35); };
  $('fit').onclick = fitAll;
  $('me').onclick = goMe;

  $('menu').onclick = function () { $('sheet').classList.remove('hide'); };
  $('closeSheet').onclick = function () { $('sheet').classList.add('hide'); };
  if ($('openList')) $('openList').onclick = function () { renderList(); $('plist').classList.remove('hide'); };
  if ($('closeList')) $('closeList').onclick = function () { $('plist').classList.add('hide'); };

  $('oPeer').onchange = function () { opt.peer = this.checked; saveOpt(); dirty = true; };
  $('oMark').onchange = function () { opt.mark = this.checked; saveOpt(); dirty = true; };
  $('oMe').onchange = function () { opt.me = this.checked; saveOpt(); dirty = true; };
  $('oBase').onchange = function () { opt.base = this.checked; saveOpt(); dirty = true; };
  $('oFollow').onchange = function () { opt.follow = this.checked; follow = this.checked; if (follow && state && state.me) { vx = state.me.gx; vy = state.me.gy; } dirty = true; };
  $('oWake').onchange = function () { opt.wake = this.checked; saveOpt(); if (this.checked) wakeOn(); else wakeOff(); };

  /* 第一百一十三批：连上之后改名，不用回电脑上踢了重配。
     只改「这台手机叫什么」，碰不到主人任何配置 —— 所以只读模式也放行 */
  $('dnameGo').onclick = function () {
    var n = ($('dname').value || '').replace(/\s+/g, ' ').trim();
    if (!n) { setStat('名字不能空着', 'off'); return; }
    api('/api/act?t=' + encodeURIComponent(token), { type: 'rename', n: n })
      .then(function (j) {
        if (j && j.ok) { try { localStorage.setItem(LS_N, n); } catch (e) {} }
        actDone(j, '名字改好了');
      });
  };

  $('quit').onclick = function () {
    try { localStorage.removeItem(LS_T); } catch (e) {}
    if (es) { try { es.close(); } catch (e) {} es = null; }
    // 第一百一十八批：跨网那条连接也要断，不然它在后台一直重连
    if (NET && window.PN) { try { window.PN.close(); } catch (e) {} }
    if (netPing) { clearInterval(netPing); netPing = null; }
    showPair(NET ? '已断开。想再连，把房间号和密码再填一次' : '已断开，想再连就回电脑上重新生成配对码');
  };

  // 打点：先点「打点」，在地图上点位置，再挑类型 —— 类型只在手机上选，
  // 电脑那边照旧按 type 上色，两边不用对一份表
  // 第一百一十五批：类型表挪到 mklist.js —— 列表分组也要用它，
  // 两张表放两处迟早对不上（漏一个类型，那类点就在列表里归错组）。
  // mklist.js 万一没加载上，退回只有「收藏」一类，至少还能打点
  var MK_PICK = (typeof ML !== 'undefined' && ML.TYPES)
    ? ML.TYPES : [['custom', '★ 收藏']];
  var markMode = 0;
  var pending = null;
  var pickType = 'custom';

  function buildPick() {
    var box = $('mklist');
    box.innerHTML = '';
    for (var i = 0; i < MK_PICK.length; i++) {
      (function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = T(it[1]);
        if (it[0] === pickType) b.className = 'on';
        b.onclick = function () { pickType = it[0]; buildPick(); };
        box.appendChild(b);
      })(MK_PICK[i]);
    }
  }

  function actDone(j, okMsg) {
    setStat(j && j.ok ? T(okMsg) : T('没成功：{why}', { why: (j && j.why) || '' }), j && j.ok ? 'on' : 'off');
    setTimeout(function () { if (state) setStat('已连接', 'on'); }, 1600);
  }

  /* 第一百一十三批：电脑那头最多推 300 个点（设置页能调）。
     以前超了就是悄悄截断，手机这边只看见三百个，还以为自己没打上。
     现在把「一共多少个」也推过来，超了就明说一句 */
  function capTip() {
    var el = $('mkCap');
    if (!el) return;
    var tot = (phMk && phMk.tot) || 0;
    var got = (phMk && phMk.mk) ? phMk.mk.length : 0;
    if (tot > got) {
      el.textContent = T('标点太多，这台手机只收到最近 {n} 个（一共 {m} 个）。想多看些，回电脑上把「手机标点上限」调大。',
        { n: got, m: tot });
      el.classList.remove('hide');
    } else {
      el.classList.add('hide');
    }
  }

  /* 第一百一十三批：打点成功后亮 5 秒的撤销。
     防的是「手一抖打歪了」—— 走的是删点那条权限，主进程还会再核一遍
     「是不是你刚打的、是不是 5 秒内」，手机上按不按得动不算数 */
  var undoMark = null;
  var undoTimer = 0;

  function showUndo(id) {
    if (!pm('del')) return;
    undoMark = { id: id };
    $('undo').classList.remove('hide');
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 5000);
  }

  function hideUndo() {
    undoMark = null;
    $('undo').classList.add('hide');
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = 0; }
  }

  $('undo').onclick = function () {
    if (!undoMark) return;
    var id = undoMark.id;
    hideUndo();
    api('/api/act?t=' + encodeURIComponent(token), { type: 'undo', id: id })
      .then(function (j) { actDone(j, '已撤销'); });
  };

  $('mark').onclick = function () {
    if (!state) return;
    if (!pm('mark')) { setStat('电脑上设成了只读', 'off'); return; }
    markMode = markMode ? 0 : 1;
    $('mark').textContent = T(markMode ? '⚑ 点地图' : '⚑ 打点');
    if (markMode) setStat('点地图选位置', '');
  };

  $('mkoff').onclick = function () {
    $('mkbar').classList.add('hide');
    pending = null;
  };

  $('mkok').onclick = function () {
    if (!pending) return;
    var pt = pending;
    pending = null;
    $('mkbar').classList.add('hide');
    api('/api/act?t=' + encodeURIComponent(token), {
      type: 'mark', gx: pt.gx, gy: pt.gy, mk: pickType
    }).then(function (j) {
      actDone(j, '打点成功');
      if (j && j.ok && j.id) showUndo(j.id);
    });
  };

  // 长按标点 → 删掉。手机屏幕小，标点常常叠在一起，
  // 所以按屏幕距离找最近的那个，不是按坐标精确命中
  var suppressClick = 0;
  var lp = null;

  function hitMark(x, y) {
    if (!state || !state.mk || !state.mk.length) return null;
    var best = null, bd = 1e9;
    for (var i = 0; i < state.mk.length; i++) {
      var m = state.mk[i];
      if (m.gx == null) continue;
      var sx = (m.gx - vx) * vs + W / 2;
      var sy = (m.gy - vy) * vs + H / 2;
      var d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = m; }
    }
    return bd <= 28 ? best : null;
  }

  function askDel(m) {
    if (!pm('del')) { setStat('电脑上没给删的权限', 'off'); return; }
    if (!window.confirm(T('删掉标点「{name}」？', { name: m.n || T('未命名') }))) return;
    api('/api/act?t=' + encodeURIComponent(token), { type: 'del', id: m.i })
      .then(function (j) { actDone(j, '已删掉'); });
  }

  cv.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = 0; return; }
    if (!markMode || !state) return;
    var p = localPt(e);
    var gx = vx + (p.x - W / 2) / vs;
    var gy = vy + (p.y - H / 2) / vs;
    markMode = 0;
    $('mark').textContent = T('⚑ 打点');
    pending = { gx: Math.round(gx), gy: Math.round(gy) };
    if (state.mt) pickType = state.mt;
    buildPick();
    $('mkbar').classList.remove('hide');
  });

  /* ---------- 常亮 ---------- */
  var wakeLock = null;
  function wakeOn() {
    if (!opt.wake) return;
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  function wakeOff() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    var vis = document.visibilityState === 'visible';
    if (vis) {
      wakeOn();
      // iOS 切回来 SSE 经常已经死了，重连一下
      if (token && (!es || es.readyState === 2)) connect();
    } else {
      wakeOff();
    }
    // 第一百一十四批：告诉电脑「我切走了，别推了」。手机放兜里、切到别的 App 时
    // SSE 还在每秒推几十帧，全是白费电。切回来时服务端会补一份全量（先帧后标点），
    // 所以不用等下一次变化画面才是新的
    if (token) {
      api('/api/act?t=' + encodeURIComponent(token), { type: 'seen', v: vis }).catch(function () {});
    }
  });

  /* ---------- 选项存取 ---------- */
  function loadOpt() {
    try {
      var o = JSON.parse(localStorage.getItem(LS_O) || '{}');
      ['peer', 'mark', 'base', 'me', 'wake', 'follow'].forEach(function (k) {
        if (typeof o[k] === 'boolean') opt[k] = o[k];
      });
    } catch (e) {}
    $('oPeer').checked = opt.peer;
    $('oMark').checked = opt.mark;
    $('oMe').checked = opt.me;
    $('oBase').checked = opt.base;
    $('oWake').checked = opt.wake;
    $('oFollow').checked = opt.follow;
    follow = opt.follow;
  }
  function saveOpt() {
    try { localStorage.setItem(LS_O, JSON.stringify(opt)); } catch (e) {}
  }

  /* ---------- 启动 ---------- */
  window.addEventListener('resize', function () { resize(); });
  window.addEventListener('orientationchange', function () { setTimeout(resize, 260); });

  $('go').onclick = doPair;
  $('code').addEventListener('input', function () {
    this.value = (this.value || '').replace(/\D/g, '').slice(0, 6);
  });
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair(); });

  loadOpt();
  pairMode();
  try {
    var n0 = localStorage.getItem(LS_N);
    if (n0) { $('name').value = n0; $('dname').value = n0; }
  } catch (e) {}

  // 第一百一十八批：跨网 ↔ 局域网切换。切过去把另一套输入框藏起来，
  // 免得人在外面还盯着一个 6 位码的框发愁
  if ($('switchMode')) {
    $('switchMode').onclick = function (e) {
      e.preventDefault();
      NET = !NET;
      try {
        if (NET) localStorage.setItem(LS_X, '1'); else localStorage.removeItem(LS_X);
      } catch (x) {}
      if (window.PN && !NET) { try { window.PN.close(); } catch (x) {} }
      if (netPing) { clearInterval(netPing); netPing = null; }
      pairMode();
      showPair('');
    };
  }
  if ($('nroom')) $('nroom').addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair(); });
  if ($('npass')) $('npass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doPair(); });

  if (NET) {
    // 跨网：存着房间号和密码就自动重连，没存就回配对页填
    var rr = null;
    try { rr = JSON.parse(localStorage.getItem(LS_R) || 'null'); } catch (e) {}
    if (rr && rr.room && rr.pass && window.PN) {
      $('nroom').value = rr.room;
      $('npass').value = rr.pass;
      $('go').disabled = true;
      var dv = '';
      try { dv = localStorage.getItem(LS_D) || ''; } catch (e) {}
      window.PN.init({ room: rr.room, pass: rr.pass, devId: dv }).then(function (x) {
        if (!x.ok) { $('go').disabled = false; showPair(''); return null; }
        try { localStorage.setItem(LS_D, window.PN.devId()); } catch (e) {}
        return window.PN.req('/api/ping', null).then(function (j) {
          $('go').disabled = false;
          if (j && j.ok) { token = 'net'; enter(); }
          else showPair('');
        });
      });
    } else {
      showPair('');
    }
  } else {
    token = '';
    try { token = localStorage.getItem(LS_T) || ''; } catch (e) {}
    if (token) {
      // 有旧令牌先试着用，失效会自动回配对页
      api('/api/ping?t=' + encodeURIComponent(token), null).then(function (j) {
        if (j.auth) enter();
        else { try { localStorage.removeItem(LS_T); } catch (e) {} showPair(''); }
      }).catch(function () { showPair('连不上电脑，检查是否同一个 WiFi'); });
    } else {
      showPair('');
    }
  }

  requestAnimationFrame(loop);
})();

// 第一百零八批：能离线就离线。局域网 http 下浏览器不给注册 Service Worker
// （非安全上下文），静默跳过 —— 这是规矩，不是出错。真挂上 https
// （Tailscale Serve 或者自己的反代）之后，这里才真的接管离线缓存
// 第一百一十八批：跨网页面走的是公网 https，但没部署 sw.js（不缓存中转页面，
// 免得旧版本一直赖在手机里），所以这条只留给局域网
if (!NET && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}
