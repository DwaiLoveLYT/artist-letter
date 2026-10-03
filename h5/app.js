// ==================== 配置 ====================
// 客服分两个微信号：工作日 ymzx0618、周末 IMDWAY。
// 页面会按当天星期自动标出该找谁，不用客户自己算今天周几。
const CONTACTS = {
  weekday: { label:'工作日', range:'周一至周五', id:'ymzx0618' },
  weekend: { label:'周末',   range:'周六、周日', id:'IMDWAY' },
}
const TZ_NOTE = '有北美时差，回复不是秒回。看到就会回你，请耐心等一等。'

function todayContact(){
  const d = new Date().getDay()              // 0 = 周日, 6 = 周六
  return (d === 0 || d === 6) ? 'weekend' : 'weekday'
}
function wxId(){ return CONTACTS[todayContact()].id }

function contactCardHtml(){
  const today = todayContact()
  const row = key => {
    const c  = CONTACTS[key]
    const on = key === today
    return `
      <div class="contact-row ${on ? 'today' : ''}">
        <div class="contact-left">
          <div class="contact-when">${c.label} · ${c.range}${
            on ? '<span class="contact-today">今天找这个</span>' : ''}</div>
          <div class="contact-id">${c.id}</div>
        </div>
        <button class="contact-copy" onclick="copyText('${c.id}')">复制</button>
      </div>`
  }
  return `
    <div class="card contact-card">
      <div class="card-title">找我们</div>
      ${row('weekday')}
      ${row('weekend')}
      <div class="contact-note">⏱ ${TZ_NOTE}</div>
    </div>`
}

function initContacts(){
  const home = document.getElementById('contact-home')
  if(home) home.innerHTML = contactCardHtml()
  const succ = document.getElementById('contact-success')
  if(succ) succ.innerHTML = contactCardHtml()
  document.querySelectorAll('.js-wx').forEach(el => { el.innerText = wxId() })
  const btn = document.getElementById('empty-wx-btn')
  if(btn) btn.innerText = '用订单号找客服查：复制 ' + wxId()
}
function copyContactWx(){ copyText(wxId()) }

const RECEIVE_ADDR = '中国广东省深圳市南山区泉园路61号绿茵丰和，直接放东门保安室。188888888'
const PAY_QR = 'images/pay-qr.jpg'

// ==================== 状态机 ====================
const STATUS_FLOW = [
  { key:'created', label:'已提交，待付款', hint:'订单已生成，请按页面提示完成付款。' },
  { key:'paid',    label:'已收款，排队中', hint:'款项已确认，等待安排画师。' },
  { key:'drawing', label:'画师绘制中',     hint:'两个手绘信封制作中。' },
  { key:'mailed',  label:'已寄出',         hint:'已投递并录制投递视频，等待对方收取。' },
  { key:'done',    label:'已完成',         hint:'寄出后 4–8 周无退回，视为送达。' },
]
const STATUS_MAP = {}
STATUS_FLOW.forEach((s,i)=>STATUS_MAP[s.key]=i)

function statusLabel(k){ const s=STATUS_FLOW.find(x=>x.key===k); return s?s.label:'处理中' }
function statusIndex(k){ return STATUS_MAP[k]===undefined?0:STATUS_MAP[k] }
function tagClass(k){ if(k==='done'||k==='mailed')return'tag done'; if(k==='created')return'tag wait'; return'tag' }

function makeOrderNo(){
  const C='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out=''
  for(let i=0;i<6;i++)out+=C[Math.floor(Math.random()*C.length)]
  const d=new Date()
  return `AL${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${out}`
}
function fmtTime(ts){
  if(!ts)return''
  const d=new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}
// 列表里写「今天 14:03」比「2026-10-04 14:03」有温度得多，也更好扫
function fmtTimeHuman(ts){
  if(!ts) return ''
  const d=new Date(ts), now=new Date()
  const dayStart=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime()
  const diff=Math.round((dayStart(now)-dayStart(d))/86400000)
  const hm=`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  if(diff===0) return '今天 '+hm
  if(diff===1) return '昨天 '+hm
  if(diff>1 && diff<7) return diff+' 天前'
  return `${d.getMonth()+1} 月 ${d.getDate()} 日`
}

// ==================== 存储 ====================
const STORE_KEY='artist_letter_orders_v1'
function allOrders(){
  try{ const raw=localStorage.getItem(STORE_KEY); const list=JSON.parse(raw); return Array.isArray(list)?list:[] }
  catch(e){ return [] }
}
let lastSaveOK = true
function saveOrders(list){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(list)); lastSaveOK=true; return true }
  catch(e){ lastSaveOK=false; return false }
}
// 无痕模式 / 禁用本地存储时，localStorage 会直接抛错
function storageOK(){
  try{ localStorage.setItem('__al_probe','1'); localStorage.removeItem('__al_probe'); return true }
  catch(e){ return false }
}
function getOrder(id){ return allOrders().find(o=>o.id===id)||null }
function addOrder(o){ const list=allOrders(); list.push(o); saveOrders(list); return o }
function updOrder(id, patch){
  const list=allOrders(); const idx=list.findIndex(o=>o.id===id)
  if(idx<0)return null; list[idx]={...list[idx],...patch}; saveOrders(list); return list[idx]
}
function delOrder(id){ saveOrders(allOrders().filter(o=>o.id!==id)) }

// ==================== 路由 ====================
let lastOrderId=''

function goPage(name, param){
  if(name==='detail' && param){ renderDetail(param); lastOrderId=param }
  if(name==='track') renderTrack()
  if(name==='order') restoreProfile()      // 回头客：自动带出上次填过的信息

  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'))
  const page=document.getElementById('page-'+name)
  if(page){ page.classList.add('active'); window.scrollTo(0,0); }
}

function scrollToHow(){
  goPage('home')
  setTimeout(()=>{
    const el=document.getElementById('how-section')
    if(el) el.scrollIntoView({behavior:'smooth'})
  },100)
}

// ==================== 首页 ====================
const SHOWCASE=[]
function initHome(){
  initContacts()
  if(SHOWCASE.length){
    document.getElementById('showcase-section').style.display='block'
    document.getElementById('showcase-gallery').innerHTML=SHOWCASE.map(src=>
      `<img class="gallery-img" src="${src}" onclick="previewImage('${src}')">`
    ).join('')
  }
}

// FAQ 手风琴：一次只开一条。5 条全展开会把首页拉成一页说明书。
function toggleFaq(qEl){
  const item=qEl.parentElement
  const wasOpen=item.classList.contains('open')
  document.querySelectorAll('#faq-list .faq-item').forEach(i=>i.classList.remove('open'))
  if(!wasOpen) item.classList.add('open')
}

// ==================== 下单 ====================
let letterSource='self'
let addrLookup=false          // 客户勾了「帮我查最新地址」

const RECIPIENT_PH_NORMAL = '艺人工作室 / 经纪公司 / Fan mail 地址\n不知道精确地址就填城市或国家，我负责帮你查最新的'
const RECIPIENT_PH_LOOKUP = '可以只写城市，或者干脆留空 —— 我会去查这位艺人最新的收信地址'

function setLetterSource(el){
  letterSource=el.dataset.value
  document.querySelectorAll('#page-order .radio').forEach(r=>r.classList.remove('on'))
  el.classList.add('on')
  document.getElementById('proxy-note-box').style.display=letterSource==='proxy'?'block':'none'
  document.getElementById('self-note-box').style.display=letterSource==='self'?'block':'none'
}

function toggleAddrLookup(){
  addrLookup=!addrLookup
  const box=document.getElementById('lookup-toggle')
  const sw =document.getElementById('lookup-switch')
  const req=document.getElementById('recipient-req')
  const ta =document.getElementById('o-recipient')
  const hint=document.getElementById('recipient-hint')

  box.classList.toggle('on',addrLookup)
  box.setAttribute('aria-checked', addrLookup?'true':'false')
  sw.innerText=addrLookup?'✓':''
  req.style.display=addrLookup?'none':''
  ta.placeholder=addrLookup?RECIPIENT_PH_LOOKUP:RECIPIENT_PH_NORMAL
  hint.innerText=addrLookup
    ? '已记下：这一单的地址由我帮你查，查到后会更新在「我的订单」'
    : '不知道精确地址就填城市或国家，我负责帮你查最新的'
}
// 这是个 div，键盘用户也得能操作
function lookupKey(e){
  if(e.key===' '||e.key==='Enter'||e.key==='Spacebar'){ e.preventDefault(); toggleAddrLookup() }
}

// ==================== 记住回头客 ====================
// 称呼 / 手机号 / 回信地址，同一个人基本不变。第二次下单不该再填一遍。
const PROFILE_KEY='artist_letter_profile_v1'
function saveProfile(o){
  try{
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      customer_name:o.customer_name||'', customer_phone:o.customer_phone||'', return_addr:o.return_addr||'',
    }))
  }catch(e){}
}
function restoreProfile(){
  let p=null
  try{ p=JSON.parse(localStorage.getItem(PROFILE_KEY)) }catch(e){}
  const note=document.getElementById('prefill-note')
  if(!p){ if(note) note.style.display='none'; return }
  let hit=false
  const fill=(id,v)=>{
    const el=document.getElementById(id)
    if(el && !el.value && v){ el.value=v; hit=true }
  }
  fill('o-name',p.customer_name); fill('o-phone',p.customer_phone); fill('o-return',p.return_addr)
  if(note) note.style.display = hit ? 'block' : 'none'
}

let submitting=false

function submitOrder(){
  if(submitting) return                      // 防连点：手快双击会生成两单
  const artist=document.getElementById('o-artist').value.trim()
  const country=document.getElementById('o-country').value.trim()
  const recipient=document.getElementById('o-recipient').value.trim()
  const phone=document.getElementById('o-phone').value.trim()
  const retAddr=document.getElementById('o-return').value.trim()
  const note=letterSource==='proxy'
    ? document.getElementById('o-note-proxy').value.trim()
    : document.getElementById('o-note-self').value.trim()

  // 提示写成「人话」+ 直接标出是哪一栏，别让客户在长表单里自己找
  if(!artist){ fieldError('o-artist','还差一个艺人名字 —— 我得知道这封信寄给谁'); return }
  if(!country){ fieldError('o-country','填一下收信国家，我才知道该备哪个国家的回信邮票'); return }
  if(!recipient && !addrLookup){ fieldError('o-recipient','地址先空着也行 —— 勾上「帮我查最新地址」，我替你去查'); return }
  if(!phone){ fieldError('o-phone','留个手机号吧，寄出前后有事好找你'); return }
  if(!/^[\d\s+()\-]{6,}$/.test(phone)){ fieldError('o-phone','手机号看着不太对，再检查一下'); return }
  if(!retAddr){ fieldError('o-return','回信地址还没填 —— 对方回信就寄到这里'); return }
  if(letterSource==='proxy' && !note){ fieldError('o-note-proxy','选了代写，得先知道你想说什么'); return }

  submitting=true
  const orderNo=makeOrderNo()
  const order={
    id:`${Date.now()}-${Math.floor(Math.random()*1e6)}`,
    order_no:orderNo, artist, country,
    recipient_addr:recipient,
    addr_lookup:addrLookup,          // 客户把地址交给我查
    customer_name:document.getElementById('o-name').value.trim(),
    customer_phone:phone, return_addr:retAddr,
    letter_source:letterSource, letter_note:note,
    status:'created', pay_status:'unpaid',
    admin_note:'', media:[], created_at:Date.now(),
  }
  addOrder(order)
  lastOrderId=order.id
  const savedOK=lastSaveOK
  saveProfile(order)                 // 下次下单自动带出称呼 / 手机 / 回信地址

  document.getElementById('s-order-no').innerText='订单号 '+orderNo
  document.getElementById('s-pay').innerHTML=payGuideHtml(order)

  // 清空
  document.getElementById('o-artist').value=''
  document.getElementById('o-country').value=''
  document.getElementById('o-recipient').value=''
  document.getElementById('o-name').value=''
  document.getElementById('o-phone').value=''
  document.getElementById('o-return').value=''
  document.getElementById('o-note-proxy').value=''
  document.getElementById('o-note-self').value=''
  if(addrLookup) toggleAddrLookup()      // 复位地址代查开关

  goPage('success')
  setTimeout(()=>{ submitting=false }, 1200)
  if(!savedOK) toast('本机无法保存订单，请截图订单号')
}

function orderInfoText(o){
  return [
    '【艺人代寄 · 下单信息】',
    `订单号：${o.order_no}`,
    `艺人：${o.artist}`,
    `收信国家：${o.country}`,
    `收信地址：${o.recipient_addr || '（客户未填，见下方「地址代查」）'}`,
    `地址代查：${o.addr_lookup ? '需要（请帮我查这位艺人最新的收信地址）' : '不需要'}`,
    `我的称呼：${o.customer_name||'（未填）'}`,
    `手机号：${o.customer_phone}`,
    `回信地址：${o.return_addr}`,
    `信的来源：${o.letter_source==='proxy'?'需要代写':'自己手写'}`,
    `备注：${o.letter_note||'（无）'}`,
    `已付金额：¥190`,
  ].join('\n')
}
function copyOrderInfo(){ const o=getOrder(lastOrderId); if(!o)return; copyText(orderInfoText(o)) }
// 截图要翻相册、还会被清；复制一下才是真能用的保存方式
function copyOrderNo(){
  const o=getOrder(lastOrderId)
  if(!o){ toast('读不到订单号'); return }
  copyText(o.order_no)
}

// 一键分享：直接唤起系统分享面板，选微信就发过去了，比「复制→切微信→粘贴」少三步
async function shareOrderInfo(){
  const o=getOrder(lastOrderId)
  if(!o){ toast('读不到订单信息'); return }
  const text=orderInfoText(o)
  if(navigator.share){
    try { await navigator.share({ title:'艺人代寄 · 下单信息', text }); return }
    catch(e){ if(e && e.name==='AbortError') return }   // 用户自己取消了，不兜底
  }
  copyText(text)                                        // 不支持分享的浏览器：退回复制
}

// ==================== 付款引导卡 ====================
// 核心：把订单号后 4 位钉进客户的转账动作里。
// 客户填了备注，钱一到账就能直接对上单，不用来回问「你是谁」。
function payGuideHtml(o){
  const t = o.order_no.slice(-4)
  return `
    <div class="card pay-card">
      <div class="pay-card-top">
        <span class="pay-card-step">最后一步 · 付款</span>
        <span class="pay-card-amt">¥190</span>
      </div>

      <div class="pay-tail-block">
        <div class="pay-tail-label">转账 / 付款时，备注里填这 4 位</div>
        <div class="pay-tail">${t}</div>
        <button class="btn btn-large pay-tail-btn" onclick="copyText('${t}')">复制这 4 位</button>
      </div>

      <div class="pay-why">填上这 4 位，我一看到账就知道是你的单，不用再来回问你订单号。</div>

      <div class="pay-or"><span>然后扫码付款</span></div>

      <div class="qr-wrap">
        <img class="qr-img" src="${PAY_QR}" alt="收款码" onclick="previewImage(this.src)" onerror="qrFail(this)">
        <div class="qr-tip">长按识别二维码付款<br>或保存图片 → 微信扫一扫 → 相册选图</div>
      </div>

      <button class="btn-ghost" onclick="copyReceipt('${o.id}')">复制「已转账」回执发给客服</button>
    </div>`
}

// 收款码是唯一的付款入口，图挂了就等于客户付不了款 —— 必须给条出路
function qrFail(img){
  img.style.display='none'
  const box=img.parentElement
  if(!box||box.querySelector('.qr-fail')) return
  const tip=box.querySelector('.qr-tip')
  if(tip) tip.style.display='none'
  const d=document.createElement('div')
  d.className='qr-fail'
  d.innerHTML='收款码没能加载出来。<br>直接加客服 <b>'+wxId()+'</b> 要收款码，或下拉刷新重试。'
  box.appendChild(d)
}

function copyReceipt(id){
  const o=getOrder(id)
  if(!o){ toast('读不到订单信息'); return }
  copyText([
    '【已转账】',
    `订单号：${o.order_no}`,
    '金额：¥190',
    `转账备注：${o.order_no.slice(-4)}`,
  ].join('\n'))
  showGift()      // 刚付完款、正在等，是唯一值得送东西的时刻
}

// ==================== 送礼：写信指南 ====================
// 网站不知道钱什么时候真的到账（扫码 + 我手动确认，没有回调）。
// 所以「送礼」绑在客户自己点「我已转账」那一刻 —— 诚实，而且正是他需要它的时候。
const GIFT_SEEN='artist_letter_gift_seen'
let guideFrom='success'

function showGift(){
  try{ if(localStorage.getItem(GIFT_SEEN)) return }catch(e){}
  const m=document.getElementById('gift-mask')
  if(!m) return
  m.classList.add('on')
  try{ localStorage.setItem(GIFT_SEEN,'1') }catch(e){}
}
function closeGift(){
  const m=document.getElementById('gift-mask')
  if(m) m.classList.remove('on')
}
function openGuide(){
  const cur=document.querySelector('.page.active')
  if(cur && cur.id!=='page-guide') guideFrom=cur.id.replace('page-','')
  closeGift()
  goPage('guide')
}
// 从哪来回哪去 —— 从订单详情进来的，返回就不该跳到成功页
function goGuideBack(){ goPage(guideFrom) }

// ==================== 我的订单 ====================
function renderTrack(){
  const orders=allOrders().sort((a,b)=>(b.created_at||0)-(a.created_at||0))
  const listEl=document.getElementById('track-list')
  const emptyEl=document.getElementById('track-empty')
  const warnEl=document.getElementById('track-warn')

  if(warnEl){
    warnEl.innerHTML = storageOK() ? '' :
      '<div style="background:rgba(239,159,39,.1); border:1px solid rgba(239,159,39,.3); color:#EF9F27;'
      + ' border-radius:12px; padding:12px 14px; font-size:13px; line-height:1.6; margin-bottom:14px;">'
      + '⚠️ 当前浏览器不允许本地保存订单（可能是无痕模式）。订单不会留存，请截图订单号，'
      + '加微信 <b>' + wxId() + '</b> 查进度。</div>'
  }

  if(!orders.length){ listEl.innerHTML=''; emptyEl.style.display='block'; return }
  emptyEl.style.display='none'
  listEl.innerHTML=orders.map(o=>{
    const pending = o.addr_lookup && !String(o.recipient_addr||'').trim()
    return `
    <div class="card track-card" onclick="goPage('detail','${o.id}')">
      <div class="row"><div class="row-key">订单号</div><div class="row-val">${escapeHtml(o.order_no)}</div></div>
      <div class="row"><div class="row-key">艺人</div><div class="row-val">${escapeHtml(o.artist)}</div></div>
      <div class="row"><div class="row-key">状态</div><div class="row-val"><span class="${tagClass(o.status)}">${statusLabel(o.status)}</span></div></div>
      <div class="row"><div class="row-key">下单</div><div class="row-val">${fmtTimeHuman(o.created_at)}</div></div>
      ${pending?`<div class="track-pending">📍 地址我在查，查到会更新到这里，不用催</div>`:''}
    </div>`
  }).join('')
}

// ==================== 订单详情 ====================
function renderDetail(id){
  const o=getOrder(id)
  const wrap=document.getElementById('detail-wrap')
  if(!o){ wrap.innerHTML='<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">订单不存在</div></div>'; return }

  const cur=statusIndex(o.status)
  const steps=STATUS_FLOW.map((s,i)=>({label:s.label,hint:s.hint,dotClass:i<cur?'done':(i===cur?'current':'')}))
  const media=Array.isArray(o.media)?o.media:[]
  const imgs=media.filter(m=>m.kind==='image')
  const vid=media.filter(m=>m.kind==='video').pop()

  wrap.innerHTML=`
    <div class="hero" style="padding-bottom:10px;">
      <div class="hero-title" style="font-size:22px;">寄给 ${escapeHtml(o.artist)}</div>
      <div class="hero-sub">订单号 ${escapeHtml(o.order_no)} · ${fmtTime(o.created_at)}</div>
    </div>
    <button class="btn-ghost" style="margin-bottom:14px;" onclick="copyOrderNo()">复制订单号</button>
    ${o.status==='created'?payGuideHtml(o):''}
    <div class="card">
      <div class="card-title">进度</div>
      <div class="steps">
        ${steps.map((s,i)=>`
          <div class="step">${i<steps.length-1?'<div class="step-line"></div>':''}
            <div class="step-dot ${s.dotClass}"></div>
            <div class="step-body"><div class="step-title">${s.label}</div><div class="step-hint">${s.hint}</div></div>
          </div>
        `).join('')}
      </div>
    </div>
    <!-- 随单附赠的指南，随时能回来读 -->
    <div class="card gift-mini" onclick="openGuide()">
      <div class="gift-mini-title">🎁 写给明星的信 · 完整指南</div>
      <div class="gift-mini-desc">写什么、写多长、什么时候寄 —— 10 节讲透</div>
    </div>

    ${imgs.length?`
      <div class="card">
        <div class="card-title">手绘信封</div>
        <div class="gallery">${imgs.map(m=>`<img class="gallery-img" src="${m.path}" onclick="previewImage('${m.path}')">`).join('')}</div>
        <div class="tiny" style="margin-top:8px;">点击可放大查看</div>
      </div>
    `:''}
    ${vid?`
      <div class="card">
        <div class="card-title">投递视频</div>
        <video class="media" style="height:200px;" src="${vid.path}" controls playsinline></video>
      </div>
    `:''}
    ${o.admin_note?`
      <div class="card">
        <div class="card-title">我的留言</div>
        <div style="font-size:15px;color:#c8c7c2;">${escapeHtml(o.admin_note)}</div>
      </div>
    `:''}
    <div class="card">
      <div class="card-title">订单信息</div>
      <div class="row"><div class="row-key">艺人</div><div class="row-val">${escapeHtml(o.artist)}</div></div>
      <div class="row"><div class="row-key">收信国家</div><div class="row-val">${escapeHtml(o.country)}</div></div>
      <div class="row"><div class="row-key">收信地址</div><div class="row-val">${
        String(o.recipient_addr||'').trim() ? escapeHtml(o.recipient_addr)
        : (o.addr_lookup ? '<span style="color:#EF9F27;">待查 · 我查到后更新</span>' : '—')
      }</div></div>
      <div class="row"><div class="row-key">回信地址</div><div class="row-val">${escapeHtml(o.return_addr)}</div></div>
      <div class="row"><div class="row-key">付款</div><div class="row-val">${o.pay_status==='paid'?'已确认收款':'待付款'}</div></div>
      <div class="row"><div class="row-key">信的来源</div><div class="row-val">${o.letter_source==='proxy'?'需要代写':'自己手写'}</div></div>
      ${o.letter_note?`<div class="row"><div class="row-key">内容备注</div><div class="row-val">${escapeHtml(o.letter_note)}</div></div>`:''}
    </div>
  `
}

// ==================== 工具 ====================
function copyText(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=>toast('已复制')).catch(()=>fallbackCopy(text))
  }else{ fallbackCopy(text) }
}
function fallbackCopy(text){
  const ta=document.createElement('textarea')
  ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'
  document.body.appendChild(ta); ta.select()
  try{ document.execCommand('copy'); toast('已复制') }
  catch(e){ toast('复制失败，请手动长按复制') }
  document.body.removeChild(ta)
}
function previewImage(src){
  const div=document.createElement('div')
  div.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:200;display:flex;align-items:center;justify-content:center;'
  div.innerHTML=`<img src="${src}" style="max-width:92%;max-height:92%;border-radius:8px;" onclick="event.stopPropagation()">`
  div.onclick=()=>document.body.removeChild(div)
  document.body.appendChild(div)
}
let toastTimer=null
function toast(msg){
  let el=document.getElementById('toast')
  if(!el){ el=document.createElement('div'); el.id='toast'; document.body.appendChild(el) }
  el.innerText=msg; el.style.display='block'
  // 连续弹两条时，前一条的定时器会把后一条提前关掉 —— 必须清掉重计
  clearTimeout(toastTimer)
  toastTimer=setTimeout(()=>el.style.display='none',2200)
}

function escapeHtml(str){
  if(str===null||str===undefined) return ''
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}

// 校验失败时把出错那一栏直接标出来并滚过去。
// 只弹一句 toast 的话，长表单里客户根本不知道是哪一项没填。
// 注意用 block:'start' 而不是 'center' —— toast 就浮在屏幕正中，滚到中间会被它盖住。
function fieldError(id, msg){
  toast(msg)
  const el=document.getElementById(id)
  if(!el) return
  el.classList.add('field-error')
  el.scrollIntoView({behavior:'smooth', block:'start'})
  setTimeout(()=>el.classList.remove('field-error'), 2400)
}

// ==================== 启动 ====================
// 顶部信任条是吸顶的，页面导航栏也吸顶。两条都 top:0 就会叠在一起，
// 把返回键压在下面。这里实测信任条高度写进 CSS 变量，让导航栏贴在它下面。
function syncTrustBarHeight(){
  const tb=document.querySelector('.trust-bar')
  if(!tb) return
  const h=tb.offsetHeight
  if(h>0) document.documentElement.style.setProperty('--trustbar-h', h+'px')
}

window.addEventListener('DOMContentLoaded',()=>{
  syncTrustBarHeight()
  initHome()
  goPage('home')
})
window.addEventListener('resize', syncTrustBarHeight)
window.addEventListener('orientationchange', syncTrustBarHeight)
