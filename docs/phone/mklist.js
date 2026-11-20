// 手机上「标点列表」的分组与排序（纯函数，不碰 DOM）。
//
// 手机屏幕小，八百个点摊在地图上就是一片糊 —— 但人想找的往往是
// 「我上次打的那个家」「队友标的危险」，靠拖地图翻不出来。
// 所以给一份列表：按类型分组，组内按离自己远近排，点一条飞过去。
//
// 这里只算「怎么分组、怎么排、每条显示什么」。渲染在 phone.js。
// 标点类型表也只在这里一份 —— phone.js 打点时挑类型用的就是它，
// 跟电脑端 renderer/config.js 的类型对得上，认不出的归 custom。
(function (root) {
  'use strict';

  var TYPES = [
    ['custom', '★ 收藏'],
    ['danger', '💀 危险'],
    ['loot', '📦 物资'],
    ['vehicle', '⚑ 载具'],
    ['base', '🏠 据点'],
    ['home', '⌂ 家'],
    ['med', '🏥 医疗'],
    ['target', '🎯 目标']
  ];

  var LABEL = {};
  for (var i = 0; i < TYPES.length; i++) LABEL[TYPES[i][0]] = TYPES[i][1];

  // 类型名要跟着手机页语言走。没加载 pi18n 时原样返回，纯函数照旧能测
  function tr(s) { return (typeof root.T === 'function') ? root.T(s) : s; }

  function labelOf(t) {
    return tr(LABEL[t] || LABEL.custom);
  }

  // 游戏坐标是厘米，人看的是米。取不到返回 null，不返回 0 ——
  // 0 米会被读成「就在脚下」，那是错的
  function distM(m, me) {
    if (!m || !me) return null;
    var dx = Number(m.gx) - Number(me.gx);
    var dy = Number(m.gy) - Number(me.gy);
    if (!isFinite(dx) || !isFinite(dy)) return null;
    return Math.sqrt(dx * dx + dy * dy) / 100;
  }

  function fmtDist(d) {
    if (d === null || d === undefined || !isFinite(d)) return '';
    if (d < 1000) return Math.round(d) + ' m';
    return (d / 1000).toFixed(1) + ' km';
  }

  // 分组：按 TYPES 的顺序出，空组不出现；组内按距离从近到远，
  // 取不到距离的排最后（按名字），免得一屏全是空距离
  function group(mk, me) {
    var arr = Array.isArray(mk) ? mk : [];
    var buckets = {};
    for (var i = 0; i < TYPES.length; i++) buckets[TYPES[i][0]] = [];

    for (var j = 0; j < arr.length; j++) {
      var m = arr[j];
      if (!m) continue;
      // null / '' / undefined 经 Number() 都变成 0 —— 那会被当成「就在地图原点」，
      // 跟「不知道坐标」完全是两回事，所以先单独挡掉
      if (m.gx === null || m.gy === null || m.gx === '' || m.gy === '') continue;
      if (m.gx === undefined || m.gy === undefined) continue;
      var gx = Number(m.gx), gy = Number(m.gy);
      if (!isFinite(gx) || !isFinite(gy)) continue;
      var t = LABEL[m.t] ? m.t : 'custom';
      var d = distM(m, me);
      buckets[t].push({
        i: m.i, n: String(m.n || ''), gx: gx, gy: gy, t: t, d: d, ds: fmtDist(d)
      });
    }

    var out = [];
    for (var k = 0; k < TYPES.length; k++) {
      var key = TYPES[k][0];
      var list = buckets[key];
      if (!list.length) continue;
      list.sort(function (a, b) {
        if (a.d === null && b.d === null) {
          // 都不知道远近时，有名字的排前面 —— 找东西靠的是名字，空白条帮不上忙
          var an = String(a.n).trim(), bn = String(b.n).trim();
          if (!an && bn) return 1;
          if (an && !bn) return -1;
          return an.localeCompare(bn);
        }
        if (a.d === null) return 1;
        if (b.d === null) return -1;
        return a.d - b.d;
      });
      out.push({ t: key, label: tr(TYPES[k][1]), items: list });
    }
    return out;
  }

  // 一条显示成什么：有名字用名字，没名字用「类型名 + 组内序号」
  function titleOf(item, idx) {
    var n = String((item && item.n) || '').trim();
    if (n) return n;
    return labelOf(item && item.t) + ' ' + ((Number(idx) || 0) + 1);
  }

  var ML = {
    TYPES: TYPES, labelOf: labelOf, distM: distM, fmtDist: fmtDist,
    group: group, titleOf: titleOf
  };
  if (typeof module === 'object' && module.exports) module.exports = ML;
  root.ML = ML;
})(typeof window !== 'undefined' ? window : globalThis);
