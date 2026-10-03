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
function saveOrders(list){ localStorage.setItem(STORE_KEY, JSON.stringify(list)) }
function getOrder(id){ return allOrders().find(o => o.id === id) || null }
function updOrder(id, patch){
  const list = allOrders(); const i = list.findIndex(o => o.id === id)
  if(i < 0) return null
  list[i] = Object.assign({}, list[i], patch); saveOrders(list); return list[i]
}
function delOrder(id){ saveOrders(allOrders().filter(o => o.id !== id)) }
function log(id, text){
  const o = getOrder(id); if(!o) return
  const logs = Array.isArray(o.logs) ? o.logs : []
  logs.push({ at: Date.now(), text })
  updOrder(id, { logs })
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

// ==================== 锁屏 ====================
let pinBuf = '', pinMode = 'verify', pinFirst = ''

function initLock(){
  const saved = localStorage.getItem(PIN_KEY)
  pinMode = saved ? 'verify' : 'set'
  document.getElementById('lock-title').innerText = saved ? '输入密码' : '设置访问密码'
  document.getElementById('lock-sub').innerText   = saved ? '内部台账 · 请勿外传' : `请设置 ${PIN_LEN} 位数字密码`
  document.getElementById('lock-reset').style.display = saved ? 'block' : 'none'
  buildKeypad(); paintDots()
}

function buildKeypad(){
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫']
  document.getElementById('keypad').innerHTML = keys.map(k => {
    if(k === '') return '<button class="key ghost" disabled></button>'
    if(k === '⌫') return `<button class="key ghost" onclick="pinDel()">⌫</button>`
    return `<button class="key" onclick="pinPush('${k}')">${k}</button>`
  }).join('')
}

function paintDots(){
  const n = pinBuf.length
  document.getElementById('lock-dots').innerHTML =
    Array.from({length: PIN_LEN}, (_,i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')
}

function pinErr(msg){
  const err = document.getElementById('lock-err')
  err.innerText = msg
  const dots = document.getElementById('lock-dots')
  dots.classList.add('shake')
  setTimeout(() => dots.classList.remove('shake'), 340)
}

function pinPush(d){
  if(pinBuf.length >= PIN_LEN) return
  pinBuf += d; paintDots()
  document.getElementById('lock-err').innerText = ''
  if(pinBuf.length === PIN_LEN) setTimeout(submitPin, 130)
}
function pinDel(){ pinBuf = pinBuf.slice(0,-1); paintDots() }

function submitPin(){
  if(pinMode === 'verify'){
    if(pinBuf === localStorage.getItem(PIN_KEY)){ unlock() }
    else { pinBuf = ''; paintDots(); pinErr('密码不对') }
    return
  }
  if(pinMode === 'set'){
    pinFirst = pinBuf; pinBuf = ''; pinMode = 'confirm'; paintDots()
    document.getElementById('lock-title').innerText = '再输一次确认'
    return
  }
  if(pinBuf === pinFirst){
    localStorage.setItem(PIN_KEY, pinBuf); unlock(); toast('密码已设置')
  } else {
    pinBuf = ''; pinFirst = ''; pinMode = 'set'; paintDots()
    document.getElementById('lock-title').innerText = '设置访问密码'
    pinErr('两次不一致，重新设置')
  }
}

function unlock(){
  document.getElementById('lock').style.display = 'none'
  document.getElementById('app').style.display  = 'block'
  renderBoard(); renderChips(); renderList()
}

function resetPin(){
  openSheet(`
    <div class="sh-title">重设访问密码</div>
    <div class="sh-sub">密码只存在这台设备里，清掉之后需要重新设置。<br>
      <b style="color:#EF9F27">注意：这等于放弃了唯一一道门锁</b>——任何拿到你手机并知道这个网址的人都能看到全部订单。</div>
    <button class="sh-opt danger" onclick="doResetPin()">确认清除密码</button>
    <button class="sh-opt" onclick="closeSheet()">取消</button>
  `)
}
function doResetPin(){
  localStorage.removeItem(PIN_KEY)
  closeSheet(); pinBuf = ''; pinFirst = ''; initLock(); toast('已清除，请重设密码')
}

// ==================== 看板 ====================
function renderBoard(){
  const list = allOrders()
  const unpaid = list.filter(o => o.pay_status !== 'paid').length
  const toStart = list.filter(o => o.status === 'paid').length
  const drawing = list.filter(o => o.status === 'drawing').length
  const income = list.filter(o => o.pay_status === 'paid').length * PRICE

  const tile = (num, label, cls, filter) =>
    `<button class="tile ${cls} ${num === 0 ? 'zero' : ''}" onclick="quickFilter('${filter}')">
       <div class="tile-num">${num}</div><div class="tile-label">${label}</div>
     </button>`

  document.getElementById('board').innerHTML =
    tile(unpaid, '待收款', unpaid > 0 ? 'alert' : '', 'unpaid') +
    tile(toStart, '待开工', '', 'paid') +
    tile(drawing, '绘制中', '', 'drawing') +
    tile('¥' + income, '累计收款', 'good', 'all')
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

  const hits = allOrders().filter(o => tail(o.order_no) === t)
  if(!hits.length){
    out.innerHTML = '<div class="hint" style="color:#EF9F27">没找到这个尾号 · 客户可能还没把订单发给你</div>'
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

// ==================== 筛选 / 列表 ====================
let filterKey = 'all'
const CHIPS = [
  { f:'all',     label:'全部' },
  { f:'unpaid',  label:'待收款' },
  { f:'paid',    label:'待开工' },
  { f:'drawing', label:'绘制中' },
  { f:'mailed',  label:'已寄出' },
  { f:'done',    label:'已完成' },
]

function countOf(f){
  const list = allOrders()
  if(f === 'all')     return list.length
  if(f === 'unpaid')  return list.filter(o => o.pay_status !== 'paid').length
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
  renderBoard(); renderChips()
  const kw = (document.getElementById('kw').value || '').trim().toUpperCase()

  let list = allOrders().sort((a,b) => (b.created_at || 0) - (a.created_at || 0))
  if(filterKey === 'unpaid')      list = list.filter(o => o.pay_status !== 'paid')
  else if(filterKey !== 'all')    list = list.filter(o => o.status === filterKey)
  if(kw) list = list.filter(o => match(o, kw))

  const box = document.getElementById('list')
  const empty = document.getElementById('empty')

  if(!list.length){
    box.innerHTML = ''
    empty.style.display = allOrders().length ? 'block' : 'block'
    empty.querySelector('.empty-title').innerText = allOrders().length ? '没有匹配的订单' : '台账还是空的'
    empty.querySelector('.empty-sub').innerText   = allOrders().length ? '换个筛选条件，或清空搜索词' : '客户下单后，这里会出现订单'
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

  return `
  <div class="order ${cls}" id="od-${o.id}">
    <div class="o-top" onclick="toggle('${o.id}')">
      <div>
        <div class="o-no">${esc(tail(o.order_no))}<small>${esc(o.order_no)}</small></div>
        <div class="o-artist">${esc(o.artist || '（未填艺人）')}</div>
      </div>
      <div class="o-tags">
        <span class="tag ${paid ? 'green' : 'amber'}">${paid ? '已收款' : '待收款'}</span>
        <span class="tag sage">${statusLabel(o.status)}</span>
      </div>
    </div>

    <div class="o-meta">
      ${esc(o.customer_name || '未填称呼')} · ${esc(o.customer_phone || '无电话')}<br>
      ${fmt(o.created_at)} 下单 · ${o.country ? esc(o.country) : '未填国家'}
    </div>

    <div class="o-detail">
      <div class="d-row"><div class="d-key">收信地址</div><div class="d-val">${esc(o.recipient_addr || '-')}</div></div>
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

function toggle(id){ document.getElementById('od-' + id).classList.toggle('open') }

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
    '收信地址：' + (o.recipient_addr || '-'),
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
function doExport(){
  const list = allOrders()
  if(!list.length){ toast('台账还是空的'); return }
  const data = { app:'artist-letter', version:1, exported_at: new Date().toISOString(), orders: list }
  const json = JSON.stringify(data, null, 2)

  try {
    const blob = new Blob([json], { type:'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `台账备份_${fmtDay(Date.now())}.json`
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); document.body.removeChild(a) }, 1500)
    toast('已导出 ' + list.length + ' 单')
  } catch(e){
    copy(json); toast('已复制备份内容到剪贴板')
  }
}

function pickImport(){
  openSheet(`
    <div class="sh-title">导入备份</div>
    <div class="sh-sub">选择之前导出的 JSON 文件。<br><b style="color:#EF9F27">会覆盖当前台账</b>，导入前建议先导出一次。</div>
    <button class="sh-opt" onclick="doImport()">📥 选择备份文件</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
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
        saveOrders(orders); renderList(); toast('已导入 ' + orders.length + ' 单')
      } catch(err){ toast('文件读不出来，确认是导出的备份吗') }
    }
    reader.readAsText(f)
    document.body.removeChild(input)
  }
  document.body.appendChild(input); input.click()
}

// ==================== 设置 ====================
function openSettings(){
  const list = allOrders()
  openSheet(`
    <div class="sh-title">设置</div>
    <div class="sh-sub">
      台账共 ${list.length} 单 · 累计收款 ¥${list.filter(o => o.pay_status === 'paid').length * PRICE}<br>
      数据只存在这台设备的浏览器里，清缓存会丢，记得常导出备份。
    </div>
    <button class="sh-opt" onclick="doExport()">📤 导出备份</button>
    <button class="sh-opt" onclick="pickImport()">📥 导入备份</button>
    <button class="sh-opt" onclick="resetPin()">🔑 重设访问密码</button>
    <button class="sh-opt danger" onclick="sheetWipe()">🗑 清空全部台账</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">关闭</button>
  `)
}
function sheetWipe(){
  openSheet(`
    <div class="sh-title">清空全部台账？</div>
    <div class="sh-sub">${allOrders().length} 单全部删除，不可恢复。<br>如果只是想重来，请先导出备份。</div>
    <button class="sh-opt danger" onclick="doWipe()">确认清空</button>
    <button class="sh-opt" onclick="closeSheet()" style="text-align:center;color:#77766f">取消</button>
  `)
}
function doWipe(){
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
  document.getElementById('lock-reset').onclick = resetPin
})
