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

// 收款二维码开关。
// 图挂了就等于客户付不了款，所以留一个开关方便紧急下线；默认开启。
// （曾经误以为 images/pay-qr.jpg 是占位图而关掉过 —— DWAY 确认那是他本人的收款码。）
const PAY_QR_READY = true

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
  // 进这两个页面就去服务端拉一次最新进度 —— 本机那份是下单时的快照，不是真相。
  // 不 await：页面先出来，进度随后到（拉到了会自己重渲染）。
  if(name==='detail' && param) refreshMyOrders({ only: param })
  if(name==='track') refreshMyOrders()
  if(name==='order'){
    restoreProfile()      // 回头客：自动带出上次填过的信息
    bindFormProgress()    // 进度条跟着已填项走（restoreProfile 带出来的也算）
    updateFormProgress()
  }

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
// 往这里丢实拍图路径即可。SHOWCASE[0] 会同时成为首页主视觉，
// 全部图片进作品墙 —— 一次填写，点亮两处。
const SHOWCASE=[]

// 主视觉「图片就绪」：
// 这个页面卖的是手绘信封 —— 一件纯视觉的手工件，但整站原本没有一张产品图，
// 首屏只有渐变上的文字。在信息流里划到这一页的人，0.3 秒内需要一个具象锚点，
// 而文字和符号化图标给不了。有实拍图就把图顶到标题上面；没有就保持纯文字，
// 不会出现空框或破图。
function initHero(){
  const fig=document.getElementById('hero-figure')
  if(!fig) return
  const src=SHOWCASE[0]
  if(!src){ fig.style.display='none'; return }
  fig.style.display='block'
  fig.innerHTML=`<img class="hero-figure-img" src="${escapeHtml(src)}" alt="手绘信封实拍" onclick="previewImage(this.src)">`
}

function initHome(){
  initContacts()
  initHero()
  const sec=document.getElementById('showcase-section')
  if(!sec) return
  // 显隐双向设置 —— 只写 block 的话，数组变空时这一段永远收不回去
  sec.style.display = SHOWCASE.length ? 'block' : 'none'
  if(SHOWCASE.length){
    document.getElementById('showcase-gallery').innerHTML=SHOWCASE.map(src=>
      `<img class="gallery-img" src="${escapeHtml(src)}" onclick="previewImage(this.src)">`
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
  updateFormProgress()          // 选了「代写」会多出一项必填，进度得跟着变
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
  updateFormProgress()          // 勾上之后「收信地址」就不算缺项了
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
  syncOrderToCloud(order)            // 同时送一份到服务端（见下方说明）

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
  const tail = o.order_no.slice(-4)
  return [
    '【艺人代寄 · 下单信息】',
    `订单号：${o.order_no}`,
    // 这 4 位是 DWAY 在微信收款通知里唯一能看到的东西。
    // 放进订单信息里，他一眼就能把「谁付的钱」和「谁的单」对上，不用来回问。
    `付款备注（4 位）：${tail}`,
    `艺人：${o.artist}`,
    `收信国家：${o.country}`,
    `收信地址：${o.recipient_addr || '（客户未填，见下方「地址代查」）'}`,
    `地址代查：${o.addr_lookup ? '需要（请帮我查这位艺人最新的收信地址）' : '不需要'}`,
    `我的称呼：${o.customer_name||'（未填）'}`,
    `手机号：${o.customer_phone}`,
    `回信地址：${o.return_addr}`,
    `信的来源：${o.letter_source==='proxy'?'需要代写':'自己手写'}`,
    `备注：${o.letter_note||'（无）'}`,
    // 客户上午下单、我晚上才把这段补进台账，没有这一行，这单就会显示成「刚下的」，
    // 待办排序和「多久没动」全都跟着错。
    `下单时间：${stampText(o.created_at)}`,
    // 不能写「已付」——客户可能在付款前就点了分享，那时钱还没到账
    `订单金额：¥190`,
  ].join('\n')
}
function stampText(ts){
  const d = new Date(ts || Date.now()), p = n => String(n).padStart(2,'0')
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 把订单同时送到服务端 —— 这样换任何设备、清缓存，我这边都看得到。
//
// 只有服务端**明确回了成功**，才告诉客户「不用再发一遍」。
// 服务端是先落盘再回话的，所以 ok:true 就是真的收到了。
// 没收到（服务没开 / 网络不通 / 报错）就什么都不改 —— 上面那句琥珀色警告原样留着，
// 客户照旧会发我一次。宁可多发一遍，也不能出现「客户以为我收到了、其实没有」。
//
// 推送本身带 3 次重试（见 cloud.js），最终失败会落进一个持久队列，
// 之后每次打开页面 / 回到前台 / 联网都会自动补推 ——
// 所以「点了下单、那一瞬间网络抖了一下」不会再让这一单永久消失。
function setCloudState(kind, r){
  const st = document.getElementById('cloud-state')
  if(!st) return
  if(kind === 'pending'){
    st.innerHTML = '<div class="cloud-pending">正在把你的订单直接送到我这边…</div>'
    return
  }
  if(kind === 'ok'){
    st.innerHTML = '<div class="cloud-ok">✓ 已经直接送到我这边了 —— 这一单不用再发一遍</div>'
    return
  }
  if(kind === 'queued'){
    st.innerHTML = '<div class="cloud-warn">⚠️ 这一单暂时没送出去，已经排上队了 —— '
      + '网络一好会自动补发。<b>保险起见，还是点上面那个「发给客服」发我一次。</b></div>'
    return
  }
  st.innerHTML = '<div class="cloud-warn">⚠️ 没能直接送到我这边（'
    + escapeHtml(cloudWhy(r)) + '）。<b>请点上面那个「发给客服」把订单信息发我一次。</b></div>'
}

function cloudWhy(r){
  if(!r) return '未知原因'
  if(r.net) return '网络不通'
  if(r.off) return '同步未开启'
  if(r.status === 429) return '请求太频繁'
  if(r.status >= 500) return '服务端暂时不可用'
  return r.error ? String(r.error) : '服务端没确认'
}

function syncOrderToCloud(order){
  if(!window.Cloud || !Cloud.on()) return
  setCloudState('pending')
  Cloud.pushOrder(order).then(r => {
    if(r && r.ok){
      updOrder(order.id, { cloud_at: Date.now() })
      setCloudState('ok')
      const tip = document.getElementById('save-tip')
      if(tip){
        // 警告降级成提示：它警告的那件事（我看不到）已经不成立了。
        tip.className = 'save-tip'
        tip.innerHTML = '订单号已经记在你这台设备上，也同步给我了。<br>'
          + '想留个底就截个图 —— 换手机、清缓存后本地这份会没，但我这边有。'
      }
      return
    }
    // 落队列了：文案要说清「已经排上队」，而不是让客户以为彻底失败了
    setCloudState(Cloud.pending && Cloud.pending() > 0 ? 'queued' : 'fail', r)
  })
}

// 队列补推成功时，把成功页那句话也改过来（客户可能还停在这一页）
window.__onPushFlushed = function(r){
  if(!lastOrderId) return
  const o = getOrder(lastOrderId)
  if(!o || o.cloud_at) return
  if(o.order_no && Cloud.pending && Cloud.pending() === 0){
    updOrder(lastOrderId, { cloud_at: Date.now() })
    setCloudState('ok')
    const tip = document.getElementById('save-tip')
    if(tip){
      tip.className = 'save-tip'
      tip.innerHTML = '订单号已经记在你这台设备上，也同步给我了。<br>'
        + '想留个底就截个图 —— 换手机、清缓存后本地这份会没，但我这边有。'
    }
  }
}

// 地址自愈了：如果客户正停在成功页，状态条要跟着更新
window.__onCloudBaseHealed = function(d){
  if(window.Cloud && Cloud.on()) setCloudState('pending')
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
  const wx = wxId()
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

      <div class="pay-why">转账时我这边看不到订单内容 —— 备注里填上这 4 位，我一看到账就知道钱是你付的。</div>

      <div class="pay-methods">

        <div class="pay-method pay-method-primary">
          <div class="pay-method-head">
            <span class="pay-method-num">①</span>
            <span class="pay-method-title">微信好友转账（推荐）</span>
          </div>
          <div class="pay-wx-row">
            <div class="pay-wx-label">今天找</div>
            <div class="pay-wx-id">${wx}</div>
            <button class="contact-copy" onclick="copyText('${wx}')">复制</button>
          </div>
          <div class="pay-method-foot">微信 → 搜索上面的 ID → 转账 ¥190 → 备注 <b>${t}</b></div>
        </div>

        ${PAY_QR_READY ? `
        <div class="pay-method">
          <div class="pay-method-head">
            <span class="pay-method-num">②</span>
            <span class="pay-method-title">微信扫码付款（备用）</span>
          </div>
          <div class="qr-wrap">
            <img class="qr-img" src="${PAY_QR}" alt="收款码" onclick="previewImage(this.src)" onerror="qrFail(this)">
            <div class="qr-tip">长按识别二维码付款<br>或保存图片 → 微信扫一扫 → 相册选图</div>
          </div>
        </div>
        ` : `
        <div class="pay-method pay-method-disabled">
          <div class="pay-method-head">
            <span class="pay-method-num">②</span>
            <span class="pay-method-title">微信扫码付款</span>
            <span class="pay-method-tag">维护中</span>
          </div>
          <div class="pay-method-disabled-d">
            收款二维码暂时无法使用 —— 请用上方「好友转账」完成付款，<br>
            备注里填好那 4 位就行。
          </div>
        </div>
        `}

      </div>

      <button class="btn-ghost" onclick="copyReceipt('${o.id}')">复制「已转账」回执发给客服</button>

      <!-- 第 ③ 步：服务器到没看到取决于云端同步。
           同步成功会自动降级下面那条琥珀色警告（见 syncOrderToCloud）。 -->
      <div class="pay-handoff">
        <div class="pay-handoff-h">③ 付完款，把订单信息发我一次（兜底）</div>
        <div class="pay-handoff-d">
          服务端那边有没有收到取决于同步有没有成功（页面下方会显示）。
          <b>没看到「已经直接送到我这边了」</b>，就把订单信息复制发我一次；
          <b>看到了</b>，可以跳过这一步。
        </div>
        <button class="btn btn-large" onclick="shareOrderInfo()">发给客服（一键分享）</button>
        <button class="btn-ghost" onclick="copyOrderInfo()">复制下单信息</button>
        <div id="cloud-state"></div>
      </div>
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
  const localHead=document.getElementById('track-local-head')

  if(warnEl){
    warnEl.innerHTML = storageOK() ? '' :
      '<div style="background:rgba(239,159,39,.1); border:1px solid rgba(239,159,39,.3); color:#EF9F27;'
      + ' border-radius:12px; padding:12px 14px; font-size:13px; line-height:1.6; margin-bottom:14px;">'
      + '⚠️ 当前浏览器不允许本地保存订单（可能是无痕模式）。订单不会留存，请截图订单号，'
      + '加微信 <b>' + wxId() + '</b> 查进度。</div>'
  }

  if(!orders.length){
    listEl.innerHTML=''
    emptyEl.style.display='block'
    if(localHead) localHead.style.display='none'      // 没本机单就别挂这个标题
    return
  }
  emptyEl.style.display='none'
  if(localHead) localHead.style.display='block'
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

// 换设备查订单：输订单号 + 手机号后 4 位
//
// 边界：
//   - 服务端对「不存在的订单号」和「手机号不匹配」返回同一个 404（不泄漏存在性）；
//   - 这里就把所有 404 都显示成「没找到」；
//   - 服务端 503 = 仓库暂时打不通，诚实说「现在查不到，再试一次」而不是给假数据。
let lastLookup = null      // 最近一次查到的服务端订单（「存到这台设备」要用）

// 把查回来的那一单落进本机 —— 之后它就会跟着「进度自动刷新」一起走。
// 不自动存、给一个明确的按钮，是因为「本机的订单」这个标题必须诚实：
// 客户得知道这一条是他自己存进来的，而不是凭空出现的。
function saveLookedUp(){
  const o = lastLookup
  if(!o || !o.order_no) return
  if(allOrders().some(x => x.order_no === o.order_no)){ toast('这一单已经在这台设备上了'); return }
  // 服务端那份的 id 是当初下单那台设备生成的，这里必须换成这台设备的本地 id，
  // 否则两台设备的 id 撞在一起时，卡片、展开状态全会串位。
  const local = Object.assign({}, o, {
    id: 'lk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    sync_at: Date.now(),
  })
  addOrder(local)
  toast('已存到这台设备')
  goPage('track')
}

async function lookupOrder(){
  const noEl = document.getElementById('lookup-no')
  const phEl = document.getElementById('lookup-phone')
  const out  = document.getElementById('lookup-result')
  if(!noEl || !phEl || !out) return

  const no   = String(noEl.value || '').trim().toUpperCase()
  const phRaw = String(phEl.value || '').replace(/\D/g, '')
  if(!/^AL\d{8}[A-Z0-9]{6}$/.test(no)){
    out.innerHTML = '<div class="lookup-err">订单号格式看着不对 —— 应该是 AL 开头、14 位的</div>'
    return
  }
  if(phRaw.length !== 4){
    out.innerHTML = '<div class="lookup-err">填一下下单用的手机号<b>后 4 位</b></div>'
    return
  }

  out.innerHTML = '<div class="lookup-loading">查询中…</div>'

  if(!window.Cloud || !Cloud.on()){
    out.innerHTML = '<div class="lookup-err">没启用云端同步 —— 没法跨设备查。请在「首页底部」按客服微信问进度。</div>'
    return
  }
  const r = await Cloud.lookupOrder(no, phRaw).catch(() => null)
  if(r && r.ok && r.order){
    const o = r.order
    lastLookup = o
    const already = allOrders().some(x => x.order_no === o.order_no)
    out.innerHTML = `
      <div class="lookup-hit">
        <div class="lookup-hit-head">查到了 ✓ 这是你的单</div>
        <div class="row"><div class="row-key">订单号</div><div class="row-val">${escapeHtml(o.order_no)}</div></div>
        <div class="row"><div class="row-key">艺人</div><div class="row-val">${escapeHtml(o.artist)}</div></div>
        <div class="row"><div class="row-key">状态</div><div class="row-val"><span class="${tagClass(o.status)}">${statusLabel(o.status)}</span></div></div>
        <div class="row"><div class="row-key">下单时间</div><div class="row-val">${fmtTimeHuman(o.created_at)}</div></div>
        <div class="row"><div class="row-key">更新时间</div><div class="row-val">${fmtTimeHuman(o.updated_at || o.created_at)}</div></div>
        ${already ? '' :
          '<button class="btn" style="margin-top:12px;width:100%;" onclick="saveLookedUp()">存到这台设备</button>'
          + '<div class="tiny" style="margin-top:6px;">存下之后，这一单会出现在「本机的订单」里，进度更新会自动跟着走</div>'}
      </div>`
    return
  }
  if(r && r.status === 503){
    out.innerHTML = '<div class="lookup-err">现在查不到（同步服务暂时不通），稍等再试一次</div>'
    return
  }
  // 404 / 网络 / 其他 —— 一律说「没找到」，不暴露技术细节
  out.innerHTML = '<div class="lookup-err">没找到这一单 —— 检查一下订单号和手机号后 4 位对不对</div>'
}

// ==================== 从服务端刷新进度 ====================
//
// 「我更新了进度，客户端看不到 / 换台设备也看不到」的根因就在这一段缺失：
// 「我的订单」和「订单详情」原本**只读本机 localStorage**，
// 而本机那份是「下单那一刻的快照」——它永远不会自己变。
// 后台把状态从「制作中」改成「已寄出」，客户端还一直显示「制作中」，
// 客户会以为你根本没动过他的单。这是最伤信任的一类 bug，比看不到单还糟。
//
// 所以每次进这两个页面，都拿本机每一单去服务端问一次最新状态，合并回本地。
//
// 合并规则（很重要）：**只覆盖服务端确实返回了的字段**。
// 服务端会主动剔除 admin_note 这类内部字段；如果无脑整体替换，
// 客户本机存的「我的留言」会在一次刷新之后凭空消失。
//
// 限流：服务端查单接口是 30 次/小时/IP，必须克制 ——
//   · 单笔冷却 60 秒     —— 反复切页面不会反复打同一个单
//   · 单次最多 6 单      —— 客户手上通常只有 1~2 单
//   · 优先刷「最久没刷过」的 —— 单子多的时候自然轮转，不会永远只刷前几单
//   · 撞上 429 立刻停手
const REFRESH_ONE_MS = 60000
const REFRESH_MAX    = 6

// 客户端该认服务端的哪些字段。
// 刻意**不含** admin_note：服务端不会把它给客户端（那是后台内部备注），
// 放进来只会在每次刷新时把本机那份抹掉。
const SYNC_FIELDS = ['status','pay_status','recipient_addr','addr_lookup','media',
                     'updated_at','artist','country','return_addr','letter_source','letter_note']

let refreshRunning = null      // 正在跑的那一次（见下）

// 服务端那一份 vs 本机这一份 —— 只挑出真正不一样、且服务端确实给了的字段
function serverPatch(local, remote){
  const patch = {}
  SYNC_FIELDS.forEach(k => {
    if(remote[k] === undefined) return                       // 服务端没这个字段 → 不动本机的
    if(JSON.stringify(remote[k]) === JSON.stringify(local[k])) return
    patch[k] = remote[k]
  })
  return patch
}

// 同步状态行。两个页面共用同一个函数 —— 文案只有一个来源，不会两边说法不一致。
function syncLine(html, kind){
  ;['track-sync','detail-sync'].forEach(id => {
    const el = document.getElementById(id)
    if(!el) return
    if(!html){ el.style.display='none'; el.innerHTML=''; return }
    el.style.display = 'block'
    el.className = 'track-sync' + (kind ? ' ' + kind : '')
    el.innerHTML = html
  })
}
const syncRetryBtn = '<button class="sync-btn" onclick="refreshMyOrders({manual:true})">重试</button>'

// opts.only  只刷这一单（进订单详情时用，不必把整份都拉一遍）
// opts.manual 用户主动点的 —— 不受「刚刷过」的影响
//
// 同一时刻只允许一次在跑。但**手动点按钮时必须能等到结果**：
// 原来撞上正在跑的自动刷新就直接返回 {busy:true}，按钮看起来完全没反应，
// 客户会以为坏了、然后一直点 —— 所以这里把手动请求接到同一次上，等它跑完。
function refreshMyOrders(opts){
  const o = opts || {}
  if(refreshRunning) return refreshRunning
  refreshRunning = doRefreshOrders(o).then(
    r => { refreshRunning = null; return r },
    e => { refreshRunning = null; throw e }
  )
  return refreshRunning
}

async function doRefreshOrders(o){
  if(!window.Cloud || !Cloud.on()){ syncLine('', ''); return { ok:false, off:true } }

  const all = allOrders()
  if(!all.length){ syncLine('', ''); return { ok:true, checked:0 } }

  const now = Date.now()
  let pool = all.filter(x => x.order_no)
  if(o.only) pool = pool.filter(x => x.id === o.only)
  // 最久没刷过的排前面 —— 单子多的时候自然轮转
  pool.sort((a,b) => (Number(a.sync_at)||0) - (Number(b.sync_at)||0)
                  || (Number(b.created_at)||0) - (Number(a.created_at)||0))
  // 手动点「刷新进度」是他明确表达了「现在就要」——
  // 只留 5 秒的最小间隔防连点，不再让他等满 60 秒冷却。
  // （自动刷新必须守 60 秒：服务端查单接口限流 30 次/小时/IP。）
  const gap = o.manual ? 5000 : REFRESH_ONE_MS
  let targets = pool.filter(x => now - (Number(x.sync_at)||0) > gap)
  if(!o.only) targets = targets.slice(0, REFRESH_MAX)
  if(!targets.length){
    // 手动点的却什么都没刷 → 必须给一句回应，不能默默什么都不发生
    if(o.manual) syncLine('刚刚已经刷过一次了，稍等一下再点', '')
    else syncLine('', '')
    return { ok:true, checked:0 }
  }

  syncLine('正在同步最新进度…', 'busy')

  let checked = 0, changed = 0, failed = 0, limited = false
  for(const ord of targets){
    let r = null
    try { r = await Cloud.lookupOrder(ord.order_no, ord.customer_phone) } catch(e){ r = null }

    if(r && r.status === 429){ limited = true; break }        // 限流了就别再打
    if(r && r.ok && r.order){
      checked++
      const patch = serverPatch(ord, r.order)
      if(Object.keys(patch).length) changed++
      updOrder(ord.id, Object.assign(patch, { sync_at: Date.now() }))
      continue
    }
    // 404 / 400 = 这一单服务端查不到（还没推上去，或手机尾号对不上）——
    // 这不是「同步坏了」，是这一单本来就没上去，不该拿它吓客户。
    if(r && (r.status === 404 || r.status === 400)){ continue }
    failed++
  }

  // 状态变了 → 重渲染。必须先渲染再写状态行：renderDetail 会重建 #detail-sync。
  const cur = document.querySelector('.page.active')
  const onTrack  = cur && cur.id === 'page-track'
  const onDetail = cur && cur.id === 'page-detail'
  if(changed){
    if(onTrack) renderTrack()
    if(onDetail && lastOrderId) renderDetail(lastOrderId)
  }

  if(limited){
    syncLine('查询有点频繁，稍等一会儿再点「刷新进度」' + syncRetryBtn, 'warn')
  }else if(checked === 0 && failed){
    // 一单都没拉到 —— 必须说清「你现在看到的进度可能是旧的」，不能装作没事
    syncLine('⚠️ 没连上服务端，下面显示的进度可能是旧的' + syncRetryBtn, 'warn')
  }else if(changed){
    syncLine('✓ 进度刚刚更新过')
  }else{
    syncLine('✓ 已是最新 · 刚刚同步')
  }
  return { ok:true, checked, changed, failed, limited }
}

// 回到前台 / 网络恢复 —— 顺手刷一次，客户不用自己想起来点刷新
document.addEventListener('visibilitychange', () => {
  if(document.hidden) return
  const cur = document.querySelector('.page.active')
  if(cur && (cur.id === 'page-track' || cur.id === 'page-detail')) refreshMyOrders()
})
window.addEventListener('online', () => {
  const cur = document.querySelector('.page.active')
  if(cur && (cur.id === 'page-track' || cur.id === 'page-detail')) refreshMyOrders()
})

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
    <!-- 进度同步状态：进这一页会单独刷这一单，结果如实写在这里 -->
    <div id="detail-sync" class="track-sync" style="display:none;"></div>
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
      <div class="gift-mini-title">🎁 写给明星的信</div>
      <div class="gift-mini-desc">为什么值得写 · 加 10 节实操（写什么 / 写多长 / 何时寄）</div>
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
      ${o.updated_at?`<div class="row"><div class="row-key">进度更新</div><div class="row-val">${fmtTimeHuman(o.updated_at)}</div></div>`:''}
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

// ==================== 填写进度 ====================
// 长表单最劝退的不是「要填很多」，而是「不知道还剩多少」。
// 这里把必填项摊开成一份清单，实时算完成度 —— 和 submitOrder 的校验口径保持一致，
// 免得出现「进度条满了但提交还是被打回」这种最伤信任的情况。
function formRequirements(){
  const val = id => { const el=document.getElementById(id); return el ? el.value.trim() : '' }
  const need = [
    { id:'o-artist',    label:'艺人姓名', ok: !!val('o-artist') },
    { id:'o-country',   label:'收信国家', ok: !!val('o-country') },
    // 勾了「帮我查地址」就不算缺 —— 这正是那个开关的意义
    { id:'o-recipient', label:'收信地址', ok: !!val('o-recipient') || addrLookup },
    { id:'o-phone',     label:'手机号',   ok: /^[\d\s+()\-]{6,}$/.test(val('o-phone')) },
    { id:'o-return',    label:'回信地址', ok: !!val('o-return') },
  ]
  if(letterSource==='proxy') need.push({ id:'o-note-proxy', label:'代写要点', ok: !!val('o-note-proxy') })
  return need
}

function updateFormProgress(){
  const fill=document.getElementById('fp-fill')
  const cnt=document.getElementById('fp-count')
  const hint=document.getElementById('fp-hint')
  if(!fill || !cnt || !hint) return          // 不在这一页，静默跳过

  const need=formRequirements()
  const done=need.filter(n=>n.ok).length
  const total=need.length
  fill.style.width=(total?Math.round(done/total*100):0)+'%'
  cnt.textContent=done+'/'+total

  if(done===total){
    hint.textContent='信息齐了，可以提交了'
    hint.className='form-fill-hint done'
  }else{
    const miss=need.filter(n=>!n.ok).map(n=>n.label)
    hint.textContent='还差 '+miss.length+' 项：'+miss.join(' · ')
    hint.className='form-fill-hint'
  }
}

// 只在初始化时挂一次监听，别在每次进页面时重复挂 —— 那会越挂越多
let formProgressBound=false
function bindFormProgress(){
  if(formProgressBound) return
  formProgressBound=true
  // 注意这行结尾的分号不能省：省掉的话下一行的 `[` 会被当成
  // `true['o-artist',...]` 的下标访问（ASI 陷阱），运行时直接报
  // 「Cannot read properties of undefined (reading 'forEach')」。
  const ids=['o-artist','o-country','o-recipient','o-phone','o-return','o-note-proxy','o-note-self'];
  ids.forEach(id=>{
    const el=document.getElementById(id)
    if(!el) return
    el.addEventListener('input', updateFormProgress)
    el.addEventListener('change', updateFormProgress)
  })
  // 页面从后台切回来时补算一次：手机上切出去接了个电话回来，状态不能是旧的
  window.addEventListener('pageshow', updateFormProgress)
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) updateFormProgress() })
  updateFormProgress()
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
  bindFormProgress()
  goPage('home')
})
window.addEventListener('resize', syncTrustBarHeight)
window.addEventListener('orientationchange', syncTrustBarHeight)
