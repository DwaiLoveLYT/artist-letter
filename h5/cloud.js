// ==================== 订单同步服务（自建后端）====================
//
// 客户页和后台都是纯静态页 —— 数据各自住在自己那台设备的 localStorage 里。
// 所以「客户在自己手机上下的单，我这边看不到」不是 bug，是静态页之间**做不到**：
// localStorage 按「设备 + 浏览器 + 域名」隔离，换台设备就是另一个空存储。
//
// 这个后端只做一件事：给订单一个所有设备都能读到的落脚点。
// 地址只在这里写一次，客户页和后台共用。
//
// 留空 = 未启用同步，两个页面完全按原来的本地模式跑（不报错、不卡住、不改变任何行为）。

// 线上订单同步服务（自建，2026-10-04 上线）。
// 实测从深圳访问：DNS 0.004s / 连接 0.007s / 总计 0.28s，解析到腾讯云。
//
// ⚠ 这个地址是**发布时生成**的：每次重新发布同一个应用，分享链接都会变。
// 已实测连续三次：83cf23c6… → 25dafc60… → 45c34785… → 6eaa80f7…
// （旧地址直接返回一张营销页）。所以**每次重新发布之后，必须把新地址更新到这里
// 并重推一次 GitHub Pages**，否则线上客户页会连到一个死地址 ——
// 而本地测试完全发现不了这件事（本地是用 localStorage 覆盖这个常量的，走不到这里）。
var CLOUD_BASE = 'https://6eaa80f7f9324c7886263dc703ceb860.sg2.agentos-app.run'

// 逃生口：换后端地址时不用重新发版（调试、迁移都用得上）
try {
  var _ov = localStorage.getItem('artist_letter_cloud_base')
  if(_ov !== null) CLOUD_BASE = _ov
} catch(e){}

// —— 连接预热 ——
// 第一次连到这个域名要建 DNS + TCP + TLS。实测在浏览器里这一步能到 5 秒以上
// （同一台机器用 curl 直连只要 0.38 秒，所以这不是网络的问题，是浏览器首次建连的开销）。
// 客户填表要几十秒、后台输密码也要几秒 —— 这段时间足够把连接建好。
// 所以一进页面就悄悄连一下：等真正要下单/同步时，连接已经是热的（实测 0.2~0.4 秒）。
function warmUp(){
  if(!CLOUD_BASE) return
  try {
    var d = document.createElement('link')
    d.rel = 'dns-prefetch'; d.href = CLOUD_BASE
    document.head.appendChild(d)
    var l = document.createElement('link')
    l.rel = 'preconnect'; l.href = CLOUD_BASE; l.crossOrigin = ''
    document.head.appendChild(l)
  } catch(e){}
  // health 是公开接口：不限流、不落盘、不返回任何订单数据。失败也无所谓。
  try { fetch(CLOUD_BASE + '/api/health', { cache: 'no-store' }).catch(function(){}) } catch(e){}
}
if(document.head) warmUp()
else document.addEventListener('DOMContentLoaded', warmUp)

var Cloud = {
  on: function(){ return !!CLOUD_BASE },

  // —— 客户页：把订单送到服务端 ——
  // 失败**绝不能**影响下单流程：页面上的「发给客服（一键分享）」仍是兜底通道。
  pushOrder: function(order){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return fetch(CLOUD_BASE + '/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_no: order.order_no, artist: order.artist, country: order.country,
        recipient_addr: order.recipient_addr, addr_lookup: order.addr_lookup,
        customer_name: order.customer_name, customer_phone: order.customer_phone,
        return_addr: order.return_addr, letter_source: order.letter_source,
        letter_note: order.letter_note, created_at: order.created_at,
      }),
    }).then(function(r){ return r.json().catch(function(){ return {} }) })
      .catch(function(){ return { ok:false, net:true } })
  },

  // —— 后台：拉取台账 ——
  pull: function(key){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return fetch(CLOUD_BASE + '/api/ledger', { headers: { 'X-Admin-Key': key } })
      .then(function(r){ return r.json().catch(function(){ return {} }) })
      .catch(function(){ return { ok:false, net:true } })
  },

  // —— 后台：回推台账（服务端会再合并一次，别处没见过的新单不会被覆盖）——
  push: function(key, orders, deleted){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return fetch(CLOUD_BASE + '/api/ledger', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ orders: orders, deleted: deleted || [] }),
    }).then(function(r){ return r.json().catch(function(){ return {} }) })
      .catch(function(){ return { ok:false, net:true } })
  },
}
