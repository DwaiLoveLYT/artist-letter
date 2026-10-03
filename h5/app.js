// ==================== 配置 ====================
const CONTACT_WX = 'IMDWAY'
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

// ==================== 存储 ====================
const STORE_KEY='artist_letter_orders_v1'
function allOrders(){
  try{ const raw=localStorage.getItem(STORE_KEY); const list=JSON.parse(raw); return Array.isArray(list)?list:[] }
  catch(e){ return [] }
}
function saveOrders(list){ localStorage.setItem(STORE_KEY, JSON.stringify(list)) }
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
  if(SHOWCASE.length){
    document.getElementById('showcase-section').style.display='block'
    document.getElementById('showcase-gallery').innerHTML=SHOWCASE.map(src=>
      `<img class="gallery-img" src="${src}" onclick="previewImage('${src}')">`
    ).join('')
  }
}

// ==================== 下单 ====================
let letterSource='self'
function setLetterSource(el){
  letterSource=el.dataset.value
  document.querySelectorAll('#page-order .radio').forEach(r=>r.classList.remove('on'))
  el.classList.add('on')
  document.getElementById('proxy-note-box').style.display=letterSource==='proxy'?'block':'none'
  document.getElementById('self-note-box').style.display=letterSource==='self'?'block':'none'
}

function submitOrder(){
  const artist=document.getElementById('o-artist').value.trim()
  const country=document.getElementById('o-country').value.trim()
  const recipient=document.getElementById('o-recipient').value.trim()
  const phone=document.getElementById('o-phone').value.trim()
  const retAddr=document.getElementById('o-return').value.trim()
  const note=letterSource==='proxy'
    ? document.getElementById('o-note-proxy').value.trim()
    : document.getElementById('o-note-self').value.trim()

  if(!artist){ toast('请填写艺人姓名'); return }
  if(!country){ toast('请填写收信国家'); return }
  if(!recipient){ toast('请填写收信地址'); return }
  if(!phone){ toast('请填写手机号'); return }
  if(!retAddr){ toast('请填写回信地址'); return }
  if(letterSource==='proxy' && !note){ toast('选择代写时，请填写想说的话'); return }

  const orderNo=makeOrderNo()
  const order={
    id:`${Date.now()}-${Math.floor(Math.random()*1e6)}`,
    order_no:orderNo, artist, country,
    recipient_addr:recipient,
    customer_name:document.getElementById('o-name').value.trim(),
    customer_phone:phone, return_addr:retAddr,
    letter_source:letterSource, letter_note:note,
    status:'created', pay_status:'unpaid',
    admin_note:'', media:[], created_at:Date.now(),
  }
  addOrder(order)
  lastOrderId=order.id

  document.getElementById('s-order-no').innerText='订单号 '+orderNo
  document.getElementById('s-tail').innerText=orderNo.slice(-4)
  document.getElementById('s-tail2').innerText=orderNo.slice(-4)

  // 清空
  document.getElementById('o-artist').value=''
  document.getElementById('o-country').value=''
  document.getElementById('o-recipient').value=''
  document.getElementById('o-name').value=''
  document.getElementById('o-phone').value=''
  document.getElementById('o-return').value=''
  document.getElementById('o-note-proxy').value=''
  document.getElementById('o-note-self').value=''

  initHome() // 更新顶部统计
  goPage('success')
}

function orderInfoText(o){
  return [
    '【艺人代寄 · 下单信息】',
    `订单号：${o.order_no}`,
    `艺人：${o.artist}`,
    `收信国家：${o.country}`,
    `收信地址：${o.recipient_addr}`,
    `我的称呼：${o.customer_name||'（未填）'}`,
    `手机号：${o.customer_phone}`,
    `回信地址：${o.return_addr}`,
    `信的来源：${o.letter_source==='proxy'?'需要代写':'自己手写'}`,
    `备注：${o.letter_note||'（无）'}`,
    `已付金额：¥190`,
  ].join('\n')
}
function copyOrderInfo(){ const o=getOrder(lastOrderId); if(!o)return; copyText(orderInfoText(o)) }

// ==================== 我的订单 ====================
function renderTrack(){
  const orders=allOrders().sort((a,b)=>(b.created_at||0)-(a.created_at||0))
  const listEl=document.getElementById('track-list')
  const emptyEl=document.getElementById('track-empty')

  if(!orders.length){ listEl.innerHTML=''; emptyEl.style.display='block'; return }
  emptyEl.style.display='none'
  listEl.innerHTML=orders.map(o=>`
    <div class="card" onclick="goPage('detail','${o.id}')" style="cursor:pointer;">
      <div class="row"><div class="row-key">订单号</div><div class="row-val">${o.order_no}</div></div>
      <div class="row"><div class="row-key">艺人</div><div class="row-val">${o.artist}</div></div>
      <div class="row"><div class="row-key">状态</div><div class="row-val"><span class="${tagClass(o.status)}">${statusLabel(o.status)}</span></div></div>
      <div class="row"><div class="row-key">下单时间</div><div class="row-val">${fmtTime(o.created_at)}</div></div>
    </div>
  `).join('')
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
      <div class="hero-title" style="font-size:22px;">寄给 ${o.artist}</div>
      <div class="hero-sub">订单号 ${o.order_no} · ${fmtTime(o.created_at)}</div>
    </div>
    ${o.status==='created'?'<div class="notice">等待收款确认。转账后请稍候，我确认后会立刻推进。</div>':''}
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
      <div class="row"><div class="row-key">艺人</div><div class="row-val">${o.artist}</div></div>
      <div class="row"><div class="row-key">收信国家</div><div class="row-val">${o.country}</div></div>
      <div class="row"><div class="row-key">收信地址</div><div class="row-val">${escapeHtml(o.recipient_addr)}</div></div>
      <div class="row"><div class="row-key">回信地址</div><div class="row-val">${escapeHtml(o.return_addr)}</div></div>
      <div class="row"><div class="row-key">付款</div><div class="row-val">${o.pay_status==='paid'?'已确认收款':'待付款'}</div></div>
      <div class="row"><div class="row-key">信的来源</div><div class="row-val">${o.letter_source==='proxy'?'需要代写':'自己手写'}</div></div>
      ${o.letter_note?`<div class="row"><div class="row-key">内容备注</div><div class="row-val">${escapeHtml(o.letter_note)}</div></div>`:''}
    </div>
  `
}

// ==================== 管理台账 ====================
let adminFilterKey='all'
const FIELD_MAP={
  订单号:'order_no', 艺人:'artist', 收信国家:'country', 收信地址:'recipient_addr',
  我的称呼:'customer_name', 手机号:'customer_phone', 回信地址:'return_addr', 备注:'letter_note'
}
function parseOrderText(text){
  const order={}
  text.split('\n').forEach(line=>{
    const m=/^\s*(.+?)\s*[:：]\s*(.*)\s*$/.exec(line)
    if(!m)return
    const key=m[1].replace(/^【|】$/g,'').trim()
    const val=m[2].trim()
    if(FIELD_MAP[key])order[FIELD_MAP[key]]=val
    if(key==='信的来源')order.letter_source=val.indexOf('代写')>=0?'proxy':'self'
  })
  return order
}
function adminFilter(el){ adminFilterKey=el.dataset.filter; document.querySelectorAll('#page-admin .chip').forEach(c=>c.classList.remove('on')); el.classList.add('on'); renderAdmin() }
function adminSearch(){ renderAdmin() }

function adminReconcile(){
  const tail = document.getElementById('a-reconcile').value.trim().toUpperCase()
  const resultEl = document.getElementById('reconcile-result')
  if(!tail || tail.length !== 4){
    resultEl.innerHTML = '<div style="color:#EF9F27; font-size:13px;">请输入 4 位字母/数字</div>'
    return
  }
  const orders = allOrders().filter(o => {
    const no = (o.order_no || '').toUpperCase()
    return no.slice(-4) === tail
  })
  if(!orders.length){
    resultEl.innerHTML = '<div style="color:#EF9F27; font-size:13px;">没有找到匹配的订单，可能客户还没发给我</div>'
    return
  }
  const o = orders[0]
  const isPaid = o.pay_status === 'paid'
  resultEl.innerHTML = `
    <div class="card" style="margin-top:10px; margin-bottom:0;">
      <div class="row"><div class="row-key">订单号</div><div class="row-val">${o.order_no}</div></div>
      <div class="row"><div class="row-key">艺人</div><div class="row-val">${o.artist}</div></div>
      <div class="row"><div class="row-key">付款状态</div><div class="row-val" style="color:${isPaid?'#5DCAA5':'#EF9F27'}">${isPaid?'已收款':'待付款'}</div></div>
      ${!isPaid ? `<button class="btn" style="margin-top:8px; margin-bottom:0;" onclick="adminMarkPaid('${o.id}'); document.getElementById('reconcile-result').innerHTML=''; document.getElementById('a-reconcile').value=''; toast('已标记收款'); renderAdmin();">✓ 标记这笔已收款</button>` : '<div class="tiny" style="margin-top:8px; color:#5DCAA5;">这笔已经标记过了</div>'}
    </div>
  `
}

function renderAdmin(){
  const word=(document.getElementById('a-keyword').value||'').trim().toUpperCase()
  let orders=allOrders().sort((a,b)=>(b.created_at||0)-(a.created_at||0))

  document.getElementById('a-stat-unpaid').innerText=orders.filter(o=>o.pay_status!=='paid').length
  document.getElementById('a-stat-draw').innerText=orders.filter(o=>o.status==='drawing').length
  document.getElementById('a-stat-mail').innerText=orders.filter(o=>o.status==='mailed').length

  if(adminFilterKey!=='all') orders=orders.filter(o=>o.status===adminFilterKey)
  if(word) orders=orders.filter(o=>{
    const no=(o.order_no||'').toUpperCase(),art=(o.artist||'').toUpperCase(),ph=o.customer_phone||''
    return no.slice(-4)===word||no.indexOf(word)>=0||art.indexOf(word)>=0||ph.indexOf(word)>=0
  })

  const listEl=document.getElementById('admin-list')
  const emptyEl=document.getElementById('admin-empty')
  if(!orders.length){ listEl.innerHTML=''; emptyEl.style.display='block'; return }
  emptyEl.style.display='none'

  listEl.innerHTML=orders.map(o=>`
    <div class="card">
      <div class="row"><div class="row-key">订单号</div><div class="row-val">${o.order_no}</div></div>
      <div class="row"><div class="row-key">艺人</div><div class="row-val">${o.artist}</div></div>
      <div class="row"><div class="row-key">状态</div><div class="row-val"><span class="${tagClass(o.status)}">${statusLabel(o.status)}</span></div></div>
      <div class="row"><div class="row-key">付款</div><div class="row-val">${o.pay_status==='paid'?'已收款':'待付款'}</div></div>
      <div class="row"><div class="row-key">电话</div><div class="row-val">${o.customer_phone}</div></div>
      <div class="addr">收信：${escapeHtml(o.recipient_addr)}</div>
      <div class="addr">回信：${escapeHtml(o.return_addr)}</div>
      ${o.letter_note?`<div class="addr">备注：${escapeHtml(o.letter_note)}</div>`:''}
      <div class="ops">
        ${o.pay_status!=='paid'?`<button class="op" onclick="adminMarkPaid('${o.id}')">标记已付</button>`:''}
        <button class="op" onclick="adminChangeStatus('${o.id}')">改状态</button>
        <button class="op" onclick="adminAttachImage('${o.id}')">存图</button>
        <button class="op" onclick="adminAttachVideo('${o.id}')">存视频</button>
        <button class="op" onclick="adminNote('${o.id}')">写备注</button>
        <button class="op" onclick="goPage('detail','${o.id}')">查看</button>
        <button class="op" onclick="adminDel('${o.id}')">删除</button>
      </div>
    </div>
  `).join('')
}

function adminPaste(){
  const text=prompt('把客户发来的下单信息整段粘进来：')
  if(!text)return
  const parsed=parseOrderText(text)
  if(!parsed.artist && !parsed.order_no){ toast('没解析出内容，请检查格式'); return }
  addOrder({
    id:`${Date.now()}-${Math.floor(Math.random()*1e6)}`,
    order_no:parsed.order_no||makeOrderNo(),
    artist:parsed.artist||'（未填）',
    country:parsed.country||'', recipient_addr:parsed.recipient_addr||'',
    customer_name:parsed.customer_name||'', customer_phone:parsed.customer_phone||'',
    return_addr:parsed.return_addr||'', letter_source:parsed.letter_source||'self',
    letter_note:parsed.letter_note||'', status:'created', pay_status:'unpaid',
    admin_note:'', media:[], created_at:Date.now(),
  })
  initHome()
  toast('已入台账'); renderAdmin()
}
function adminMarkPaid(id){
  const o=getOrder(id)
  const next=o&&o.status==='created'?'paid':(o?o.status:'paid')
  updOrder(id,{pay_status:'paid',status:next})
  toast('已标记收款'); renderAdmin()
}
function adminChangeStatus(id){
  const labels=STATUS_FLOW.map(s=>s.label)
  const idx=prompt('选择新状态（输入数字 0-4）：\n'+labels.map((l,i)=>`${i}.${l}`).join('\n'))
  if(idx===null)return
  const n=parseInt(idx,10)
  if(isNaN(n)||n<0||n>=STATUS_FLOW.length){ toast('无效选择'); return }
  updOrder(id,{status:STATUS_FLOW[n].key})
  toast('已更新'); renderAdmin()
}
function adminNote(id){
  const o=getOrder(id)
  const text=prompt('给客户的留言：',o.admin_note||'')
  if(text===null)return
  updOrder(id,{admin_note:text.trim()})
  toast('已保存')
}
function adminDel(id){
  if(!confirm('从这台手机删除这条订单？不可恢复。'))return
  delOrder(id); initHome(); renderAdmin()
}
function adminExport(){
  const text=allOrders().map(o=>[
    `订单号：${o.order_no}`,`艺人：${o.artist}`,`状态：${statusLabel(o.status)}`,
    `付款：${o.pay_status==='paid'?'已收':'待收'}`,`电话：${o.customer_phone||'-'}`,
    `备注：${o.admin_note||'-'}`,
  ].join('\n')).join('\n\n')
  if(!text){ toast('台账还是空的'); return }
  copyText(text)
}
function adminAttachImage(id){
  createFileInput('image/*',files=>{
    for(const file of files){
      const url=URL.createObjectURL(file)
      const o=getOrder(id)
      const media=Array.isArray(o.media)?o.media:[]
      media.push({kind:'image',path:url,at:Date.now()})
      updOrder(id,{media})
    }
    toast('图片已保存'); renderAdmin()
  })
}
function adminAttachVideo(id){
  createFileInput('video/*',files=>{
    for(const file of files){
      if(file.size>60*1024*1024){ toast('视频超过60MB，请压缩后重试'); continue }
      const url=URL.createObjectURL(file)
      const o=getOrder(id)
      const media=Array.isArray(o.media)?o.media:[]
      media.push({kind:'video',path:url,at:Date.now()})
      updOrder(id,{media})
    }
    toast('视频已保存'); renderAdmin()
  })
}
function createFileInput(accept,cb){
  const input=document.createElement('input')
  input.type='file'; input.accept=accept; input.multiple=true; input.style.display='none'
  input.onchange=e=>{ cb(Array.from(e.target.files)); document.body.removeChild(input) }
  document.body.appendChild(input); input.click()
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
function toast(msg){
  let el=document.getElementById('toast')
  if(!el){ el=document.createElement('div'); el.id='toast'; document.body.appendChild(el) }
  el.innerText=msg; el.style.display='block'
  setTimeout(()=>el.style.display='none',2000)
}
function escapeHtml(str){ return str?str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'' }

// ==================== 启动 ====================
window.addEventListener('DOMContentLoaded',()=>{ initHome(); goPage('home') })
