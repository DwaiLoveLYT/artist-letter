// ==================================================================
//  接单台账 · 内部管理后台
//  与客户下单页共用同一份 localStorage 数据（同源才能共享）
// ==================================================================

const STORE_KEY = 'artist_letter_orders_v1'
const PIN_KEY   = 'artist_letter_admin_pin'
const PRICE     = 190
const PIN_LEN   = 6
const CONTACT_WX = 'IMDWAY'

const STATUS_FLOW = [
  { key:'created', label:'待付款', hint:'订单已生成，等客户转账' },
  { key:'paid',    label:'待开工', hint:'款已收到，排队安排绘制' },
  { key:'drawing', label:'绘制中', hint:'手绘信封制作中' },
  { key:'mailed',  label:'已寄出', hint:'已投递并录制视频，等待对方收取' },
  { key:'done',    label:'已完成', hint:'寄出后 4–8 周无退回，视为送达' },
]
const STATUS_MAP = {}
STATUS_FLOW.forEach(s => STATUS_MAP[s.key] = s)

function statusLabel(k){ return STATUS_MAP[k] ? STATUS_MAP[k].label : '处理中' }
function statusIdx(k){ return STATUS_FLOW.findIndex(s => s.key === k) }

// ==================== 存储 ====================
function allOrders(){
  try { const list = JSON.parse(localStorage.getItem(STORE_KEY)); return Array.isArray(list) ? list : [] }
  catch(e){ return [] }
}
// 所有写盘都走这里 —— 顺带触发云端同步，不用在每个改动点都记着调一次
function saveOrders(list){
  localStorage.setItem(STORE_KEY, JSON.stringify(list))
  cloudTouch()
}
function getOrder(id){ return allOrders().find(o => o.id === id) || null }
function updOrder(id, patch){
  const list = allOrders(); const i = list.findIndex(o => o.id === id)
  if(i < 0) return null
  // 每次都盖 updated_at：跨设备合并时靠它判断「哪一份更新」，
  // 不盖的话两台设备的改动会互相顶回旧状态。
  list[i] = Object.assign({}, list[i], patch, { updated_at: Date.now() })
  saveOrders(list); return list[i]
}
function delOrder(id){
  const o = getOrder(id)
  if(o) markDeleted(o.order_no)      // 留墓碑：否则下次合并会把这条从云端又拉回来
  saveOrders(allOrders().filter(o => o.id !== id))
}
function log(id, text){
  const o = getOrder(id); if(!o) return
  const logs = Array.isArray(o.logs) ? o.logs : []
  logs.push({ at: Date.now(), text })
  updOrder(id, { logs })
}

// ==================== 云端同步 ====================
// 台账原先只住在浏览器里 —— 所以「客户在自己手机上下的单，我这边看不到」
// 不是 bug，是 localStorage 按「设备 + 浏览器 + 域名」隔离，换台设备就是另一个空存储。
// 这一段把台账接到自建后端上：客户页直传的单会自动进来，我这边的改动也会回推。
//
// 设计原则：**服务端不可用时，后台必须完全照旧能用**（退回纯本地）。
// 任何一次网络失败都不能让页面卡住、报错、或丢数据。

const CLOUD_KEY_STORE = 'artist_letter_cloud_key'
const CLOUD_DEL_STORE = 'artist_letter_cloud_deleted'
const CLOUD_SKIP_STORE = 'artist_letter_cloud_skip'   // 这台设备主动跳过过引导，就别每次登录都弹

let cloudKey   = ''
let cloudBusy  = false
let cloudAt    = 0            // 上次成功同步的时间
let cloudErr   = ''
let cloudMute  = false        // 正在把远端合并回本地时，别再触发推送（否则自己推自己）
let cloudTimer = null

// —— 下面几个是「这台设备到底看得见多少单」的证据 ——
// 后台存在的唯一理由就是「客户下的单我能看到」。所以不能只说「同步成功」，
// 得能把两边数字摊开给人看：服务端几单 / 本机几单 / 差在哪。
let cloudTotal = -1           // 服务端台账单数（GET /api/ledger 的 total）
let cloudReconciled = null    // 服务端这次读台账有没有对账成功
let cloudFresh = []           // 本次拉取新进来的单（用来提示 + 高亮）
let cloudUpdated = []         // 本机已有、但状态被别处改过的单（同样要提示）
const freshNos = new Set()    // 新单高亮（点开卡片后消失）
const updNos   = new Set()    // 「有更新」高亮（同样点开即撤）
let cloudPollTimer = null
const CLOUD_POLL_MS = 25000

function cloudLoad(){
  try { cloudKey = localStorage.getItem(CLOUD_KEY_STORE) || '' } catch(e){ cloudKey = '' }
}
function cloudSaveKey(k){
  cloudKey = String(k || '').trim()
  try {
    if(cloudKey) localStorage.setItem(CLOUD_KEY_STORE, cloudKey)
    else localStorage.removeItem(CLOUD_KEY_STORE)
  } catch(e){}
}
function pendingDeleted(){
  try { const a = JSON.parse(localStorage.getItem(CLOUD_DEL_STORE)); return Array.isArray(a) ? a : [] }
  catch(e){ return [] }
}
function markDeleted(no){
  if(!no) return
  const a = pendingDeleted()
  if(a.indexOf(no) < 0) a.push(no)
  try { localStorage.setItem(CLOUD_DEL_STORE, JSON.stringify(a.slice(-500))) } catch(e){}
}
function clearDeleted(){ try { localStorage.removeItem(CLOUD_DEL_STORE) } catch(e){} }

function cloudOn(){ return !!(window.Cloud && Cloud.on() && cloudKey) }

// 任何一次本地改动都会走到这里 —— 攒 1.2 秒再推，避免连点状态时打十几次请求
function cloudTouch(){
  if(cloudMute || !cloudOn()) return
  clearTimeout(cloudTimer)
  cloudTimer = setTimeout(() => { cloudPush() }, 1200)
}

function stampOf(o){ return Number(o && (o.updated_at || o.created_at)) || 0 }

// 同一单在两处都有 → 取「最后被改过」的那份
function mergeByStamp(a, b){
  const map = new Map()
  ;[].concat(a || [], b || []).forEach(o => {
    if(!o || !o.order_no) return
    const prev = map.get(o.order_no)
    if(!prev || stampOf(o) >= stampOf(prev)) map.set(o.order_no, o)
  })
  const out = [...map.values()].sort((x, y) => stampOf(y) - stampOf(x))
  // 客户页直传上来的单没有本地 id，而卡片、按钮、展开状态全都靠 id 定位 —— 必须补上
  out.forEach(o => { if(!o.id) o.id = 'c-' + o.order_no + '-' + Math.random().toString(36).slice(2, 8) })
  return out
}

async function cloudPull(silent){
  if(!cloudOn()) return { ok:false, off:true }
  if(cloudBusy) return { ok:false, busy:true }
  cloudBusy = true; if(!silent) renderCloudBar()
  let r
  try { r = await Cloud.pull(cloudKey) } finally { cloudBusy = false }

  if(!(r && r.ok)){
    cloudErr = cloudErrText(r)
    renderCloudBar()
    return r || { ok:false }
  }
  const localBefore = allOrders()
  const beforeNos = new Set(localBefore.map(o => o.order_no))
  const merged = mergeByStamp(localBefore, r.orders)
  cloudMute = true
  try { saveOrders(merged) } finally { cloudMute = false }
  cloudAt = Date.now(); cloudErr = ''
  cloudTotal = (typeof r.total === 'number') ? r.total : -1
  cloudReconciled = (r.reconciled === undefined) ? null : !!r.reconciled

  // 这一轮新进来的单 —— 客户刚下的单必须**被看见**，不能只是悄悄躺在列表里。
  // 高亮保留到他自己点开那张卡（见 toggle），避免一直亮着变成噪音。
  //
  // 注意：标记放在内存 Set 里，不能挂到订单对象上 ——
  // renderList() 会重新从 localStorage 读一遍，挂在对象上的标记会当场丢掉。
  cloudFresh = merged.filter(o => o.order_no && !beforeNos.has(o.order_no))
  if(cloudFresh.length){
    // 换新设备第一次接通时，整份台账都是「新进来」的。
    // 那种情况把每张卡都点亮等于全都没亮，只提示数字就够了。
    if(cloudFresh.length <= 8) cloudFresh.forEach(o => freshNos.add(o.order_no))
    toast('云端进来 ' + cloudFresh.length + ' 单 · 尾号 '
      + cloudFresh.slice(0, 6).map(o => tail(o.order_no)).join(' ')
      + (cloudFresh.length > 6 ? ' …' : ''))
  }

  // —— 本机已有、但状态被别处改过的单 ——
  //
  // 「我更新了进度，其他设备看不到」的另一半就在这里：
  // 光是**新单**进来还不够，**状态变化**也必须进来。
  // 之前只提示新单，所以另一台设备上改了状态、这一台虽然数据已经更新了，
  // 却没有任何提示 —— 看上去就像「没同步」。
  //
  // 判断依据是合并前后本机那一份的差异：状态、收款、地址这三样是客户真正会感知的。
  const beforeMap = new Map(localBefore.filter(o => o.order_no).map(o => [o.order_no, o]))
  cloudUpdated = merged.filter(o => {
    const b = beforeMap.get(o.order_no)
    if(!b) return false
    return b.status !== o.status
        || b.pay_status !== o.pay_status
        || String(b.recipient_addr || '') !== String(o.recipient_addr || '')
  })
  if(cloudUpdated.length){
    if(cloudUpdated.length <= 8) cloudUpdated.forEach(o => updNos.add(o.order_no))
    toast('云端更新了 ' + cloudUpdated.length + ' 单的进度 · 尾号 '
      + cloudUpdated.slice(0, 6).map(o => tail(o.order_no)).join(' ')
      + (cloudUpdated.length > 6 ? ' …' : ''))
  }

  renderList()
  // 本地可能比云端多（上次没推成功的改动）—— 拉完顺手推一次补齐
  cloudPush(true)
  return { ok:true, added: Math.max(0, merged.length - localBefore.length),
           fresh: cloudFresh.length, updated: cloudUpdated.length }
}

async function cloudPush(silent){
  if(!cloudOn()) return { ok:false, off:true }
  const del = pendingDeleted()
  const r = await Cloud.push(cloudKey, allOrders(), del)
  if(r && r.ok){
    if(del.length) clearDeleted()
    cloudAt = Date.now(); cloudErr = ''
  } else {
    cloudErr = cloudErrText(r)
  }
  if(!silent) renderCloudBar()
  return r || { ok:false }
}

function cloudErrText(r){
  if(!r) return '连不上'
  if(r.net) return '网络不通'
  if(r.off) return '未配置'
  if(r.error === 'bad_key') return '同步密钥不对'
  if(r.error === 'locked')  return '密钥错太多次，已临时锁定（填入正确密钥可立即解锁）'
  if(r.error === 'rate_limited') return '请求太频繁'
  if(r.error === 'admin_key_not_configured') return '服务端还没配密钥'
  return r.error ? String(r.error) : '未知错误'
}

// ==================== 自动轮询 ====================
//
// 之前后台只在「输完密码进门」那一刻拉一次。于是有一个很坑的场景：
// 后台一直开着放在旁边，客户这期间下了单 —— 屏幕上什么都不会变，
// 看上去就是「客户下的单我后台看不到」。
//
// 所以进门之后持续轮询（默认 25 秒），另外回到前台、网络恢复都立刻补一次。
// 只有页面在前台时才发请求：后台标签页轮询既费电又没意义。
function cloudPollStart(){
  cloudPollStop()
  cloudPollTimer = setInterval(() => {
    if(document.hidden) return
    if(cloudBusy) return
    if(!cloudOn()) return
    cloudPull(true)
  }, CLOUD_POLL_MS)
}
function cloudPollStop(){
  if(cloudPollTimer){ clearInterval(cloudPollTimer); cloudPollTimer = null }
}
document.addEventListener('visibilitychange', () => {
  if(document.hidden){ return }
  if(!cloudOn()) return
  cloudPull(true)          // 回到前台先拉一次，别等下一个 25 秒
  cloudPollStart()
})
window.addEventListener('online', () => { if(cloudOn()) cloudPull(true) })

// 同步地址自愈：cloud.js 探测到本机缓存的覆盖地址已经死了、内置地址是活的，
// 就会换过来并通知这里。此时要做的只有一件事 —— 用新地址立刻重拉。
window.__onCloudBaseHealed = function(d){
  cloudErr = ''
  toast('同步地址已自动修复，正在重新拉取…')
  setTimeout(() => { if(cloudOn()) cloudPull() }, 200)
}

function agoText(ts){
  if(!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if(s < 60) return '刚刚'
  if(s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if(s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return Math.floor(s / 86400) + ' 天前'
}

function renderCloudBar(){
  const box = document.getElementById('cloud-bar')
  if(!box) return
  if(!window.Cloud || !Cloud.on()){
    box.innerHTML = ''
    return
  }

  const local = allOrders().length

  // —— ① 这台设备还没填过同步密钥 ——
  // 这是「换个设备登录就看不到单」的**唯一**原因，也是整个后台最容易漏掉的一步。
  // 所以它不能是一条细细的提示条：必须是一块挡在列表前面的告示，
  // 明确写出「你现在看到的是本机台账，不是全部订单」。
  if(!cloudKey){
    box.innerHTML = `
      <div class="cl-bar off">
        <div class="cl-main">
          <div class="cl-t">⚠ 云端同步未开启 —— 你看到的只是这台设备上的 ${local} 单</div>
          <div class="cl-d">
            客户在<b>他自己手机</b>上下的单不会自动进来。
            每换一台设备（新手机、新浏览器、清了缓存）都要重新填一次同步密钥 —— 填一次就长期有效。
          </div>
        </div>
        <button class="cl-btn" onclick="openCloudKey()">填密钥 · 接通</button>
      </div>`
    return
  }

  if(cloudErr){
    box.innerHTML = `
      <div class="cl-bar err">
        <div class="cl-main">
          <div class="cl-t">⚠ 云端同步失败：${esc(cloudErr)} —— 本机 ${local} 单，云端单数未知</div>
          <div class="cl-d">
            本地台账照常能用，改动会在网络恢复后补推。
            <b>但此刻你看不到客户刚下的单</b>，别急着下结论说「没有新单」。
          </div>
        </div>
        <button class="cl-btn" onclick="cloudPull()">重试</button>
        <button class="cl-btn ghost" onclick="openCloudDiag()">诊断</button>
      </div>`
    return
  }

  // —— ③ 正常：把两个数字摊开 ——
  // 「云端 2 / 本机 2」比「同步成功」有用得多：差一个数，就说明有事。
  const diff = (cloudTotal >= 0 && cloudTotal !== local)
  const title = cloudBusy
    ? '正在同步…'
    : ('云端同步已开启 · ' + (cloudAt ? agoText(cloudAt) : '还没同步过'))
  const desc = diff
    ? `云端 ${cloudTotal} 单 / 本机 ${local} 单 —— 数字对不上，点「诊断」看差在哪`
    : (cloudTotal >= 0
        ? `云端 ${cloudTotal} 单 / 本机 ${local} 单 · 两边一致。客户页下的单每 ${Math.round(CLOUD_POLL_MS/1000)} 秒自动进来一次`
        : `本机 ${local} 单 · 客户页下的单会自动进来；这边的改动也会推上去`)

  box.innerHTML = `
    <div class="cl-bar ${diff ? 'err' : 'ok'}">
      <div class="cl-main">
        <div class="cl-t">${esc(title)}</div>
        <div class="cl-d">${esc(desc)}</div>
      </div>
      <button class="cl-btn" onclick="cloudPull()">${diff ? '强制同步' : '立即同步'}</button>
      <button class="cl-btn ghost" onclick="openCloudDiag()">诊断</button>
    </div>`
}

// ==================== 云端同步诊断 ====================
// 「客户下的单我后台看不到」这句话，必须能被拆成可验证的几段：
//   地址对不对 → 连不连得上 → 密钥对不对 → 服务端有几单 → 本机有几单 → 差在哪
// 光看一个「同步失败」是查不出来的。
async function openCloudDiag(){
  const local = allOrders()
  const base = (window.Cloud && Cloud.base) ? Cloud.base() : '(未加载 cloud.js)'
  const isOv = (window.Cloud && Cloud.isOverridden) ? Cloud.isOverridden() : false
  const healed = (window.Cloud && Cloud.healedFrom) ? Cloud.healedFrom() : ''
  const pend = (window.Cloud && Cloud.pending) ? Cloud.pending() : 0

  openSheet(`
    <div class="sh-title">云端同步诊断</div>
    <div class="sh-sub">正在探测服务端…</div>
    <div id="diag-body"><div class="hint">探测中…</div></div>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">关闭</button>
  `)

  // 连通性和「服务端几单」用两个不同的接口，各管一件事：
  //   · health  → 只回答「通不通、是不是我们的服务」（不依赖日志接口是否存在）
  //   · ledger  → 回答「服务端到底有几单」（这个数字是权威的，health 里那个不是）
  //   · logs    → 只用来显示请求留痕；服务端版本旧时它是 404，要单独说明
  let h = null, lg = null
  try { h = await Cloud.health() } catch(e){}
  try { lg = await Cloud.logs(cloudKey, 40) } catch(e){}

  const online = !!(h && h.ok)
  const serverTotal = cloudTotal                       // 来自上次 GET /api/ledger
  const logsOK = !!(lg && lg.ok)
  const logsMissing = !!(lg && lg.status === 404)       // 服务端还是旧版本

  const body = document.getElementById('diag-body')
  if(!body) return

  body.innerHTML = `
    <div class="chk-row"><div class="chk-key">同步地址</div><div class="chk-val mono">${esc(base)}</div></div>
    <div class="chk-row"><div class="chk-key">地址来源</div><div class="chk-val">${
      isOv ? '<b style="color:#EF9F27">本机覆盖值（非常规）</b>' : '内置默认'
    }</div></div>
    ${healed ? `<div class="chk-row"><div class="chk-key">已自愈</div><div class="chk-val" style="color:#5DCAA5">旧的死地址已被自动替换</div></div>` : ''}
    <div class="chk-row"><div class="chk-key">同步密钥</div><div class="chk-val">${
      cloudKey ? ('已配置（' + cloudKey.length + ' 位）') : '<b style="color:#EF9F27">未配置</b>'
    }</div></div>
    <div class="chk-row"><div class="chk-key">服务端连通</div><div class="chk-val">${
      online ? '<b style="color:#5DCAA5">通</b>'
      : (h && h.wrong_service ? '<b style="color:#E24B4A">地址不是我们的服务</b>'
        : '<b style="color:#E24B4A">不通</b>')
    }</div></div>
    <div class="chk-row"><div class="chk-key">服务端台账</div><div class="chk-val">${
      serverTotal >= 0 ? serverTotal + ' 单' : '还没读到'
    }</div></div>
    <div class="chk-row"><div class="chk-key">本机台账</div><div class="chk-val">${local.length} 单</div></div>
    <div class="chk-row"><div class="chk-key">待补推</div><div class="chk-val">${pend ? pend + ' 单' : '无'}</div></div>
    <div class="chk-row"><div class="chk-key">最近同步</div><div class="chk-val">${
      cloudErr ? '<b style="color:#E24B4A">' + esc(cloudErr) + '</b>' : (cloudAt ? agoText(cloudAt) : '还没同步过')
    }</div></div>

    <div class="sh-gap"></div>
    <button class="btn-full" onclick="closeSheet();cloudPull()">立即重新同步</button>

    ${logsOK ? `
      <div class="sh-gap"></div>
      <div class="sh-sub" style="margin-bottom:6px">服务端最近收到的请求（最新的在上）</div>
      <div class="diag-log">${
        (lg.entries || []).slice(0, 22).map(e => {
          const when = new Date(e.t).toLocaleString('zh-CN', { hour12:false })
          const key = e.key === 'ok' ? '密钥✓' : (e.key === 'bad' ? '密钥✗' : (e.key === 'none' ? '无密钥' : '—'))
          return `<div class="diag-line"><span class="dl-t">${when}</span>`
            + `<span class="dl-m">${esc(e.m)} ${esc(e.p)}</span>`
            + `<span class="dl-s ${e.s === 200 ? 'good' : 'bad'}">${e.s}</span>`
            + `<span class="dl-k">${key}</span>`
            + (e.note ? `<span class="dl-n">${esc(e.note)}</span>` : '')
            + `</div>`
        }).join('') || '<div class="hint">还没有任何请求记录</div>'
      }</div>
      <div class="hint" style="margin-top:8px; line-height:1.8">
        这一栏就是「你的设备到底有没有连上服务器」的答案。<br>
        · 只有 <b>GET /api/health</b> = 页面开着但没同步<br>
        · <b>GET /api/ledger</b> 且状态 200 = 后台成功读到全部订单<br>
        · <b>POST /api/order</b> 200 = 客户那一单服务端确实收到了
      </div>` : (logsMissing ? `
      <div class="hint" style="margin-top:10px; line-height:1.8">
        服务端还是旧版本（没有请求留痕接口），所以这一栏暂时是空的。<br>
        <b>上面那些行都是准的</b> —— 同步本身正常工作，只是看不到历史请求。
      </div>` : `
      <div class="hint" style="margin-top:10px; line-height:1.8">
        读不到服务端请求记录。<br>
        ${online ? '连通性是通的，可能只是刚才那次请求超时，点上面重试。'
                 : (cloudKey ? '先确认手机能上网，再点上面的「立即重新同步」。' : '先填同步密钥。')}
      </div>`)}
  `
}

function openCloudKey(){
  openSheet(`
    <div class="sh-title">开启云端同步</div>
    <div class="sh-sub">
      <b>这是「换设备也能看到全部订单」的那一步。</b><br>
      把同步密钥粘进来。密钥只存在这台设备的浏览器里，用来证明「拉台账的人是我」。<br>
      <b style="color:#EF9F27">不要发给别人。</b>
    </div>
    <textarea class="sh-textarea" id="cloud-key-input" placeholder="同步密钥">${esc(cloudKey)}</textarea>
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="doSaveCloudKey()">保存并立即同步</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet();openCloudDiag()">先诊断一下</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">取消</button>
    ${cloudKey ? '<div class="sh-gap"></div><button class="btn-full grey" onclick="doCloudOff()">断开同步（台账不受影响）</button>' : ''}
  `)
  setTimeout(() => { const t = document.getElementById('cloud-key-input'); if(t) t.focus() }, 300)
}

async function doSaveCloudKey(){
  const el = document.getElementById('cloud-key-input')
  cloudSaveKey(el ? el.value : '')
  if(!cloudKey){ closeSheet(); renderCloudBar(); return }
  try { localStorage.removeItem(CLOUD_SKIP_STORE) } catch(e){}
  closeSheet()
  renderCloudBar()
  const r = await cloudPull()
  if(r && r.ok){
    toast('已连接 · 云端 ' + (cloudTotal >= 0 ? cloudTotal : allOrders().length) + ' 单 / 本机 ' + allOrders().length + ' 单')
  } else {
    toast('连不上：' + cloudErrText(r))
  }
  cloudPollStart()
}

function doCloudOff(){
  cloudSaveKey('')
  // 主动断开 = 以后别再自动弹密钥框，但那条告示一直留着
  try { localStorage.setItem(CLOUD_SKIP_STORE, '1') } catch(e){}
  cloudPollStop()
  // 备份提醒的措辞跟着同步状态变（开着说「服务停了也还在」，关着说「清缓存就没了」），
  // 所以断开时也要重画一次，否则那句话会停在上一状态。
  closeSheet(); renderCloudBar(); renderBackupNudge()
  toast('已断开同步，台账留在本机')
}

// ==================== 工具 ====================
function fmt(ts){
  if(!ts) return '-'
  const d = new Date(ts), p = n => String(n).padStart(2,'0')
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtDay(ts){
  const d = new Date(ts), p = n => String(n).padStart(2,'0')
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`
}
function esc(s){ return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function tail(no){ return (no || '').slice(-4).toUpperCase() }

// 「待查地址」= 客户把地址交给我查，而这一单还没查到。
// 一旦我把查到的地址填进去，它就自动从待办里消失 —— 不用手动销项。
function needLookup(o){ return !!o.addr_lookup && !String(o.recipient_addr || '').trim() }

let toastTimer = null
function toast(msg){
  const el = document.getElementById('toast')
  el.innerText = msg; el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('on'), 1900)
}
function copy(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => fbCopy(text))
  } else fbCopy(text)
}
function fbCopy(text){
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0'
  document.body.appendChild(ta); ta.select()
  try { document.execCommand('copy'); toast('已复制') } catch(e){ toast('复制失败，请长按手动复制') }
  document.body.removeChild(ta)
}

// ==================== 锁屏 · 密码 / 恢复码 ====================
// 设计取舍：后台是纯静态页、数据全在本机 localStorage，没有服务端。
// 所以「服务端发邮箱验证码」这条路走不通（前端发邮件会把密钥暴露）。
// 改成：设置密码时生成一次性「恢复码」，由你自己存进邮箱/微信收藏，
// 忘记密码时用恢复码重设。等效于「邮箱里那把备用钥匙」，但零依赖、零成本。
// 另外把密码从明文改成 SHA-256 存储，补上「读 localStorage 就能看到密码」的口子。

const RECOV_KEY = 'artist_letter_recovery_hash'
const EMAIL_KEY = 'artist_letter_admin_email'
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // 去掉易混的 I O 0 1

let pinBuf = '', pinMode = 'verify', pinFirst = ''
let lockStep = 'pin'      // pin | email | recovery | recover | wipe
let tmpPin = '', tmpEmail = '', tmpRecovery = '', isResetting = false

// ---------- 哈希 ----------
async function sha(s){
  const text = 'al::' + s
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('')
  } catch(e){
    return 'plain:' + text            // 非安全上下文兜底，功能不受影响
  }
}
async function verifyPin(input){
  const stored = localStorage.getItem(PIN_KEY) || ''
  if(!stored) return false
  if(stored.indexOf('plain:') === 0) return stored === 'plain:al::' + input
  if(/^[0-9a-f]{64}$/.test(stored))  return stored === await sha(input)
  // 旧版本存的是明文 6 位 → 校验通过后顺手升级成哈希，把口子补上
  if(stored === input){ localStorage.setItem(PIN_KEY, await sha(input)); return true }
  return false
}
function normCode(s){ return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '') }
async function verifyRecovery(input){
  const stored = localStorage.getItem(RECOV_KEY) || ''
  if(!stored) return false
  return stored === await sha('rc::' + normCode(input))
}
async function storeRecovery(code){
  localStorage.setItem(RECOV_KEY, await sha('rc::' + normCode(code)))
}
function makeRecoveryCode(){
  let s = ''
  for(let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]
  return s.slice(0,4) + '-' + s.slice(4)
}
function recoveryMailto(code, email){
  const subject = encodeURIComponent('接单台账 · 后台恢复码（请长期保存）')
  const body = encodeURIComponent([
    '这是「接单台账」后台的恢复码。忘记密码时用它重设，所以请长期保留这封邮件。',
    '',
    '恢复码：' + code,
    '',
    '后台地址：' + location.origin + location.pathname,
    '生成时间：' + new Date().toLocaleString('zh-CN'),
    '',
    '提醒：恢复码只在设置时显示一次。重设密码后，旧恢复码会自动作废。',
  ].join('\n'))
  return 'mailto:' + email + '?subject=' + subject + '&body=' + body
}
function mailRecovery(code){
  const email = localStorage.getItem(EMAIL_KEY) || ''
  if(!email){ toast('还没登记邮箱'); return }
  window.location.href = recoveryMailto(code, email)
}

// ---------- 渲染 ----------
function lockShell(title, sub, body){
  return '<div class="lock-logo">DWAY</div>'
       + '<div class="lock-title">' + title + '</div>'
       + '<div class="lock-sub">' + sub + '</div>'
       + body
}

function renderLock(){
  const el = document.getElementById('lock-inner')
  if(!el) return

  if(lockStep === 'pin'){
    const t = pinMode === 'set' ? '设置访问密码'
            : pinMode === 'confirm' ? '再输一次确认' : '输入密码'
    const s = pinMode === 'set' ? PIN_LEN + ' 位数字 · 只存在这台设备里'
            : pinMode === 'confirm' ? '两次要一致'
            : '内部台账 · 请勿外传'
    el.innerHTML = lockShell(t, s,
      '<div class="lock-dots" id="lock-dots"></div>'
      + '<div class="lock-err" id="lock-err"></div>'
      + '<div class="keypad" id="keypad"></div>'
      + (pinMode === 'verify' ? '<button class="lock-link" id="lock-reset">忘记密码</button>' : ''))
    buildKeypad(); paintDots()
    const r = document.getElementById('lock-reset')
    if(r) r.onclick = goRecover
    return
  }

  if(lockStep === 'email'){
    el.innerHTML = lockShell('留个邮箱', '恢复码会发到这里。跳过也行，但要自己存好。',
      '<div class="lock-field"><input class="input" id="lock-input" type="email" inputmode="email"'
      + ' placeholder="你的邮箱" autocomplete="off" value="' + esc(tmpEmail) + '"></div>'
      + '<div class="lock-actions">'
      + '<button class="btn-full" id="lock-next">下一步</button>'
      + '<button class="btn-full grey" id="lock-skip">跳过，我自己存</button></div>')
    document.getElementById('lock-next').onclick = () => {
      tmpEmail = (document.getElementById('lock-input').value || '').trim()
      lockStep = 'recovery'; tmpRecovery = makeRecoveryCode(); renderLock()
    }
    document.getElementById('lock-skip').onclick = () => {
      tmpEmail = ''; lockStep = 'recovery'; tmpRecovery = makeRecoveryCode(); renderLock()
    }
    setTimeout(() => { const i = document.getElementById('lock-input'); if(i) i.focus() }, 120)
    return
  }

  if(lockStep === 'recovery'){
    el.innerHTML = lockShell('保存这串恢复码', '忘记密码时用它重设。只显示这一次。',
      '<div class="lock-code">' + esc(tmpRecovery) + '</div>'
      + '<div class="lock-note">建议现在就存到微信收藏、备忘录，或发到自己邮箱。</div>'
      + '<div class="lock-actions">'
      + '<button class="btn-full" id="lock-copy">复制恢复码</button>'
      + (tmpEmail ? '<button class="btn-full grey" id="lock-mail">发到 ' + esc(tmpEmail) + '</button>' : '')
      + '<button class="btn-full grey" id="lock-done">我已保存，进入台账</button></div>')
    document.getElementById('lock-copy').onclick = () => copy(tmpRecovery)
    const mb = document.getElementById('lock-mail')
    if(mb) mb.onclick = () => { window.location.href = recoveryMailto(tmpRecovery, tmpEmail) }
    document.getElementById('lock-done').onclick = finishSetup
    return
  }

  if(lockStep === 'recover'){
    el.innerHTML = lockShell('输入恢复码', '8 位，形如 4F7K-92MP。在你保存它的地方找。',
      '<div class="lock-field"><input class="input" id="lock-input2" type="text"'
      + ' autocapitalize="characters" placeholder="恢复码" autocomplete="off"></div>'
      + '<div class="lock-err" id="lock-err"></div>'
      + '<div class="lock-actions">'
      + '<button class="btn-full" id="lock-verify">验证并重设密码</button>'
      + '<button class="btn-full grey" id="lock-nocode">我没有恢复码</button></div>')
    document.getElementById('lock-verify').onclick = doRecover
    document.getElementById('lock-nocode').onclick = () => { lockStep = 'wipe'; renderLock() }
    setTimeout(() => { const i = document.getElementById('lock-input2'); if(i) i.focus() }, 120)
    return
  }

  if(lockStep === 'wipe'){
    el.innerHTML = lockShell('放弃门锁？', '数据不会丢，但锁就没了。',
      '<div class="lock-warn">没有恢复码，就无法验证是你本人。<br>'
      + '清空密码后，<b>任何拿到这台手机、知道这个网址的人都能看到全部订单</b>——'
      + '客户姓名、电话、地址、回信地址。<br>订单数据本身不会被删除。</div>'
      + '<div class="lock-actions">'
      + '<button class="btn-full danger" id="lock-wipe">我确认，清空密码</button>'
      + '<button class="btn-full grey" id="lock-back">返回，我再找找恢复码</button></div>')
    document.getElementById('lock-wipe').onclick = doWipePin
    document.getElementById('lock-back').onclick = () => { lockStep = 'recover'; renderLock() }
    return
  }
}

function initLock(){
  const has = !!localStorage.getItem(PIN_KEY)
  pinBuf = ''; pinFirst = ''; tmpPin = ''; tmpRecovery = ''
  tmpEmail = localStorage.getItem(EMAIL_KEY) || ''
  pinMode = has ? 'verify' : 'set'
  lockStep = 'pin'
  renderLock()
}

// ---------- 键盘 ----------
function buildKeypad(){
  const box = document.getElementById('keypad')
  if(!box) return
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫']
  box.innerHTML = keys.map(k => {
    if(k === '') return '<button class="key ghost" disabled></button>'
    if(k === '⌫') return '<button class="key ghost" onclick="pinDel()">⌫</button>'
    return '<button class="key" onclick="pinPush(\'' + k + '\')">' + k + '</button>'
  }).join('')
}
function paintDots(){
  const d = document.getElementById('lock-dots')
  if(!d) return
  const n = pinBuf.length
  d.innerHTML = Array.from({length: PIN_LEN}, (_,i) => '<i class="' + (i < n ? 'on' : '') + '"></i>').join('')
}
function pinErr(msg){
  const err = document.getElementById('lock-err')
  if(err) err.innerText = msg
  const dots = document.getElementById('lock-dots')
  if(!dots) return
  dots.classList.add('shake')
  setTimeout(() => dots.classList.remove('shake'), 340)
}
function pinPush(d){
  if(pinBuf.length >= PIN_LEN) return
  pinBuf += d; paintDots()
  const e = document.getElementById('lock-err'); if(e) e.innerText = ''
  if(pinBuf.length === PIN_LEN) setTimeout(submitPin, 130)
}
function pinDel(){ pinBuf = pinBuf.slice(0,-1); paintDots() }

async function submitPin(){
  if(pinMode === 'verify'){
    const ok = await verifyPin(pinBuf)
    if(ok){ pinBuf = ''; unlock() }
    else { pinBuf = ''; paintDots(); pinErr('密码不对') }
    return
  }
  if(pinMode === 'set'){
    pinFirst = pinBuf; pinBuf = ''; pinMode = 'confirm'; renderLock()
    return
  }
  // confirm
  if(pinBuf === pinFirst){
    tmpPin = pinBuf; pinBuf = ''
    if(isResetting){
      isResetting = false
      lockStep = 'recovery'; tmpRecovery = makeRecoveryCode(); renderLock()
      toast('新恢复码已生成，请存好')
    } else {
      lockStep = 'email'; renderLock()
    }
  } else {
    pinBuf = ''; pinFirst = ''; pinMode = 'set'; renderLock(); pinErr('两次不一致，重新设置')
  }
}

async function finishSetup(){
  localStorage.setItem(PIN_KEY, await sha(tmpPin))
  await storeRecovery(tmpRecovery)
  if(tmpEmail) localStorage.setItem(EMAIL_KEY, tmpEmail)
  else localStorage.removeItem(EMAIL_KEY)
  tmpPin = ''
  unlock()
  toast('密码已设置')
}

// ---------- 找回 ----------
function goRecover(){
  lockStep = 'recover'
  pinBuf = ''; pinFirst = ''
  renderLock()
}

async function doRecover(){
  const el  = document.getElementById('lock-input2')
  const err = document.getElementById('lock-err')
  const v = ((el && el.value) || '').trim()
  if(!v){ if(err) err.innerText = '先输入恢复码'; return }
  const ok = await verifyRecovery(v)
  if(!ok){ if(err) err.innerText = '恢复码不对。检查一下字符，连字符可以不用打。'; return }
  isResetting = true
  pinMode = 'set'; pinBuf = ''; pinFirst = ''
  lockStep = 'pin'
  renderLock()
  toast('验证通过，请设置新密码')
}

function doWipePin(){
  localStorage.removeItem(PIN_KEY)
  localStorage.removeItem(RECOV_KEY)
  isResetting = false
  pinMode = 'set'; pinBuf = ''; pinFirst = ''
  lockStep = 'pin'
  renderLock()
  toast('已清空密码，请重设')
}

// 进门之后他有没有动过手 —— 用来决定还要不要自动弹「填同步密钥」。
// 只有进门之后才算数（unlock() 里会清零），否则连输密码那几下也会被算进去。
let appTouched = false
document.addEventListener('pointerdown', () => { appTouched = true }, true)

function unlock(){
  document.getElementById('lock').style.display = 'none'
  document.getElementById('app').style.display  = 'block'
  appTouched = false        // 从「这一刻」开始算他动没动过手（见 unlock 末尾的自动弹层）
  renderBoard(); renderChips(); renderList()
  // 进门就去拉一次云端 —— 客户在别的设备上下的单，这一步才会出现在台账里。
  // 拉失败不影响任何本地功能，只是顶栏会提示。
  cloudLoad()
  renderCloudBar()
  cloudPull(true)
  cloudPollStart()

  // —— 新设备第一次进门：直接弹密钥输入 ——
  // 这是「换个设备登录就看不到单」的唯一原因。原来只靠一条细提示，
  // 很容易被忽略；而只要忽略了，他看到的永远是一份不完整的台账，
  // 却以为「系统坏了」。所以这里主动把这一步推到他面前。
  // 主动断开过同步的设备（CLOUD_SKIP_STORE）不再打扰，只留那条告示。
  let skipped = false
  try { skipped = localStorage.getItem(CLOUD_SKIP_STORE) === '1' } catch(e){}
  if(!cloudKey && !skipped){
    setTimeout(() => {
      if(cloudKey) return
      // ⚠ 他要是已经自己点开了别的面板（正在「新建订单」粘客户信息），就别弹 ——
      // openSheet 是同一个容器，弹出来会**把他正在填的东西直接顶掉**。
      // 这个坑是线上全量测试抓到的：进后台后 700ms 内点「新建订单」，
      // 粘贴框刚出来就被密钥面板替换，`#paste-box` 直接消失。
      const sh = document.getElementById('sheet')
      if(sh && sh.classList.contains('on')) return
      // 同一个道理的更一般情况：进门之后他只要动过手，就说明已经在干活了。
      // 这一刻弹一个「请填密钥」出来，只会打断他 —— 顶栏那条告示一直都在，
      // 他需要的时候自己会点。
      if(appTouched) return
      openCloudKey()
    }, 700)
  }
}

function resetPin(){
  openSheet(`
    <div class="sh-title">重设访问密码</div>
    <div class="sh-sub">会回到锁屏重新设置，并<b style="color:#EF9F27">生成新的恢复码</b>（旧的立刻作废）。<br>
      订单数据不受影响。</div>
    <button class="sh-opt" onclick="doResetPin()">重设密码 + 换新恢复码</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
function doResetPin(){
  localStorage.removeItem(PIN_KEY)
  localStorage.removeItem(RECOV_KEY)
  closeSheet()
  isResetting = false
  initLock()
  toast('请设置新密码')
}

function regenRecovery(){
  const has = !!localStorage.getItem(RECOV_KEY)
  openSheet(`
    <div class="sh-title">重新生成恢复码？</div>
    <div class="sh-sub">${has ? '旧的恢复码立刻作废。' : '你还没设置过恢复码。'}
      弄丢了、或者怀疑被别人看到过，就换一个。</div>
    <button class="sh-opt" onclick="doRegenRecovery()">生成新的恢复码</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
async function doRegenRecovery(){
  const code  = makeRecoveryCode()
  await storeRecovery(code)
  const email = localStorage.getItem(EMAIL_KEY) || ''
  openSheet(`
    <div class="sh-title">新恢复码</div>
    <div class="sh-sub">只显示这一次，现在就存好。</div>
    <div class="lock-code">${esc(code)}</div>
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="copy('${code}')">复制恢复码</button>
    <div class="sh-gap"></div>
    ${email ? `<button class="btn-full grey" onclick="mailRecovery('${code}')">发到 ${esc(email)}</button><div class="sh-gap"></div>` : ''}
    <button class="btn-full grey" onclick="closeSheet()">我存好了</button>
  `)
}

function editEmail(){
  const cur = localStorage.getItem(EMAIL_KEY) || ''
  openSheet(`
    <div class="sh-title">恢复邮箱</div>
    <div class="sh-sub">只用来把恢复码发给你，不做别的。留空就不发。</div>
    <input class="input" id="email-input" type="email" inputmode="email"
           placeholder="你的邮箱" value="${esc(cur)}" autocomplete="off">
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="saveEmail()">保存</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">取消</button>
  `)
  setTimeout(() => { const i = document.getElementById('email-input'); if(i) i.focus() }, 280)
}
function saveEmail(){
  const v = (document.getElementById('email-input').value || '').trim()
  if(v) localStorage.setItem(EMAIL_KEY, v); else localStorage.removeItem(EMAIL_KEY)
  closeSheet()
  toast(v ? '已登记 ' + v : '已清除邮箱')
}

// ==================== 看板 ====================
function renderBoard(){
  const list = allOrders()
  const unpaid = list.filter(o => o.pay_status !== 'paid').length
  const toStart = list.filter(o => o.status === 'paid').length
  const drawing = list.filter(o => o.status === 'drawing').length
  const lookup  = list.filter(needLookup).length
  const income = list.filter(o => o.pay_status === 'paid').length * PRICE

  const tile = (num, label, cls, filter) =>
    `<button class="tile ${cls} ${num === 0 ? 'zero' : ''}" onclick="quickFilter('${filter}')">
       <div class="tile-num">${num}</div><div class="tile-label">${label}</div>
     </button>`

  document.getElementById('board').innerHTML =
    tile(unpaid, '待收款', unpaid > 0 ? 'alert' : '', 'unpaid') +
    tile(toStart, '待开工', '', 'paid') +
    tile(drawing, '绘制中', '', 'drawing') +
    tile('¥' + income, '累计收款', 'good', 'all') +
    tile(lookup, '待查地址', lookup > 0 ? 'alert' : '', 'lookup')
}

function quickFilter(key){
  filterKey = key
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.f === key))
  renderList()
  document.getElementById('kw').scrollIntoView({ behavior:'smooth', block:'center' })
}

// ==================== 快速对账 ====================
function doReconcile(){
  const box = document.getElementById('recon')
  const out = document.getElementById('recon-result')
  const t = box.value.trim().toUpperCase()
  if(t.length !== 4){ out.innerHTML = '<div class="hint" style="color:#EF9F27">请输入 4 位字母/数字</div>'; return }

  const list = allOrders()
  const hits = list.filter(o => tail(o.order_no) === t)
  if(!hits.length){
    const tails = list.map(o => tail(o.order_no))
    const shown = tails.slice(0, 12)
    const synced = cloudOn() && !cloudErr
    out.innerHTML =
      '<div class="hint" style="color:#EF9F27; line-height:1.85">'
      + '台账里没有尾号 <b>' + esc(t) + '</b>。<br>'
      + (list.length
          ? '现有尾号：<br><b style="letter-spacing:1px">'
            + shown.map(esc).join('　') + (tails.length > shown.length ? ' …' : '') + '</b><br>'
          : '<b>这台设备上一条订单都没有。</b><br>')
      + (synced
          ? '同步是通的，所以这单<b>确实还没进服务端</b> —— 让客户把订单信息发你，用「新建订单」补录。'
          : '<b>注意：这台设备此刻没接通云端同步</b>，你看到的不一定是全部订单。先点下面看诊断。')
      + '</div>'
      + '<button class="btn-full grey" style="margin-top:10px" onclick="closeSheet();openCloudDiag()">看云端同步诊断 ›</button>'
    return
  }
  const o = hits[0]
  const paid = o.pay_status === 'paid'
  out.innerHTML = `
    <div style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,.08);">
      <div class="d-row"><div class="d-key">订单号</div><div class="d-val">${esc(o.order_no)}</div></div>
      <div class="d-row"><div class="d-key">艺人</div><div class="d-val">${esc(o.artist)}</div></div>
      <div class="d-row"><div class="d-key">金额</div><div class="d-val">¥${PRICE}</div></div>
      <div class="d-row"><div class="d-key">收款</div>
        <div class="d-val" style="color:${paid ? '#5DCAA5' : '#EF9F27'}">${paid ? '已确认收款' : '还没标记收款'}</div></div>
      ${paid
        ? '<div class="hint" style="color:#5DCAA5">这单已经标记过了</div>'
        : `<button class="btn-full" style="margin-top:10px" onclick="markPaid('${o.id}', true)">✓ 确认收到 ¥${PRICE}</button>`}
    </div>`
}

// ==================== 本机台账状态 · 自检 ====================
// 订单只存在「下单那台设备的那个浏览器」里。
// 查不到时，九成不是 bug，是设备 / 浏览器 / 网址对不上。
// 所以这里做两件事：① 一眼看出本机有几单 ② 点尾号直接查。

function renderLocalStrip(){
  const el = document.getElementById('local-strip')
  if(!el) return
  const list = allOrders().sort((a,b) => (b.created_at || 0) - (a.created_at || 0))

  if(!list.length){
    el.innerHTML = '<div class="strip-empty">本机台账 <b>0</b> 单 · 这台设备上还没有任何订单</div>'
    return
  }
  const shown = list.slice(0, 10)
  el.innerHTML =
    '<div class="strip-head"><span>本机台账 <b>' + list.length + '</b> 单 · 点尾号直接查</span>'
    + '<button class="strip-info" onclick="showSelfCheck()">自检</button></div>'
    + '<div class="strip-tails">'
    + shown.map(o =>
        '<button class="tail-chip" onclick="fillRecon(\'' + tail(o.order_no) + '\')">'
        + esc(tail(o.order_no)) + '</button>').join('')
    + (list.length > shown.length
        ? '<span class="strip-more">还有 ' + (list.length - shown.length) + ' 单</span>' : '')
    + '</div>'
}

function fillRecon(t){
  const box = document.getElementById('recon')
  if(!box) return
  box.value = t
  doReconcile()
  const out = document.getElementById('recon-result')
  if(out) setTimeout(() => out.scrollIntoView({ behavior:'smooth', block:'center' }), 90)
}

function showSelfCheck(){
  const list = allOrders()
  const on = cloudOn()
  openSheet(`
    <div class="sh-title">本机自检</div>
    <div class="sh-sub">查不到订单时先看这里。现在有云端同步了，九成问题出在<b>同步没接通</b>，而不是设备或网址。</div>

    <div class="chk-row"><div class="chk-key">云端同步</div><div class="chk-val">${
      !window.Cloud || !Cloud.on() ? '<b style="color:#E24B4A">未配置地址</b>'
      : (!cloudKey ? '<b style="color:#EF9F27">未填密钥 · 只能看到本机</b>'
        : (cloudErr ? '<b style="color:#E24B4A">失败：' + esc(cloudErr) + '</b>'
          : '<b style="color:#5DCAA5">已开启 · ' + (cloudAt ? agoText(cloudAt) : '还没同步过') + '</b>'))
    }</div></div>
    <div class="chk-row"><div class="chk-key">云端台账</div><div class="chk-val">${
      cloudTotal >= 0 ? cloudTotal + ' 单' : '未知'
    }</div></div>
    <div class="chk-row"><div class="chk-key">本机台账</div><div class="chk-val">${list.length} 单</div></div>
    <div class="chk-row"><div class="chk-key">后台域名</div><div class="chk-val mono">${esc(location.hostname)}</div></div>
    <div class="chk-row"><div class="chk-key">现有尾号</div><div class="chk-val mono">${
      list.length ? list.slice(0, 12).map(o => esc(tail(o.order_no))).join(' ') : '（无）'
    }</div></div>

    <div class="sh-gap"></div>
    <button class="btn-full" onclick="closeSheet();openCloudDiag()">云端同步诊断（看服务端收到了什么）</button>
    ${!on || !cloudKey ? '<div class="sh-gap"></div><button class="btn-full" onclick="closeSheet();openCloudKey()">填同步密钥 · 让客户的单进来</button>' : ''}

    <div class="hint" style="margin-top:15px; line-height:1.85">
      <b>只要云端同步是通的</b>，客户在他自己手机上下单，就会自动出现在这里 ——
      不管你现在用的是哪台设备。<br><br>
      同步<b>没通</b>的时候，订单才会只留在下单那台设备上。这时有三种可能：<br>
      ① 这台设备没填过同步密钥（<b>换手机 / 换浏览器 / 清过缓存，都要重填一次</b>）<br>
      ② 网络不通 —— 页面上会写「同步失败」，重试即可<br>
      ③ 客户下单那一刻网络抖了 —— 订单会排进补推队列，网络恢复后自动补上<br><br>
      无论哪种情况，兜底通道一直都在：让客户点他页面上的「复制下单信息」发给你，
      你用上面的「新建订单」粘进来。
    </div>

    <div class="sh-gap"></div>
    <button class="btn-full" onclick="copySelfCheck()">复制这段诊断信息</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">知道了</button>
  `)
}

function copySelfCheck(){
  const list = allOrders()
  copy([
    '【接单台账 · 本机自检】',
    '云端同步：' + (!window.Cloud || !Cloud.on() ? '未配置地址'
      : (!cloudKey ? '未填密钥' : (cloudErr ? '失败(' + cloudErr + ')' : '已开启'))),
    '云端台账：' + (cloudTotal >= 0 ? cloudTotal + ' 单' : '未知'),
    '同步地址：' + ((window.Cloud && Cloud.base) ? Cloud.base() : '-'),
    '本机台账：' + list.length + ' 单',
    '后台域名：' + location.hostname,
    '现有尾号：' + (list.length ? list.slice(0, 20).map(o => tail(o.order_no)).join(' ') : '无'),
    '时间：' + new Date().toLocaleString('zh-CN'),
  ].join('\n'))
}

// ==================== 收款台 · 粘贴对账 ====================
// 思路：不去猜「什么样的字符串算订单号」，而是反过来——
// 拿台账里**真实存在的尾号**去文本里找。认出来的必然是对的，零误判。

let reconHits = []          // 本次识别出的尾号
let reconSel  = new Set()   // 勾选了哪几个（台账里已有的）
let reconNew  = []          // 文本里有完整下单信息、但台账里还没有的单
let reconNewSel = new Set() // 勾选了哪几个（待建的）

function scanTails(text){
  const src = String(text || '')
  const found = [], seen = new Set()

  // ① 先认完整订单号（AL + 8位日期 + 6位），最精确
  const reFull = /AL\s?\d{8}\s?([A-Za-z0-9]{6})/gi
  let m
  while((m = reFull.exec(src))){
    const t = m[1].slice(-4).toUpperCase()
    if(!seen.has(t)){ seen.add(t); found.push(t) }
  }

  // ② 再逐个拿台账里的尾号去文本里比对（避免把金额、日期误当成尾号）
  allOrders().forEach(o => {
    const t = tail(o.order_no)
    if(!t || t.length < 4 || seen.has(t)) return
    const re = new RegExp('(^|[^A-Za-z0-9])' + t + '([^A-Za-z0-9]|$)', 'i')
    if(re.test(src)){ seen.add(t); found.push(t) }
  })

  return found
}

function openReconPaste(){
  reconHits = []; reconSel = new Set(); reconNew = []; reconNewSel = new Set()
  openSheet(`
    <div class="sh-title">粘贴对账</div>
    <div class="sh-sub">把客户发来的消息、或微信账单里那段文字，整段粘进来。<br>
      台账里有的直接认款；<b>台账里没有但信息齐全的，我直接给你建单</b>。</div>
    <textarea class="sh-textarea" id="recon-paste" placeholder="【艺人代寄 · 下单信息】&#10;订单号：AL20261003A7K2&#10;艺人：Johnny Depp&#10;…"></textarea>
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="runPasteRecon()">开始识别</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">取消</button>
    <div id="recon-out"></div>
  `)
  setTimeout(() => { const ta = document.getElementById('recon-paste'); if(ta) ta.focus() }, 320)
}

function runPasteRecon(){
  const ta  = document.getElementById('recon-paste')
  const out = document.getElementById('recon-out')
  const text = ((ta && ta.value) || '').trim()
  if(!text){ toast('先把内容粘进来'); return }
  reconHits   = scanTails(text)
  reconSel    = new Set()
  reconNew    = []
  reconNewSel = new Set()

  // 关键一步：客户整段发来的信息，本身就是一张完整的单。
  // 台账里没有 = 这单是他在**自己手机上**下的，我这边从来没收到过 ——
  // 以前这里只会显示「这个尾号不在台账里」，然后就没有下文了，单就丢在这。
  const list = allOrders()
  splitOrderBlocks(text).forEach(block => {
    const p = parseOrderText(block)
    if(!p.order_no || !p.artist) return                       // 缺订单号或艺人，建不出单
    if(list.some(o => o.order_no === p.order_no)) return      // 已在台账
    const t = tail(p.order_no)
    if(list.some(o => tail(o.order_no) === t)) return         // 尾号撞了，当作已有，不重复建
    if(reconNew.some(x => tail(x.order_no) === t)) return
    reconNew.push(p)
  })
  reconNew.forEach(p => reconNewSel.add(tail(p.order_no)))    // 默认全部勾上

  if(!reconHits.length && !reconNew.length){
    const n = allOrders().length
    out.innerHTML =
      '<div class="hint" style="color:#EF9F27; line-height:1.8; margin-top:16px">'
      + '这段文字里没认出订单号。<br>'
      + '① 客户发来的信息里带订单号吗？没有的话，让他点他页面上的「复制下单信息」再发一次。<br>'
      + '② 这一单录进台账了吗？没录过的话，把客户发来的整段粘进来就行 —— 带「订单号：」的那种。<br>'
      + '台账目前共 <b>' + n + '</b> 单。</div>'
    revealRecon()
    return
  }

  // 默认勾选「还没收款」的，已收款的不重复勾
  reconHits.forEach(t => {
    const o = list.find(x => tail(x.order_no) === t)
    if(o && o.pay_status !== 'paid') reconSel.add(t)
  })
  paintRecon()
  revealRecon()
}

// 结果和「确认」按钮在粘贴框下面，识别完直接滚过去 ——
// 客户一次发两条的时候，结果会长到把按钮顶到屏幕外面，不滚过去会以为没反应。
// 只在「点了开始识别」之后滚，勾选框的每次重绘都不滚（否则点一下就跳一下）。
function revealRecon(){
  const out = document.getElementById('recon-out')
  if(!out || !out.scrollIntoView) return
  setTimeout(() => { try { out.scrollIntoView({ behavior:'smooth', block:'start' }) } catch(e){} }, 60)
}

function paintRecon(){
  const list = allOrders()
  const out  = document.getElementById('recon-out')

  // ① 台账里已有的：认出多少算多少
  const known = reconHits.filter(t => list.some(o => tail(o.order_no) === t))
  const rows = known.map(t => {
    const o = list.find(x => tail(x.order_no) === t)
    const paid = o.pay_status === 'paid'
    const on   = !paid && reconSel.has(t)
    return '<div class="rc-row ' + (paid ? 'off' : '') + '"'
      + (paid ? '' : ' onclick="toggleRecon(\'' + t + '\')"') + '>'
      + '<div class="rc-box ' + (paid ? 'done' : (on ? 'on' : '')) + '">' + (on || paid ? '✓' : '') + '</div>'
      + '<div class="rc-body">'
      + '<div class="rc-no">' + esc(t) + ' <small>' + esc(o.artist || '未填艺人') + '</small></div>'
      + '<div class="rc-meta">' + esc(o.customer_name || '未填称呼') + ' · ' + fmt(o.created_at) + ' 下单'
      + (paid ? ' · <span style="color:#5DCAA5">已收款</span>' : '') + '</div>'
      + '</div></div>'
  }).join('')

  // ② 台账里没有、但客户把整段发来了 —— 可以直接建单
  const freshRows = reconNew.map(p => {
    const t  = tail(p.order_no)
    const on = reconNewSel.has(t)
    return '<div class="rc-row rc-new ' + (on ? '' : 'off') + '" onclick="toggleReconNew(\'' + t + '\')">'
      + '<div class="rc-box ' + (on ? 'on' : '') + '">' + (on ? '✓' : '') + '</div>'
      + '<div class="rc-body">'
      + '<div class="rc-no">' + esc(t) + ' <small>' + esc(p.artist) + '</small></div>'
      + '<div class="rc-meta">' + esc(p.country || '未填国家')
      + (p.customer_name ? ' · ' + esc(p.customer_name) : '')
      + ' · <span style="color:#EF9F27">台账里还没有，会新建</span></div>'
      + '</div></div>'
  }).join('')

  const nOld = reconSel.size, nNew = reconNewSel.size, n = nOld + nNew

  // 台账里已有的那一段。三种情况必须分开，含糊过去就是把线索吞掉：
  //   ① 有已存在的 → 正常列出来
  //   ② 一个都没有、但客户发了整段 → 不显示这一段（下面「可以建单」已经说明了）
  //   ③ 一个都没有、客户也没发整段 → 老实说「不在台账里」，并给出下一步
  let knownHtml
  if(known.length){
    knownHtml = '<div class="rc-list">' + rows + '</div>'
  } else if(!reconNew.length){
    knownHtml = '<div class="rc-list">' + reconHits.map(t =>
      '<div class="rc-row off"><div class="rc-box">?</div><div class="rc-body">'
      + '<div class="rc-no">' + esc(t) + '</div>'
      + '<div class="rc-meta">这个尾号不在台账里</div></div></div>').join('') + '</div>'
      + '<div class="hint">这单是客户在他自己手机上下的，我这边没有。<br>'
      + '让他把整段「下单信息」发给你，<b>整段粘进来我就能直接建单</b>。</div>'
  } else {
    knownHtml = ''
  }

  out.innerHTML =
    '<div class="rc-head">认出 ' + Math.max(reconHits.length, reconNew.length) + ' 个订单号'
    + (reconNew.length ? ' · 其中 ' + reconNew.length + ' 单台账里还没有' : '') + '</div>'
    + knownHtml
    + (reconNew.length
        ? '<div class="rc-head" style="margin-top:14px">可以建单（信息齐全）</div>'
          + '<div class="rc-list">' + freshRows + '</div>'
        : '')
    + (n
        ? '<button class="btn-full" onclick="confirmRecon()">✓ 确认这 ' + n + ' 笔收款 · ¥' + n * PRICE + '</button>'
          + (nNew ? '<div class="hint">其中 <b>' + nNew + ' 单</b>会先建单、再标记已收款</div>' : '')
        : '<div class="hint" style="color:#5DCAA5">认出来的单都已经确认过收款了</div>')
}

function toggleRecon(t){
  if(reconSel.has(t)) reconSel.delete(t); else reconSel.add(t)
  paintRecon()
}

function toggleReconNew(t){
  if(reconNewSel.has(t)) reconNewSel.delete(t); else reconNewSel.add(t)
  paintRecon()
}

function confirmRecon(){
  const list = allOrders()          // 只用于查单，不用于写回（见下面的 fresh）
  let n = 0, made = 0
  // ① 台账里已有的 → 只改收款状态
  reconSel.forEach(t => {
    const o = list.find(x => tail(x.order_no) === t)
    if(!o || o.pay_status === 'paid') return
    updOrder(o.id, { pay_status:'paid', status: o.status === 'created' ? 'paid' : o.status })
    log(o.id, '确认收款 ¥' + PRICE + '（粘贴对账）')
    n++
  })
  // ② 台账里没有的 → 用客户发来的整段建单。
  // 勾在这里意味着钱已经到账（他是在核对收款时才粘的），所以直接落成已收款。
  const fresh = reconNew.filter(p => reconNewSel.has(tail(p.order_no)))
  if(fresh.length){
    // 必须**重新读一次**：上面 updOrder/log 每次都自己重写整个数组，
    // 拿最开始那份 list 写回去，会把刚标记的收款状态全部抹掉。
    const cur = allOrders()
    fresh.forEach(p => cur.push(orderFromParsed(p, { paid:true, why:'从客户发来的信息建单 · 粘贴对账' })))
    saveOrders(cur)
    made = fresh.length; n += fresh.length
  }
  closeSheet()
  toast(made ? ('新建 ' + made + ' 单 · 确认 ' + n + ' 笔 · ¥' + n * PRICE)
             : ('已确认 ' + n + ' 笔 · ¥' + n * PRICE))
  renderList()
}

// ==================== 新建订单（粘贴客户信息） ====================
const FIELD_MAP = {
  订单号:'order_no', 艺人:'artist', 收信国家:'country', 收信地址:'recipient_addr',
  我的称呼:'customer_name', 手机号:'customer_phone', 回信地址:'return_addr', 备注:'letter_note',
  下单时间:'placed_at',
}

// 占位符不是内容：'-'、'（未填）'、'（客户未填…）' 都要还原成空字符串，
// 否则「地址待查」的单会被一个假地址糊过去，待办就销不掉。
function dePlaceholder(v){
  const s = String(v || '').trim()
  if(!s || s === '-') return ''
  return /^[（(][^）)]*[）)]$/.test(s) ? '' : s
}

function parseOrderText(text){
  const o = {}
  String(text || '').split('\n').forEach(line => {
    const m = /^\s*(.+?)\s*[:：]\s*(.*)\s*$/.exec(line)
    if(!m) return
    const key = m[1].replace(/^【|】$/g,'').trim()
    const val = m[2].trim()
    if(FIELD_MAP[key]) o[FIELD_MAP[key]] = dePlaceholder(val)
    if(key === '信的来源') o.letter_source = val.indexOf('代写') >= 0 ? 'proxy' : 'self'
    // 注意：「不需要」里含「需要」，必须先排掉否定式，否则非代查单会被误判成代查单
    if(key === '地址代查') o.addr_lookup = val.indexOf('不需要') < 0 && val.indexOf('需要') >= 0
  })
  // 把「下单时间」还原成时间戳。还原不出来就留空，交给 orderFromParsed 兜到当前时间。
  if(o.placed_at){
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(o.placed_at)
    if(m) o.created_at = new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]).getTime()
    delete o.placed_at
  }
  return o
}

// 一段文字里可能有好几单（客户连着发、或者一次转发多条）。
// 按块切开，才能一单一条地判断「在不在台账里」。
function splitOrderBlocks(text){
  const src = String(text || '').replace(/\r/g, '')
  const HEAD = '【艺人代寄 · 下单信息】'
  if(src.indexOf(HEAD) >= 0){
    return src.split(HEAD).slice(1)                       // 第一段是块头之前的废话
      .map(p => HEAD + p)
      .filter(p => /订单号\s*[:：]/.test(p))
  }
  return /订单号\s*[:：]/.test(src) ? [src] : []
}

// 订单对象的唯一构造点。
// 建单路径现在有两条（手填、从粘贴文本建单），字段列表写两份迟早漏字段 ——
// 而且漏的往往是「地址待查」这种不显眼的开关。
function orderFromParsed(p, opts){
  opts = opts || {}
  const paid = !!opts.paid
  // 客户设备的钟可能不准：超前的、或者久到不合理的，一律不信，用当前时间。
  const now = Date.now()
  const ts = (p.created_at && p.created_at <= now + 60000 && p.created_at > now - 90*86400000)
    ? p.created_at : now
  return {
    id: `${now}-${Math.floor(Math.random()*1e6)}`,
    order_no: p.order_no || makeOrderNo(),
    artist: p.artist || '',
    country: p.country || '',
    recipient_addr: p.recipient_addr || '',
    addr_lookup: !!p.addr_lookup,
    customer_name: p.customer_name || '',
    customer_phone: p.customer_phone || '',
    return_addr: p.return_addr || '',
    letter_source: p.letter_source === 'proxy' ? 'proxy' : 'self',
    letter_note: p.letter_note || '',
    status: paid ? 'paid' : 'created',
    pay_status: paid ? 'paid' : 'unpaid',
    admin_note: '', media: [],
    logs: [{ at: now, text: opts.why || '手工建单' }],
    created_at: ts,
    updated_at: now,
  }
}

function makeOrderNo(){
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for(let i = 0; i < 6; i++) out += C[Math.floor(Math.random()*C.length)]
  const d = new Date(), p = n => String(n).padStart(2,'0')
  return `AL${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${out}`
}

let draft = {}

function openNewOrder(){
  draft = { order_no: makeOrderNo(), letter_source: 'self' }
  openSheet(`
    <div class="sh-title">新建订单</div>
    <div class="sh-sub">让客户点一下他页面上的「复制下单信息」，把整段发给你，粘到这里自动识别</div>
    <textarea class="sh-textarea" id="paste-box" placeholder="【艺人代寄 · 下单信息】&#10;订单号：AL20261003ABCD&#10;艺人：Johnny Depp&#10;收信国家：United States&#10;收信地址：...&#10;手机号：...&#10;回信地址：..."></textarea>
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="parsePaste()">识别并继续</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="renderOrderForm({})">跳过粘贴 · 直接手填</button>
  `)
}

function parsePaste(){
  const text = (document.getElementById('paste-box').value || '').trim()
  if(!text){ toast('先粘贴客户发来的信息'); return }
  const parsed = parseOrderText(text)
  if(!parsed.artist && !parsed.recipient_addr && !parsed.phone){
    toast('没识别出内容，改用「直接手填」')
  }
  renderOrderForm(parsed)
}

function renderOrderForm(data){
  draft = Object.assign({ order_no: draft.order_no || makeOrderNo(), letter_source: 'self' }, data)
  const row = (id, label, val, ph) =>
    `<div class="mini-field"><div class="mini-label">${label}</div>
       <input class="input" id="${id}" value="${esc(val || '')}" placeholder="${ph || ''}"></div>`

  openSheet(`
    <div class="sh-title">确认订单信息</div>
    <div class="sh-sub">核对一下，缺的可以补。带 * 的必填。</div>
    <div class="mini-field"><div class="mini-label">订单号</div>
      <input class="input" id="n-order" value="${esc(draft.order_no || '')}">
      <div class="mini-hint">客户已经下过单的话，把他那串原样填进来 —— 改了尾号就对不上了</div>
    </div>
    ${row('n-artist','艺人 *', draft.artist, '例如 Johnny Depp')}
    ${row('n-country','收信国家', draft.country, '例如 United States')}
    <div class="mini-field"><div class="mini-label">收信地址</div>
      <textarea class="sh-textarea" id="n-recipient" style="min-height:76px" placeholder="艺人工作室 / Fan mail 地址">${esc(draft.recipient_addr || '')}</textarea>
      <div class="mini-hint">客户委托我查地址的话，这里可以先留空 —— 查到了再回来补</div></div>
    <div class="mini-field"><div class="mini-label">地址代查</div>
      <select class="input" id="n-lookup">
        <option value="no">不需要 · 客户已给地址，直接寄</option>
        <option value="yes">地址待查 · 我负责查这位艺人最新的收信地址</option>
      </select></div>
    ${row('n-name','客户称呼', draft.customer_name)}
    ${row('n-phone','客户手机 / 微信', draft.customer_phone)}
    <div class="mini-field"><div class="mini-label">回信地址</div>
      <textarea class="sh-textarea" id="n-return" style="min-height:76px" placeholder="客户的中文回信地址">${esc(draft.return_addr || '')}</textarea></div>
    <div class="mini-field"><div class="mini-label">信件来源</div>
      <select class="input" id="n-src">
        <option value="self">客户自己手写</option>
        <option value="proxy">需要代写（费用另议）</option>
      </select></div>
    <div class="mini-field"><div class="mini-label">客户备注</div>
      <textarea class="sh-textarea" id="n-note" style="min-height:66px" placeholder="想要的元素、配色、想避开的">${esc(draft.letter_note || '')}</textarea></div>
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="saveNewOrder()">存入台账</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">取消</button>
  `)
  setTimeout(() => {
    const sel = document.getElementById('n-src')
    if(sel) sel.value = draft.letter_source || 'self'
    const lk = document.getElementById('n-lookup')
    if(lk) lk.value = draft.addr_lookup ? 'yes' : 'no'
  }, 40)
}

function saveNewOrder(){
  const artist = (document.getElementById('n-artist').value || '').trim()
  if(!artist){ toast('艺人姓名必填'); return }
  const order = orderFromParsed({
    order_no: (document.getElementById('n-order').value || '').trim() || makeOrderNo(),
    artist,
    country: document.getElementById('n-country').value.trim(),
    recipient_addr: document.getElementById('n-recipient').value.trim(),
    addr_lookup: document.getElementById('n-lookup').value === 'yes',
    customer_name: document.getElementById('n-name').value.trim(),
    customer_phone: document.getElementById('n-phone').value.trim(),
    return_addr: document.getElementById('n-return').value.trim(),
    letter_source: document.getElementById('n-src').value,
    letter_note: document.getElementById('n-note').value.trim(),
    // 客户发来的整段里带「下单时间」时，用真实下单时间，而不是我补录的时间
    created_at: draft.created_at,
  }, { paid:false, why:'手工建单' })
  const list = allOrders(); list.push(order); saveOrders(list)
  closeSheet()
  filterKey = 'all'
  renderList()
  toast('已存入台账 · 尾号 ' + tail(order.order_no))
}

// ==================== 筛选 / 列表 ====================
let filterKey = 'all'
const openIds = new Set()   // 记住哪些订单卡是展开的，重渲染后不塌回去
const CHIPS = [
  { f:'all',     label:'全部' },
  { f:'unpaid',  label:'待收款' },
  { f:'lookup',  label:'待查地址' },
  { f:'paid',    label:'待开工' },
  { f:'drawing', label:'绘制中' },
  { f:'mailed',  label:'已寄出' },
  { f:'done',    label:'已完成' },
]

function countOf(f){
  const list = allOrders()
  if(f === 'all')     return list.length
  if(f === 'unpaid')  return list.filter(o => o.pay_status !== 'paid').length
  if(f === 'lookup')  return list.filter(needLookup).length
  return list.filter(o => o.status === f).length
}

function renderChips(){
  document.getElementById('chips').innerHTML = CHIPS.map(c => {
    const n = countOf(c.f)
    return `<button class="chip ${c.f === filterKey ? 'on' : ''}" data-f="${c.f}" onclick="setFilter('${c.f}')">
      ${c.label}<b>${n}</b></button>`
  }).join('')
}
function setFilter(f){
  filterKey = f
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.f === f))
  renderList()
}

function match(o, kw){
  if(!kw) return true
  const no = (o.order_no || '').toUpperCase()
  return tail(o.order_no) === kw || no.indexOf(kw) >= 0 ||
         (o.artist || '').toUpperCase().indexOf(kw) >= 0 ||
         (o.customer_phone || '').indexOf(kw) >= 0 ||
         (o.customer_name || '').toUpperCase().indexOf(kw) >= 0
}

function renderList(){
  renderBoard(); renderChips(); renderLocalStrip(); renderBackupNudge(); renderCloudBar()
  const kw = (document.getElementById('kw').value || '').trim().toUpperCase()

  let list = allOrders().sort((a,b) => (b.created_at || 0) - (a.created_at || 0))
  if(filterKey === 'unpaid')      list = list.filter(o => o.pay_status !== 'paid')
  else if(filterKey === 'lookup') list = list.filter(needLookup)
  else if(filterKey !== 'all')    list = list.filter(o => o.status === filterKey)
  if(kw) list = list.filter(o => match(o, kw))

  const box = document.getElementById('list')
  const empty = document.getElementById('empty')

  if(!list.length){
    box.innerHTML = ''
    empty.style.display = 'block'
    empty.querySelector('.empty-title').innerText = allOrders().length ? '没有匹配的订单' : '台账还是空的'
    empty.querySelector('.empty-sub').innerText   = allOrders().length ? '换个筛选条件，或清空搜索词' : '客户发来下单信息后，点上面的「新建订单」粘进来'
    return
  }
  empty.style.display = 'none'
  box.innerHTML = list.map(orderCard).join('')
}

function orderCard(o){
  const paid = o.pay_status === 'paid'
  const cls = o.status === 'done' ? 'done' : (paid ? 'paid' : 'unpaid')
  const media = Array.isArray(o.media) ? o.media : []
  const logs  = Array.isArray(o.logs)  ? o.logs  : []
  const lookup = needLookup(o)
  const addrText = String(o.recipient_addr || '').trim()
  // 「刚进来」和「有更新」是两件事，标签必须分开 ——
  // 客户新下的单你要去接，别人改过的进度你要去核，动作不一样。
  const isNew = freshNos.has(o.order_no)
  const isUpd = !isNew && updNos.has(o.order_no)
  const mark  = isNew || isUpd

  return `
  <div class="order ${cls} ${openIds.has(o.id) ? 'open' : ''} ${mark ? 'fresh' : ''}" id="od-${o.id}">
    <div class="o-top" onclick="toggle('${o.id}')">
      <div>
        <div class="o-no">${esc(tail(o.order_no))}<small>${esc(o.order_no)}</small></div>
        <div class="o-artist">${esc(o.artist || '（未填艺人）')}${mark ? ` <span class="o-new">${isNew ? '刚进来' : '有更新'}</span>` : ''}</div>
      </div>
      <div class="o-tags">
        <span class="tag ${paid ? 'green' : 'amber'}">${paid ? '已收款' : '待收款'}</span>
        <span class="tag sage">${statusLabel(o.status)}</span>
        ${lookup ? '<span class="tag amber">地址待查</span>'
                 : (o.addr_lookup ? '<span class="tag sage">代查地址</span>' : '')}
      </div>
    </div>

    <div class="o-meta">
      ${esc(o.customer_name || '未填称呼')} · ${esc(o.customer_phone || '无电话')}<br>
      ${fmt(o.created_at)} 下单 · ${o.country ? esc(o.country) : '未填国家'}
    </div>

    <div class="o-detail">
      <div class="d-row"><div class="d-key">收信地址</div><div class="d-val">${
        addrText ? esc(addrText)
        : (o.addr_lookup ? '<b style="color:#EF9F27">待查 · 客户委托我查最新地址</b>' : '-')
      }</div></div>
      <div class="d-row"><div class="d-key">回信地址</div><div class="d-val">${esc(o.return_addr || '-')}</div></div>
      <div class="d-row"><div class="d-key">信件来源</div><div class="d-val">${o.letter_source === 'proxy' ? '需要代写（费用另议）' : '客户自己手写'}</div></div>
      ${o.letter_note ? `<div class="d-note"><b style="color:#8a8a82">客户备注：</b><br>${esc(o.letter_note)}</div>` : ''}
      ${o.admin_note ? `<div class="d-note"><b style="color:#8a8a82">我的留言：</b><br>${esc(o.admin_note)}</div>` : ''}

      ${media.length ? `
        <div class="d-row" style="margin-top:10px"><div class="d-key">凭证</div>
          <div class="d-val">${media.filter(m => m.kind === 'image').length} 张图 · ${media.filter(m => m.kind === 'video').length} 段视频</div>
        </div>
        <div class="sh-preview">
          ${media.filter(m => m.kind === 'image').map(m => `<img src="${m.path}" onclick="viewImage('${m.path}')">`).join('')}
          ${media.filter(m => m.kind === 'video').map(m => `<video src="${m.path}" style="width:74px;height:74px;border-radius:9px;object-fit:cover" controls playsinline></video>`).join('')}
        </div>` : ''}

      ${logs.length ? `
        <div class="d-row" style="margin-top:10px"><div class="d-key">操作记录</div>
          <div class="d-val">${logs.slice(-4).map(l => `${fmt(l.at)} ${esc(l.text)}`).join('<br>')}</div>
        </div>` : ''}

      <div class="o-ops">
        ${!paid ? `<button class="op primary" onclick="markPaid('${o.id}')">✓ 确认收款</button>` : ''}
        <button class="op ${lookup ? 'primary' : ''}" onclick="sheetAddr('${o.id}')">${lookup ? '📍 补地址' : '改地址'}</button>
        <button class="op" onclick="sheetStatus('${o.id}')">改状态</button>
        <button class="op" onclick="sheetNote('${o.id}')">留言</button>
        <button class="op" onclick="sheetMedia('${o.id}')">存凭证</button>
        <button class="op" onclick="copyFull('${o.id}')">复制全单</button>
        <button class="op" onclick="copyShip('${o.id}')">复制寄件地址</button>
        <button class="op danger" onclick="sheetDelete('${o.id}')">删除</button>
      </div>
    </div>
  </div>`
}

function toggle(id){
  const el = document.getElementById('od-' + id)
  if(!el) return
  // 只要点过这张卡就算「看见了」—— 不管这一次是展开还是收起。
  // 高亮的唯一作用是把人引到这张卡上；引到了就该撤，否则它会一直亮着变成噪音。
  clearFresh(id, el)
  el.classList.toggle('open')
  el.classList.contains('open') ? openIds.add(id) : openIds.delete(id)
}

function clearFresh(id, el){
  const o = getOrder(id)
  if(!o) return
  const had = freshNos.has(o.order_no) || updNos.has(o.order_no)
  if(!had) return
  freshNos.delete(o.order_no)
  updNos.delete(o.order_no)
  el.classList.remove('fresh')
  const badge = el.querySelector('.o-new')
  if(badge) badge.remove()
}

// ==================== 订单操作 ====================
function markPaid(id, fromRecon){
  const o = getOrder(id); if(!o) return
  const next = o.status === 'created' ? 'paid' : o.status
  updOrder(id, { pay_status:'paid', status: next })
  log(id, '确认收款 ¥' + PRICE)
  toast('已确认收款')
  if(fromRecon){
    document.getElementById('recon-result').innerHTML = '<div class="hint" style="color:#5DCAA5">✓ 已标记收款，可以开始安排了</div>'
    document.getElementById('recon').value = ''
  }
  renderList()
}

function sheetStatus(id){
  const o = getOrder(id); if(!o) return
  const cur = o.status
  openSheet(`
    <div class="sh-title">改状态</div>
    <div class="sh-sub">${esc(o.artist || '')} · 尾号 ${esc(tail(o.order_no))}</div>
    ${STATUS_FLOW.map(s => `
      <button class="sh-opt ${s.key === cur ? 'on' : ''}" onclick="setStatus('${id}','${s.key}')">
        ${s.label}${s.key === cur ? ' · 当前' : ''}<small>${s.hint}</small>
      </button>`).join('')}
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
function setStatus(id, key){
  const o = getOrder(id)
  updOrder(id, { status: key })
  if(key !== 'created' && o && o.pay_status !== 'paid') updOrder(id, { pay_status:'paid' })
  log(id, '状态 → ' + statusLabel(key))
  closeSheet(); toast('已改为「' + statusLabel(key) + '」'); renderList()
}

function sheetNote(id){
  const o = getOrder(id); if(!o) return
  openSheet(`
    <div class="sh-title">给客户留言</div>
    <div class="sh-sub">会显示在客户的「订单详情」页，适合写进度说明</div>
    <textarea class="sh-textarea" id="note-input" placeholder="例如：信封已画好，明天贴票寄出">${esc(o.admin_note || '')}</textarea>
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="saveNote('${id}')">保存</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">取消</button>
  `)
  setTimeout(() => document.getElementById('note-input').focus(), 280)
}
function saveNote(id){
  updOrder(id, { admin_note: document.getElementById('note-input').value.trim() })
  log(id, '更新了留言')
  closeSheet(); toast('已保存'); renderList()
}

// 补 / 改收信地址 —— 客户委托代查的单，查到了要能填回来，否则「待查」永远销不掉
function sheetAddr(id){
  const o = getOrder(id); if(!o) return
  openSheet(`
    <div class="sh-title">${needLookup(o) ? '补上收信地址' : '修改收信地址'}</div>
    <div class="sh-sub">${esc(o.artist || '')} · 尾号 ${esc(tail(o.order_no))}<br>${
      needLookup(o) ? '查到了就填这里，填完「待查地址」自动销掉。' : '改完直接生效。'}</div>
    <textarea class="sh-textarea" id="addr-input" style="min-height:96px" placeholder="艺人工作室 / Fan mail 地址（英文）">${esc(o.recipient_addr || '')}</textarea>
    <div class="sh-gap"></div>
    <button class="btn-full" onclick="saveAddr('${id}')">保存地址</button>
    <div class="sh-gap"></div>
    <button class="btn-full grey" onclick="closeSheet()">取消</button>
  `)
  setTimeout(() => { const t = document.getElementById('addr-input'); if(t) t.focus() }, 280)
}
function saveAddr(id){
  const o = getOrder(id); if(!o) return
  const v = (document.getElementById('addr-input').value || '').trim()
  if(!v){ toast('地址不能为空'); return }
  updOrder(id, { recipient_addr: v })
  log(id, o.addr_lookup ? '补上代查地址' : '更新收信地址')
  closeSheet(); toast('地址已保存'); renderList()
}

function sheetMedia(id){
  openSheet(`
    <div class="sh-title">存凭证</div>
    <div class="sh-sub">成品图、投递视频。只存在这台设备里，客户在详情页能看到。</div>
    <button class="sh-opt" onclick="attach('${id}','image/*')">📷 选择图片<small>可多选，成品图</small></button>
    <button class="sh-opt" onclick="attach('${id}','video/*')">🎥 选择视频<small>建议 60MB 以内</small></button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
function attach(id, accept){
  closeSheet()
  const input = document.createElement('input')
  input.type = 'file'; input.accept = accept; input.multiple = true; input.style.display = 'none'
  input.onchange = e => {
    const files = Array.from(e.target.files)
    const o = getOrder(id); if(!o) return
    const media = Array.isArray(o.media) ? o.media : []
    let added = 0
    files.forEach(f => {
      if(f.type.indexOf('video') === 0 && f.size > 60 * 1024 * 1024){ toast('视频超过 60MB，已跳过'); return }
      media.push({ kind: f.type.indexOf('video') === 0 ? 'video' : 'image', path: URL.createObjectURL(f), at: Date.now(), name: f.name })
      added++
    })
    updOrder(id, { media })
    if(added) log(id, `存入 ${added} 个凭证`)
    toast(added ? `已存 ${added} 个凭证` : '没有存入')
    renderList()
    document.body.removeChild(input)
  }
  document.body.appendChild(input); input.click()
}

function sheetDelete(id){
  const o = getOrder(id); if(!o) return
  openSheet(`
    <div class="sh-title">删除这一单？</div>
    <div class="sh-sub">${esc(o.artist || '')} · ${esc(o.order_no)}<br>从这台设备永久删除，无法恢复。</div>
    <button class="sh-opt danger" onclick="doDelete('${id}')">确认删除</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
function doDelete(id){
  delOrder(id); closeSheet(); toast('已删除'); renderList()
}

// ==================== 复制 ====================
function fullText(o){
  return [
    '【订单】' + o.order_no,
    '艺人：' + (o.artist || '-'),
    '收信国家：' + (o.country || '-'),
    '收信地址：' + (String(o.recipient_addr || '').trim() || (o.addr_lookup ? '（待查 · 我负责查最新地址）' : '-')),
    '地址代查：' + (o.addr_lookup ? '需要' : '不需要'),
    '称呼：' + (o.customer_name || '-'),
    '手机：' + (o.customer_phone || '-'),
    '回信地址：' + (o.return_addr || '-'),
    '信件：' + (o.letter_source === 'proxy' ? '需要代写' : '客户自己手写'),
    '备注：' + (o.letter_note || '无'),
    '状态：' + statusLabel(o.status) + ' / ' + (o.pay_status === 'paid' ? '已收款' : '待收款'),
    '下单：' + fmt(o.created_at),
  ].join('\n')
}
function copyFull(id){ const o = getOrder(id); if(o) copy(fullText(o)) }

function copyShip(id){
  const o = getOrder(id); if(!o) return
  if(needLookup(o)){ toast('这一单地址还没查 · 先把查到的地址填进去再复制'); return }
  copy([
    '寄件信息 · ' + tail(o.order_no),
    '收件人：' + (o.artist || ''),
    '地址：' + (o.recipient_addr || ''),
    '国家：' + (o.country || ''),
  ].join('\n'))
}

function copyUnpaid(){
  const list = allOrders().filter(o => o.pay_status !== 'paid')
  if(!list.length){ toast('没有待收款的单'); return }
  copy('待收款 ' + list.length + ' 单，共 ¥' + list.length * PRICE + '\n\n' +
    list.map(o => `${tail(o.order_no)}  ${o.artist || '-'}  ¥${PRICE}`).join('\n'))
}

// ==================== 备份 ====================
// 台账只住在浏览器里，清缓存 / 换手机就没了 —— 而云端还没有。
// 底部那行「换手机请先导出备份」是静态小字，没人会读第二遍，
// 所以改成主动提醒：**有单没进过备份**就把这事顶到眼前，导完自动消失。
// 不用「几天没导出」那种日历规则 —— 昨天刚导过、今天来了 5 单，
// 日历会说「还早」，可这 5 单一张纸都没有；反过来没有新单时催也没意义。
const EXPORT_KEY = 'artist_letter_admin_last_export'

function renderBackupNudge(){
  const box = document.getElementById('backup-nudge')
  if(!box) return
  const list = allOrders()
  if(!list.length){ box.innerHTML = ''; return }          // 台账空的，没什么可丢
  let last = 0
  try { last = Number(localStorage.getItem(EXPORT_KEY)) || 0 } catch(e){}

  const fresh = last
    ? list.filter(o => (o.created_at || 0) > last).length
    : list.length                                          // 从没导过 → 全都在裸奔
  if(!fresh){ box.innerHTML = ''; return }

  const what = last
    ? `备份之后又进来 <b>${fresh} 单</b>`
    : `还没有导出过备份`
  // 紧凑单行条：这个提醒会**长期存在**（每来一单就出现一次，导完才消失），
  // 所以不能做成大块头 —— 否则天天挡在「新建订单」上面，很快就没人看了。
  // 云端同步开着的时候，不能再说「台账只在浏览器里，清缓存就没了」——
  // 那句话和下面那条绿色的「云端同步已开启」直接打架，而且它是假的。
  // 备份这件事本身仍然要做，只是理由变了：导出的是**你自己手里**的那份，
  // 服务停了、我这边出任何问题，它都还在。
  const why = cloudOn()
    ? '导出的是<b>你自己手里</b>的那份 —— 服务停了也还在'
    : '台账只在浏览器里，<b>清缓存就没了</b>'
  box.innerHTML = `
    <div class="bk-nudge">
      <div class="bk-nudge-main">
        <div class="bk-nudge-t">⚠️ ${what}</div>
        <div class="bk-nudge-d">${why}</div>
      </div>
      <button class="bk-nudge-btn" onclick="doExport()">导出备份</button>
    </div>`
}

function doExport(){
  // 先取时间戳、再读单：导出过程中刚好进来的新单，不会被误标成「已备份」。
  const stamp = Date.now()
  const list = allOrders()
  if(!list.length){ toast('台账还是空的'); return }
  const data = { app:'artist-letter', version:1, exported_at: new Date(stamp).toISOString(), orders: list }
  const json = JSON.stringify(data, null, 2)

  try {
    const blob = new Blob([json], { type:'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `台账备份_${fmtDay(stamp)}.json`
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a) }, 1500)
    try { localStorage.setItem(EXPORT_KEY, String(stamp)) } catch(e){}
    renderBackupNudge()          // 导完就把提醒收掉
    toast('已导出 ' + list.length + ' 单')
  } catch(e){
    copy(json); toast('已复制备份内容到剪贴板')
  }
}

function pickImport(){
  openSheet(`
    <div class="sh-title">导入备份</div>
    <div class="sh-sub">选择之前导出的 JSON 文件。<br><b style="color:#EF9F27">会覆盖当前台账</b>，选完文件后我会先让你确认一次。</div>
    <button class="sh-opt" onclick="doImport()">📥 选择备份文件</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
// 导入是**破坏性操作**（直接覆盖台账），而且原来选完文件立刻生效、没有二次确认。
// 选错一个旧备份 → 新单静默消失，跟「丢单」是同一类事故。
// 所以改成：先读文件、把「会丢哪几单」摆出来，确认了才写。
let pendingImport = null

function doImport(){
  closeSheet()
  const input = document.createElement('input')
  input.type = 'file'; input.accept = '.json,application/json'; input.style.display = 'none'
  input.onchange = e => {
    const f = e.target.files[0]; if(!f) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result)
        const orders = Array.isArray(data) ? data : data.orders
        if(!Array.isArray(orders)) throw new Error('格式不对')
        sheetImportConfirm(orders)      // 先确认，不直接覆盖
      } catch(err){ toast('文件读不出来，确认是导出的备份吗') }
    }
    reader.readAsText(f)
    document.body.removeChild(input)
  }
  document.body.appendChild(input); input.click()
}

function sheetImportConfirm(orders){
  const cur = allOrders()
  const inFile = {}
  orders.forEach(o => { if(o && o.order_no) inFile[o.order_no] = true })
  const lost = cur.filter(o => !inFile[o.order_no])
  pendingImport = orders

  const lostHtml = lost.length
    ? `<div class="imp-warn">
         ⚠️ 有 <b>${lost.length} 单</b>不在这个备份里，导入后会消失：<br>
         ${lost.slice(0,5).map(o => esc(o.order_no)).join('、')}${lost.length > 5 ? ' 等' : ''}<br>
         <span class="imp-warn-tip">建议先「导出备份」，再导入。</span>
       </div>`
    : `<div class="imp-ok">当前台账的单都在这个备份里，导入不会丢东西。</div>`

  openSheet(`
    <div class="sh-title">导入备份</div>
    <div class="sh-sub">备份里 <b>${orders.length} 单</b>，当前台账 <b>${cur.length} 单</b>。<br>
      <b style="color:#EF9F27">导入会覆盖当前台账</b>。</div>
    ${lostHtml}
    <button class="sh-opt danger" onclick="doImportConfirm()">确认导入（覆盖）</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}

function doImportConfirm(){
  if(!pendingImport) return
  const n = pendingImport.length
  saveOrders(pendingImport); pendingImport = null
  closeSheet(); renderList(); toast('已导入 ' + n + ' 单')
}

// ==================== 设置 ====================
function openSettings(){
  const list  = allOrders()
  const email = localStorage.getItem(EMAIL_KEY) || '未登记'
  const hasRec = !!localStorage.getItem(RECOV_KEY)
  const cloudTxt = (!window.Cloud || !Cloud.on()) ? '未配置'
    : (!cloudKey ? '未填密钥 · 只看得到本机'
      : (cloudErr ? '失败 · ' + cloudErr
        : '已开启 · 云端 ' + (cloudTotal >= 0 ? cloudTotal : '?') + ' / 本机 ' + list.length))
  openSheet(`
    <div class="sh-title">设置</div>
    <div class="sh-sub">
      台账共 ${list.length} 单 · 累计收款 ¥${list.filter(o => o.pay_status === 'paid').length * PRICE}<br>
      本机始终留一份完整副本，云端同步是给「换设备也能看到全部订单」用的。
    </div>
    <button class="sh-opt" onclick="closeSheet();openCloudKey()">☁️ 云端同步<small>${esc(cloudTxt)}</small></button>
    <button class="sh-opt" onclick="closeSheet();openCloudDiag()">🩺 云端同步诊断<small>服务端收到了什么 · 请求留痕</small></button>
    <button class="sh-opt" onclick="doExport()">📤 导出备份</button>
    <button class="sh-opt" onclick="pickImport()">📥 导入备份</button>
    <button class="sh-opt" onclick="resetPin()">🔑 重设访问密码</button>
    <button class="sh-opt" onclick="regenRecovery()">🎫 重新生成恢复码<small>${hasRec ? '已设置 · 弄丢或泄露了就换一个' : '还没设置'}</small></button>
    <button class="sh-opt" onclick="editEmail()">✉️ 恢复邮箱<small>${esc(email)}</small></button>
    <button class="sh-opt danger" onclick="sheetWipe()">🗑 清空全部台账</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">关闭</button>
  `)
}
function sheetWipe(){
  const n = allOrders().length
  openSheet(`
    <div class="sh-title">清空全部台账？</div>
    <div class="sh-sub">${n} 单全部删除，不可恢复。<br>如果只是想重来，请先导出备份。
      ${cloudOn() ? '<br><br><b style="color:#EF9F27">云端那份也会一起清掉</b> —— 否则下次同步会把它拉回来。' : ''}</div>
    <button class="sh-opt danger" onclick="doWipe()">确认清空</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
function doWipe(){
  // 先给每一单留墓碑，再清空。
  // 不这么做的话：本地清空了，云端还留着，下一次同步会把它们**全部拉回来** ——
  // 看起来就是「删不掉」。
  allOrders().forEach(o => { if(o.order_no) markDeleted(o.order_no) })
  saveOrders([]); closeSheet(); toast('已清空'); renderList()
}

// ==================== 弹层 ====================
function openSheet(html){
  document.getElementById('sheet-inner').innerHTML = html
  document.getElementById('mask').classList.add('on')
  document.getElementById('sheet').classList.add('on')
}
function closeSheet(){
  document.getElementById('mask').classList.remove('on')
  document.getElementById('sheet').classList.remove('on')
}
function viewImage(src){
  const d = document.createElement('div')
  d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:300;display:flex;align-items:center;justify-content:center'
  d.innerHTML = `<img src="${src}" style="max-width:94%;max-height:94%;border-radius:10px">`
  d.onclick = () => document.body.removeChild(d)
  document.body.appendChild(d)
}

// ==================== 启动 ====================
document.addEventListener('DOMContentLoaded', () => {
  initLock()
  document.getElementById('recon').addEventListener('keydown', e => { if(e.key === 'Enter') doReconcile() })
})
