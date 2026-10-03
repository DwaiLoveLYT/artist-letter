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

function unlock(){
  document.getElementById('lock').style.display = 'none'
  document.getElementById('app').style.display  = 'block'
  renderBoard(); renderChips(); renderList()
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
    out.innerHTML =
      '<div class="hint" style="color:#EF9F27; line-height:1.85">'
      + '本机台账里没有尾号 <b>' + esc(t) + '</b>。<br>'
      + (list.length
          ? '这台设备上现有的尾号：<br><b style="letter-spacing:1px">'
            + shown.map(esc).join('　') + (tails.length > shown.length ? ' …' : '') + '</b><br>'
            + '对不上，说明这一单还没录进来。'
          : '<b>这台设备上一条订单都没有。</b><br>'
            + '那基本可以确定：你下单用的浏览器 / 网址，和现在开后台的不是同一个。')
      + '</div>'
      + '<button class="btn-full grey" style="margin-top:10px" onclick="showSelfCheck()">看看本机自检 ›</button>'
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
  openSheet(`
    <div class="sh-title">本机自检</div>
    <div class="sh-sub">查不到订单时先看这里 —— 九成是设备或网址对不上，不是系统坏了。</div>

    <div class="chk-row"><div class="chk-key">后台域名</div><div class="chk-val mono">${esc(location.hostname)}</div></div>
    <div class="chk-row"><div class="chk-key">后台路径</div><div class="chk-val mono">${esc(location.pathname)}</div></div>
    <div class="chk-row"><div class="chk-key">本机台账</div><div class="chk-val">${list.length} 单</div></div>
    <div class="chk-row"><div class="chk-key">现有尾号</div><div class="chk-val mono">${
      list.length ? list.slice(0, 12).map(o => esc(tail(o.order_no))).join(' ') : '（无）'
    }</div></div>

    <div class="hint" style="margin-top:15px; line-height:1.85">
      订单只存在<b>下单那台设备的那个浏览器</b>里。<br><br>
      ① <b>换浏览器就断了</b> —— 微信里打开、和 Safari / Chrome 里打开，数据是分开的。<br>
      ② <b>换网址也断了</b> —— 上面这个域名，要和你开客户页时地址栏里那个一致。<br>
      ③ 客户在<b>他自己</b>手机上下单，永远不会自动进你这里。<br><br>
      要让订单进来：让客户点他页面上的「复制下单信息」发给你，
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
    '后台域名：' + location.hostname,
    '后台路径：' + location.pathname,
    '本机台账：' + list.length + ' 单',
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
  out.innerHTML =
    '<div class="rc-head">认出 ' + reconHits.length + ' 个订单号'
    + (reconNew.length ? ' · 其中 ' + reconNew.length + ' 单台账里还没有' : '') + '</div>'
    + (known.length ? '<div class="rc-list">' + rows + '</div>'
        : '<div class="hint">认出来的订单号都在台账里了</div>')
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
  renderBoard(); renderChips(); renderLocalStrip(); renderBackupNudge()
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

  return `
  <div class="order ${cls} ${openIds.has(o.id) ? 'open' : ''}" id="od-${o.id}">
    <div class="o-top" onclick="toggle('${o.id}')">
      <div>
        <div class="o-no">${esc(tail(o.order_no))}<small>${esc(o.order_no)}</small></div>
        <div class="o-artist">${esc(o.artist || '（未填艺人）')}</div>
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
  el.classList.toggle('open')
  el.classList.contains('open') ? openIds.add(id) : openIds.delete(id)
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
  box.innerHTML = `
    <div class="bk-nudge">
      <div class="bk-nudge-main">
        <div class="bk-nudge-t">⚠️ ${what}</div>
        <div class="bk-nudge-d">台账只在浏览器里，<b>清缓存就没了</b></div>
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
  openSheet(`
    <div class="sh-title">设置</div>
    <div class="sh-sub">
      台账共 ${list.length} 单 · 累计收款 ¥${list.filter(o => o.pay_status === 'paid').length * PRICE}<br>
      数据只存在这台设备的浏览器里，清缓存会丢，记得常导出备份。
    </div>
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
})
