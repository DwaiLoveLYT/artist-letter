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
// 已实测连续八次：83cf23c6… → 25dafc60… → 45c34785… → 6eaa80f7… → a3117d63… → 8f1cf1e0… → ae1556c6… → ded7b397… → 9cd100e7…
// （旧地址直接返回一张营销页）。
//
// ★ 好消息：现在已经**不需要手工改这里**了。后端会把自己当前的地址
//   自动写进公开仓库的 endpoint.json（见 letter-api/_addrpub.js），
//   页面发现下面这个常量连不通时，会自己去读那份、并换过去。
//   所以这一行只是「第一顺位」，不是唯一依靠 —— 忘了更新它也不会让客户下单失败。
var CLOUD_BASE_DEFAULT = 'https://5351862426444c33b375fb43d7b0cd63.sg2.agentos-app.run'
var CLOUD_BASE = CLOUD_BASE_DEFAULT

// —— 逃生口：换后端地址时不用重新发版（调试、迁移都用得上）——
//
// 三种取值，语义必须分清楚：
//   ① 没设过这个 key         → 用内置默认地址
//   ② 设成**空字符串**        → **显式关闭同步**（页面退回纯本地模式）
//                             这不是「地址坏了」，是故意的，自愈绝不能把它「修好」
//   ③ 设成一个 URL            → 用它，但要能被自愈（见下）
//
// ⚠⚠ ③ 必须是**会自愈**的，否则它就是一个永久陷阱：
// 覆盖值存在 localStorage 里，一旦被写进一个死地址（而地址每次重新发布都会变），
// 它会**永久生效** —— 这台设备从此连不上服务器，界面上看起来就是「订单没进来」，
// 而且刷新、清缓存都不一定想得起来要清这一个 key。
//
// 所以：先把覆盖值用起来（保证迁移时的即时可用），
// 同时后台探测一次 —— 覆盖值死了、内置地址活着，就立刻自愈并通知页面。
var _ovBase = null
try { _ovBase = localStorage.getItem('artist_letter_cloud_base') } catch(e){}
if(_ovBase !== null) CLOUD_BASE = _ovBase

var _healedFrom = ''

// —— 地址自动修复：后端换了地址，这里自己找回来 ——
//
// 为什么必须有这一段（这是「后端重新部署就出故障」的根治）：
// 每次重新部署后端，平台都会给一个**全新域名**，上面那个内置常量就作废了。
// 老做法是「部署完，手工改这个常量，再推一次 GitHub Pages，再等 CDN」——
// 一串手工步骤，任何一步漏了或忘了等 CDN，线上就是这样：
//   客户点提交 → 连到一个死地址 → 单子送不到。
//
// 现在改了：后端会**自己**把当前地址写进公开仓库（DwaiLoveLYT/artist-letter）的
// endpoint.json 里（见 letter-api/_addrpub.js）。那个仓库是公开的，
// 所以这里不需要任何密钥就能读。
//
// 于是修复链路全自动：
//   内置地址死了 → 去公开仓库读当前地址 → 探一下确实是我们自己的服务 → 换过去
// 客户和老板都不需要做任何事，也不会看到「同步失败」。
//
// ⚠ 顺序很重要：只在**当前地址确实不通**时才去读。
// 不能每次都读 —— 那是额外的网络往返，而且会让「用哪个地址」变得不可预测。
var ADDR_DISCOVERY_URL = 'https://raw.githubusercontent.com/DwaiLoveLYT/artist-letter/main/endpoint.json'

// 读公开仓库里那份「当前地址」。返回 Promise<string|''>。
//
// 注意加 cache-busting 参数：raw.githubusercontent 有 CDN 缓存，
// 不加的话刚发布的地址可能要等几分钟才读到 —— 而那几分钟正是最需要它的时候。
function fetchPublishedAddr(){
  var url = ADDR_DISCOVERY_URL + '?t=' + Date.now()
  var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
  var timer = setTimeout(function(){ if(ctl) ctl.abort() }, 8000)
  return fetch(url, { cache:'no-store', signal: ctl ? ctl.signal : undefined })
    .then(function(r){
      if(!r.ok) return ''
      return r.json().catch(function(){ return null }).then(function(j){
        // 必须是我们自己的服务发的，且地址格式对 ——
        // 这个文件是公开可读的，万一被谁改了内容，也不能让页面把单子发到别人的服务器去。
        if(!j || j.service !== 'artist-letter-api') return ''
        var api = String(j.api || '')
        if(!/^https:\/\/[0-9a-f]{32}\.sg2\.agentos-app\.run$/.test(api)) return ''
        return api
      })
    })
    .catch(function(){ return '' })
    .then(function(v){ clearTimeout(timer); return v })
}

// 当**当前生效的地址**（不分来源）连不通时，尝试用公开仓库里那份把它换掉。
// 返回 Promise<boolean>：true = 换成功了。
function tryDiscoverAndHeal(){
  return fetchPublishedAddr().then(function(found){
    if(!found) return false
    if(found === CLOUD_BASE) return false           // 就是现在这个，没得换
    return probeBase(found).then(function(ok){
      if(!ok) return false                          // 找到了但连不通 —— 不当它是解药
      _healedFrom = CLOUD_BASE
      CLOUD_BASE = found
      // 顺手把 localStorage 里那个（可能是死的）覆盖值也更新掉 ——
      // 不更新的话下次打开又要走一遍这个流程，而且旧覆盖值会一直「赢」过内置常量。
      try { localStorage.setItem('artist_letter_cloud_base', found) } catch(e){}
      if(qSize()) setTimeout(autoFlush, 0)
      try {
        window.dispatchEvent(new CustomEvent('cloud-base-healed', {
          detail: { from: _healedFrom, to: found, via: 'published' },
        }))
      } catch(e){}
      if(typeof window.__onCloudBaseHealed === 'function'){
        try { window.__onCloudBaseHealed({ from: _healedFrom, to: found, via: 'published' }) } catch(e){}
      }
      return true
    })
  })
}

// 探测一个地址到底是不是「我们自己的服务」。
//
// ⚠ 不能只看 HTTP 200 就下结论。
// 实测（2026-10-04）：作废地址对 /api/health 回的是 **HTTP 400 + 一张 Cloud Studio 营销页**
// —— 所以「只看状态码」在当下是够用的。
// 但状态码是**别人的服务器**说了算，不是我们能控制的：只要哪天它改成回 200 或加个跳转，
// 只看状态码的探测就会把一个完全不是我们服务的页面判成「活着」，
// 于是自愈永远不触发，这台设备就永久卡在死地址上 —— 而这正是最难查的那种故障。
//
// 所以必须验内容：/api/health 要真的回 { ok:true, service:'artist-letter-api' } 才算活。
// 顺带这个探测也验了 CORS —— 跨域被拒的地址对页面来说同样不可用，
// 而 fetch 拿不到 CORS 头时会直接抛错，这里会落到 catch 变成 false，正好。
function probeBase(url){
  if(!url) return Promise.resolve(false)
  var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
  var timer = setTimeout(function(){ if(ctl) ctl.abort() }, 8000)
  return fetch(url + '/api/health', { cache:'no-store', signal: ctl ? ctl.signal : undefined })
    .then(function(r){
      if(!r.ok) return false
      return r.json().catch(function(){ return null }).then(function(j){
        return !!(j && j.ok === true && j.service === 'artist-letter-api')
      })
    })
    .catch(function(){ return false })
    .then(function(ok){ clearTimeout(timer); return ok })
}

function healBase(){
  if(_ovBase === '') return                      // 显式关闭同步 —— 故意的，别去「修好」它
  // 分两种情形，**都要修**：
  //   ① 用户设过覆盖值，且那个值死了 → 优先回到内置地址
  //   ② 没设覆盖值（或覆盖值也没救），当前地址本身死了 → 去公开仓库问当前地址
  // 情形 ② 以前是漏掉的：旧版只在「设过覆盖值」时才自愈，
  // 所以「后端重新部署导致内置地址作废」这种情况**根本不会自愈** ——
  // 而它恰恰是最常发生的那种（每次部署都会）。
  probeBase(CLOUD_BASE).then(function(alive){
    if(alive) return Promise.resolve(true)      // 当前这个还活着，什么都不用做

    // ① 先试内置地址（只在用户设过覆盖值时才有意义）
    if(_ovBase !== null && CLOUD_BASE !== CLOUD_BASE_DEFAULT){
      return probeBase(CLOUD_BASE_DEFAULT).then(function(ok){
        if(!ok) return false                     // 内置的也死了，往下走 ②
        _healedFrom = CLOUD_BASE
        try { localStorage.removeItem('artist_letter_cloud_base') } catch(e){}
        CLOUD_BASE = CLOUD_BASE_DEFAULT
        if(qSize()) setTimeout(autoFlush, 0)
        var detail = { from: _healedFrom, to: CLOUD_BASE_DEFAULT, via: 'default' }
        try { window.dispatchEvent(new CustomEvent('cloud-base-healed', { detail: detail })) } catch(e){}
        if(typeof window.__onCloudBaseHealed === 'function'){
          try { window.__onCloudBaseHealed(detail) } catch(e){}
        }
        return true
      })
    }
    return false
  }).then(function(fixed){
    if(fixed) return                             // 上面已经修好了
    // ② 去公开仓库问「现在的地址是什么」。
    // 这是最后一道自愈，也是「后端重新部署」这条路的根治。
    return tryDiscoverAndHeal()
  })
}

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
healBase()

// ==================== 待推队列 ====================
//
// 为什么必须有：客户点了下单、页面显示「订单号 XXX」，但那一刻网络刚好不通，
// 这一次 POST 就没了 —— 页面不会重试，客户也不会再发一遍（他以为已经送到了）。
// 这一单在服务端**永远不会出现**，后台当然看不到。
//
// 所以失败的推送必须落进一个持久队列，之后每次打开页面、每次回到前台都补推一次。
// 队列存在 localStorage：和订单本身同一块存储，一起清、一起在。
var PUSH_Q = 'artist_letter_push_queue_v1'

function qRead(){
  try { var a = JSON.parse(localStorage.getItem(PUSH_Q)); return Array.isArray(a) ? a : [] } catch(e){ return [] }
}
function qWrite(a){
  try {
    if(a && a.length) localStorage.setItem(PUSH_Q, JSON.stringify(a.slice(-80)))
    else localStorage.removeItem(PUSH_Q)
    return true
  } catch(e){ return false }
}
function qHas(no){ return qRead().some(function(o){ return o && o.order_no === no }) }
function qAdd(order){
  if(!order || !order.order_no) return false
  var a = qRead().filter(function(o){ return o && o.order_no !== order.order_no })
  a.push(order)
  return qWrite(a) && qHas(order.order_no)
}
function qDrop(no){ qWrite(qRead().filter(function(o){ return o && o.order_no !== no })) }
function qSize(){ return qRead().length }

function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms) }) }

var Cloud = {
  on: function(){ return !!CLOUD_BASE },
  base: function(){ return CLOUD_BASE },
  defaultBase: function(){ return CLOUD_BASE_DEFAULT },
  isOverridden: function(){ return !!(CLOUD_BASE && CLOUD_BASE !== CLOUD_BASE_DEFAULT) },
  healedFrom: function(){ return _healedFrom },
  pending: qSize,
  hasPending: qHas,
  // 按单号把一条从待推队列里摘掉。
  // 客户页「清理这台设备的订单记录」要用它 —— 只清列表不清队列的话，
  // 下次打开页面队列会把那单重新推上去，变成「服务端有、本机没有」。
  dropQueued: qDrop,

  // —— 客户页：把订单送到服务端 ——
  // 失败**绝不能**影响下单流程：页面上的「发给客服（一键分享）」仍是兜底通道。
  //
  // 注意 body 里**不带 id**：id 是那台设备本地的随机串，服务端和后台都不用，
  // 传上去只会在合并时制造无意义的差异。
  _post: function(order){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    // 微信上遇到半断开的网络时 fetch 可能一直挂着；有限超时后让队列补推，
    // 页面才能明确给出「还没送达」，而不是永远显示「正在送达」。
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
    var timer = ctl ? setTimeout(function(){ ctl.abort() }, 18000) : null
    return fetch(CLOUD_BASE + '/api/order', {
      method: 'POST', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_no: order.order_no, artist: order.artist, country: order.country,
        recipient_addr: order.recipient_addr, addr_lookup: order.addr_lookup,
        customer_name: order.customer_name, customer_phone: order.customer_phone,
        return_addr: order.return_addr, letter_source: order.letter_source,
        letter_note: order.letter_note, created_at: order.created_at,
      }),
    }).then(function(r){
      return r.json().catch(function(){ return {} }).then(function(j){
        j.status = r.status
        return j
      })
    }).catch(function(){ return { ok:false, net:true } })
      .then(function(r){ if(timer) clearTimeout(timer); return r })
  },

  // 带重试的推送。3 次、退避 0.6s / 1.6s —— 手机信号抖一下就过去的那种失败，
  // 用户完全无感；真不通才落进队列。
  pushOrder: function(order, opts){
    // 先落持久队列，再启动网络请求。微信内置浏览器可能在 POST 尚未完成时就被关掉；
    // 旧写法在 3 次尝试全部失败后才落队列，页面中途关闭会让服务端永远收不到单。
    // 后端按 order_no 幂等，补推即使和第一次同时到达也不会重复建单。
    qAdd(order)
    var o = opts || {}
    var tries = o.tries || 3
    var delays = [0, 600, 1600]
    var self = this
    function attempt(i){
      return self._post(order).then(function(r){
        if(r && r.ok){
          qDrop(order.order_no)
          r.attempts = i + 1
          return r
        }
        // 4xx 是「服务端明确拒绝」——重试没有意义，但也要落队列：
        // 万一是服务端 bug，队列能让它在修好后自动补上。
        if(i + 1 >= tries) return r
        return sleep(delays[Math.min(i + 1, delays.length - 1)]).then(function(){ return attempt(i + 1) })
      })
    }
    return attempt(0).then(function(r){
      // localStorage 被禁用/写满时 qAdd 会失败，不许谎报「已经排队」。
      // 若中途另一个补推任务移除了队列，最后失败时补一次（后端按单号幂等）。
      if(!(r && r.ok) && !qHas(order.order_no)){
        if(!r) r = { ok:false, net:true }
        r.queue_failed = !qAdd(order)
      }
      return r
    })
  },

  // 补推队列里的所有单。返回 { tried, ok, left }
  flushQueue: function(){
    var q = qRead()
    if(!q.length) return Promise.resolve({ tried:0, ok:0, left:0 })
    var self = this, ok = 0
    return q.reduce(function(chain, order){
      return chain.then(function(){
        return self.pushOrder(order, { tries: 2 }).then(function(r){ if(r && r.ok) ok++ })
      })
    }, Promise.resolve()).then(function(){
      return { tried: q.length, ok: ok, left: qSize() }
    })
  },

  // —— 后台：拉取台账 ——
  pull: function(key){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return fetch(CLOUD_BASE + '/api/ledger', { headers: { 'X-Admin-Key': key }, cache:'no-store' })
      .then(function(r){
        return r.json().catch(function(){ return {} }).then(function(j){
          j.status = r.status
          return j
        })
      })
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

  // —— 客户页：一次查多单 ——
  //
  // 为什么要有它：原来「我的订单」里每一单都单独打一次 GET /api/order/<no>，
  // 6 单就是 6 次请求。而单条查单是 30 次/小时/IP ——
  // 客户点几下「刷新进度」额度就见底，然后看到「查询有点频繁」。
  //
  // 那不是限流值写错了，是**接口粒度选错了**：客户要的是
  // 「我这几单现在各是什么状态」，本来就该是一次请求。
  //
  // 服务端版本可能比前端旧（两边分开发），所以第一次撞到 404 就记下来，
  // 之后不再试，直接退回逐单查 —— 否则每次刷新都白打一个 404。
  _batchOk: null,
  lookupOrders: function(items){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    var self = this
    if(self._batchOk === false) return Promise.resolve({ ok:false, unsupported:true })
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
    var timer = ctl ? setTimeout(function(){ ctl.abort() }, 20000) : null
    return fetch(CLOUD_BASE + '/api/orders/lookup', {
      method: 'POST', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items }),
    }).then(function(r){
      return r.json().catch(function(){ return {} }).then(function(j){
        j.status = r.status
        if(r.status === 404 || r.status === 400 && j.error === 'bad_items') self._batchOk = false
        else if(r.ok) self._batchOk = true
        return j
      })
    }).catch(function(){ return { ok:false, net:true } })
      .then(function(j){ if(timer) clearTimeout(timer); return j })
  },

  // —— 后台：上传媒体（信封正反面照片 / 投递视频）——
  //
  // 媒体**不能**只存在后台那台设备上：以前存的是 URL.createObjectURL(file)，
  // 那是一个只在「创建它的那次会话」里有效的 blob 地址 ——
  // 后台自己看着好好的，客户那台手机上永远是打不开的。
  //
  // 所以必须真的传上来。base64 而不是 multipart：这个服务一直是零依赖，
  // 而 multipart 解析要引依赖或自己写解析器；base64 体积涨 1/3，图片/短视频可以接受。
  uploadMedia: function(key, orderNo, kind, file, onProgress){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return new Promise(function(resolve){
      var fr = new FileReader()
      fr.onerror = function(){ resolve({ ok:false, read_error:true }) }
      fr.onload = function(){
        var data = String(fr.result || '')
        var comma = data.indexOf(',')
        if(comma > 0) data = data.slice(comma + 1)
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
        // 大文件走几十秒是正常的（实测 12MB 上传在 20 秒量级），
        // 超时给足，否则视频永远「上传失败」，而其实只是慢。
        var timer = ctl ? setTimeout(function(){ ctl.abort() }, 180000) : null
        if(onProgress) { try { onProgress('uploading') } catch(e){} }
        fetch(CLOUD_BASE + '/api/media', {
          method: 'POST', signal: ctl ? ctl.signal : undefined,
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
          body: JSON.stringify({
            order_no: orderNo, kind: kind, name: file.name, mime: file.type, data: data,
          }),
        }).then(function(r){
          return r.json().catch(function(){ return {} }).then(function(j){
            j.status = r.status
            return j
          })
        }).catch(function(e){
          return { ok:false, net:true, aborted: !!(e && e.name === 'AbortError') }
        }).then(function(j){ if(timer) clearTimeout(timer); resolve(j) })
      }
      fr.readAsDataURL(file)
    })
  },

  // —— 后台：删除媒体 ——
  deleteMedia: function(key, orderNo, file){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return fetch(CLOUD_BASE + '/api/media', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ order_no: orderNo, file: file }),
    }).then(function(r){ return r.json().catch(function(){ return {} }) })
      .catch(function(){ return { ok:false, net:true } })
  },

  // 把媒体记录拼成一个能直接塞进 <img src> / <video src> 的地址。
  //
  // 地址是**相对路径**（/api/media/...），存进数据里的是相对路径 ——
  // 存绝对地址会把「当前这个后端域名」焊死在订单里，
  // 而后端地址每次重新发布都会变（已经换过 8 次）。
  // 手机号后 4 位是这道门禁的另一半：媒体里印着客户收信地址，不能公开。
  mediaUrl: function(rec, phone){
    if(!rec || !rec.path) return ''
    // 老数据里可能存的是 blob: / data: 地址。
    // blob: 是**只在创建它的那次会话里有效**的临时地址 —— 换台设备、换个会话就是死链，
    // 而这正是「投递视频客户端加载不出来」的真身。
    // 这里返回空串（＝当它不存在），让页面显示「还没上传」，
    // 而不是渲染一个永远转圈 / 裂图的播放器 —— 那看起来像「你做的视频有问题」。
    if(/^(blob|data):/i.test(rec.path)) return ''
    if(/^https?:\/\//i.test(rec.path)) return rec.path        // 历史数据兜底：绝对地址
    var tail = String(phone || '').replace(/\D/g, '').slice(-4)
    var u = CLOUD_BASE + rec.path
    if(tail.length === 4) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'phone=' + encodeURIComponent(tail)
    return u
  },

  // —— 后台：服务端连通性 ——
  // 只回答「通不通、是不是我们的服务」。刻意不依赖 /api/logs ——
  // 那样的话，服务端还是旧版本（没有日志接口）时，诊断会误报成「连不上」，
  // 把一个版本差异说成网络故障，比不说还糟。
  health: function(){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null
    var timer = setTimeout(function(){ if(ctl) ctl.abort() }, 8000)
    return fetch(CLOUD_BASE + '/api/health', { cache:'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function(r){
        return r.json().catch(function(){ return {} }).then(function(j){
          j.status = r.status
          j.ok = !!(r.ok && j && j.ok === true && j.service === 'artist-letter-api')
          if(r.ok && j && j.service !== 'artist-letter-api') j.wrong_service = true
          return j
        })
      })
      .catch(function(){ return { ok:false, net:true } })
      .then(function(j){ clearTimeout(timer); return j })
  },

  // —— 后台：云端哨兵的体检结论 ——
  //
  // 为什么后台要显示它：老板的电脑会关机，GitHub 的定时任务又跑不起来
  // （改 workflow 文件需要额外权限，拿不到）。所以巡检改由**云端服务自己**做 ——
  // 它跟这台服务器一起活，老板关不关机跟它无关。
  // 这个接口读的就是那份结论，让老板在任何设备上打开后台都能一眼看到「线上还好吗」。
  //
  // 服务端版本较旧时这个接口不存在 → 404，调用方要按「还没有」处理，别当成故障。
  // run=1 会让云端**立刻再做一次体检**（后台那个「现在就体检」按钮用）。
  patrol: function(key, run){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return fetch(CLOUD_BASE + '/api/patrol' + (run ? '?run=1' : ''), {
      headers: { 'X-Admin-Key': key }, cache:'no-store',
    }).then(function(r){
      return r.json().catch(function(){ return {} }).then(function(j){
        j.status = r.status
        return j
      })
    }).catch(function(){ return { ok:false, net:true } })
  },

  // —— 后台：服务端请求留痕（排障用）——
  // 「那台设备到底有没有连上来」这个问题的答案就在这里。
  // 服务端版本较旧时这个接口不存在，会拿到 404 —— 调用方要按 not_found 单独说明，
  // 不要把它当成「连不上」。
  logs: function(key, n){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    return fetch(CLOUD_BASE + '/api/logs?n=' + (n || 80), {
      headers: { 'X-Admin-Key': key }, cache:'no-store',
    }).then(function(r){
      return r.json().catch(function(){ return {} }).then(function(j){
        j.status = r.status
        return j
      })
    }).catch(function(){ return { ok:false, net:true } })
  },

  // —— 客户自服务：换设备也能查自己的单 ——
  // 路径：GET /api/order/<order_no>?phone=<digits>。
  //
  // 服务端对「订单号不存在」和「手机号不匹配」返回**同一个** 404，
  // 所以这里不去分别两种 —— 只把 HTTP 状态透出去给 UI 判断。
  // 503（仓库暂时不可达）也单独透出，让 UI 说人话而不是假装没找到。
  lookupOrder: function(orderNo, phoneTail){
    if(!CLOUD_BASE) return Promise.resolve({ ok:false, off:true })
    var url = CLOUD_BASE + '/api/order/' + encodeURIComponent(orderNo)
    if(phoneTail) url += '?phone=' + encodeURIComponent(phoneTail)
    return fetch(url, { cache: 'no-store' })
      .then(function(r){
          // 把 HTTP 状态也透出去 —— 客户端需要区分 404 / 503
          return r.json().catch(function(){ return {} }).then(function(j){
            j.status = r.status
            return j
          })
        })
      .catch(function(){ return { ok:false, net:true } })
  },
}

// —— 自动补推 ——
// 三个触发点：① 页面加载 ② 回到前台 ③ 每 45 秒一次（队列非空时才真的发请求）。
// 客户下单后如果那次推送失败，只要他还在这个页面、或者以后再打开一次，单子就会补上。
function autoFlush(){
  if(!CLOUD_BASE) return
  Cloud.flushQueue().then(function(r){
    if(r && r.ok > 0 && typeof window.__onPushFlushed === 'function'){
      try { window.__onPushFlushed(r) } catch(e){}
    }
  })
}
var _flushTimer = null
function startAutoFlush(){
  autoFlush()
  if(_flushTimer) return
  _flushTimer = setInterval(function(){
    if(document.hidden) return
    if(!qSize()) return
    autoFlush()
  }, 45000)
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startAutoFlush)
else startAutoFlush()
document.addEventListener('visibilitychange', function(){ if(!document.hidden) autoFlush() })
window.addEventListener('online', function(){ autoFlush() })
