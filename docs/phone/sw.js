'use strict';
// 手机端的离线壳。只在「安全上下文」里能注册 —— 也就是 https 或者本机地址。
// 局域网 http://192.168.x.x 这种浏览器根本不给注册，所以它是加分项，不是必需品：
// 注册失败就当没有，页面照常用。真正需要离线的人，一般是拿 Tailscale 或反代
// 挂了个 https 上来，那时候这里就管用了。
//
// 缓存策略分两类，别搞混：
//   /api/*  一律走网络，绝不缓存 —— 状态流、动作、ping 缓存了就是骗人
//   其余 GET 网络优先，断网回缓存，缓存也没有就给一张离线页

// 第一百一十五批加了 mklist.js，缓存名升到 v2 —— 不升的话老用户手机上
// 还是旧的壳，phone.js 找不到 ML 整个页面就崩了。
// 第一百一十七批加了 pi18n.js，同理升到 v3。
// 第一百一十九批加了 net.js（跨网），升到 v4
// 第一百二十二批加了 pairparse.js（粘贴拆房间号密码），升到 v5
const CACHE = 'smm-phone-v5';

// 壳文件：少一样页面就白屏，必须拿到
const SHELL = [
  '/',
  '/phone/phone.css',
  '/phone/pi18n.js',
  '/phone/mklist.js',
  '/phone/pairparse.js',
  '/phone/net.js',
  '/phone/phone.js',
  '/phone/manifest.json',
  '/phone/icon-192.png',
  '/phone/icon-512.png',
  '/qrcode.js'
];

// 大件：底图二十来兆，装不上也不能把整个安装拖死
const OPTIONAL = ['/map.webp'];

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    const c = await caches.open(CACHE);
    // 逐个塞，一个失败不影响别的。addAll 是全有全无，底图一超时就全废
    await Promise.all(SHELL.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
    await Promise.all(OPTIONAL.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

function offlinePage() {
  const html = '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>离线</title>' +
    '<body style="margin:0;background:#0b1014;color:#9fb3c8;font:16px/1.7 system-ui,sans-serif;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px">' +
    '<div><div style="font-size:40px;margin-bottom:12px">📡</div>' +
    '<div style="color:#e6eef6;font-size:18px;margin-bottom:8px">现在连不上电脑</div>' +
    '<div>手机和电脑要能互相找到才行。<br>回到同一个 WiFi，把虚拟局域网打开，<br>或者在电脑上开「跨网中继」，再刷新一次。</div></div></body>';
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;
  // 状态流和动作接口不碰，碰了就是拿旧数据糊人
  if (u.pathname.indexOf('/api/') === 0) return;

  e.respondWith((async function () {
    try {
      const res = await fetch(req);
      // 只缓存正常的静态资源。404 / 500 也照实回给页面，别拿缓存顶
      if (res && res.ok && res.status === 200) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone()).catch(function () {});
      }
      return res;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // 导航请求没缓存：至少给张说得清楚的离线页，不是浏览器的恐龙
      if (req.mode === 'navigate') {
        const shell = await c.match('/');
        return shell || offlinePage();
      }
      return offlinePage();
    }
  })());
});
