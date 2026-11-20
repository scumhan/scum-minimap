/* 第一百二十二批：手机端「房间号 + 密码」粘贴解析
 *
 * 电脑上点一次「🔑 复制房间号和密码」，剪贴板里是一行：
 *     home-8f3k 9kQm2xVt7Lp4
 * 手机上长按粘一次，得把这一串拆回两个框。
 *
 * 单独成文件是为了能单测：phone.js 是个大 IIFE，抓不出来。
 * 纯函数，不碰 DOM，不认语言 —— 中文提示全在 phone.js 里。
 *
 * 解析顺序（宁可少拆，不可拆错）：
 *   1. 两行、每行一个值、行内没空白 → 第一行房间号、第二行密码
 *      （密码自己带空格时，电脑端会用换行分隔）
 *   2. 把「标签 + 冒号/等号」换成空格：房间号：x / room=x&pass=y
 *   3. 按 空白 / 逗号 / 分号 / 斜杠 / 竖线 拆段
 *   4. 某一段整段就是「房间号 / room / 密码 / pass」，取下一段
 *   5. 剩两段就是房间号 + 密码；只剩一段时按「从哪个框粘的」决定填哪格
 *
 * 故意不拿 & 和 + 当通用分隔符：密码里可能出现，拆错比不拆更糟。
 */
(function (root) {
  'use strict';

  var ROOM_MAX = 24;
  var PASS_MAX = 64;

  var RE_ROOM_LABEL = /^(房间号|房间|房号|room)$/i;
  var RE_PASS_LABEL = /^(密码|pass|password)$/i;

  // 全角标点先归一，后面只认半角
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/：/g, ':')
      .replace(/[，、]/g, ',')
      .replace(/；/g, ';')
      .replace(/\u3000/g, ' ')
      .trim();
  }

  function done(room, pass, from) {
    room = String(room || '').trim();
    pass = String(pass || '').trim();
    // 只有一段时按来源框定去向：从密码框粘的就当密码，别硬塞进房间号
    if (room && !pass && from === 'pass') { pass = room; room = ''; }
    if (room.length > ROOM_MAX || pass.length > PASS_MAX) return { ok: false, why: 'toolong' };
    if (room && pass) return { ok: true, room: room, pass: pass, filled: 'both' };
    if (room) return { ok: true, room: room, pass: '', filled: 'room' };
    if (pass) return { ok: true, room: '', pass: pass, filled: 'pass' };
    return { ok: false, why: 'empty' };
  }

  function parse(text, from) {
    var raw = norm(text);
    if (!raw) return { ok: false, why: 'empty' };

    // 1) 两行模式：第一行是房间号（不许带空格），第二行整行当密码 ——
    //    密码自己带空格时只能这么分，所以第二行不再按空白拆
    var lines = raw.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    if (lines.length === 2 && !/\s/.test(lines[0])) {
      var r2 = lines[0].replace(/^(?:房间号|房间|房号|room)\s*[:=]?\s*/i, '');
      var p2 = lines[1].replace(/^(?:密码|pass(?:word)?)\s*[:=]?\s*/i, '');
      return done(r2, p2, from);
    }

    // 2) 标签统一换成分隔：只认「标签 + 冒号/等号」，不然密码里的 pass 字样会被切断
    var s = raw
      .replace(/(^|[\s,;/|&+]+)(?:房间号|房间|房号|room)\s*[:=]\s*/gi, ' ')
      .replace(/(^|[\s,;/|&+]+)(?:密码|pass(?:word)?)\s*[:=]\s*/gi, ' ');

    // 3) 拆段。& 和 + 不参与通用拆分（见文件头）
    var segs = s.split(/[\s,;/|]+/).filter(Boolean);

    // 4) 段级兜底：整段是标签词就吃下一段
    var room = '', pass = '';
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      if (!room && RE_ROOM_LABEL.test(g) && i + 1 < segs.length) { room = segs[++i]; continue; }
      if (!pass && RE_PASS_LABEL.test(g) && i + 1 < segs.length) { pass = segs[++i]; continue; }
      if (!room) { room = g; continue; }
      if (!pass) { pass = g; continue; }
      // 多余段直接忽略：多半是「房间号：x 密码：y」后面跟了一句说明
    }

    return done(room, pass, from);
  }

  var API = { parse: parse, ROOM_MAX: ROOM_MAX, PASS_MAX: PASS_MAX };
  if (typeof module === 'object' && module.exports) module.exports = API;
  root.PP = API;
})(typeof window !== 'undefined' ? window : globalThis);
