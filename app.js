const BASE=new Set(['fuck','shit','ass','bitch','bastard','cunt','dick','cock','pussy','whore','slut','asshole','motherfucker','fucker','bullshit','douche','cocksucker','prick','wanker','twat','cum','jizz']);
const TOKRE=/\b([A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*)\b/g;
const norm=s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const mask=t=>t.replace(TOKRE,w=>BASE.has(norm(w))?'*'.repeat(w.length):w);

const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const messagesEl=$('#messages'),typingEl=$('#typing'),chanlistEl=$('#chanlist'),roomEl=$('#room'),inputEl=$('#input'),sendBtn=$('#send'),nameEl=$('#username'),addEl=$('#newchan'),addBtn=$('#addbtn');

let current='general',userId=null,username=localStorage.getItem('da_username')||'';nameEl.value=username;
const wsProto=(location.protocol==='https:')?'wss':'ws';
const ws=new WebSocket(wsProto+'://'+location.host);

const channels=new Set();const typingUsers=new Map();

// SAFE: no innerHTML for untrusted data
function addChannel(name){
  if(channels.has(name)) return;
  channels.add(name);
  const item=document.createElement('div');
  item.className='channel';
  item.dataset.name=name;
  const s1=document.createElement('span'); s1.textContent='#';
  const s2=document.createElement('span'); s2.textContent=name;
  item.appendChild(s1); item.appendChild(s2);
  item.addEventListener('click',()=>join(name));
  chanlistEl.appendChild(item);
}

function join(channel){ ws.send(JSON.stringify({type:'join',channel})); setActive(channel); }
function setActive(channel){
  current=channel;
  roomEl.textContent='#'+channel;
  inputEl.placeholder='Message #'+channel;
  for(const el of $$('.channel')) el.classList.toggle('active',el.dataset.name===channel);
  messagesEl.innerHTML='';
  typingEl.textContent='';
}
function avatar(n){return(n?n.slice(0,2):'??').toUpperCase()}
function pushMessage(msg){
  if(msg.channel!==current) return;
  if(msg.type==='system'){
    const d=document.createElement('div'); d.className='system'; d.textContent=msg.text;
    messagesEl.appendChild(d); messagesEl.scrollTop=messagesEl.scrollHeight; return;
  }
  const maskedUser=mask(msg.from.username),maskedText=mask(msg.text);
  const row=document.createElement('div'); row.className='msg';
  const av=document.createElement('div'); av.className='avatar'; av.textContent=avatar(maskedUser);
  const bubble=document.createElement('div'); bubble.className='bubble';
  const meta=document.createElement('div'); meta.className='meta';
  const time=new Date(msg.ts).toLocaleTimeString(); meta.textContent=maskedUser+'  •  '+time;
  const body=document.createElement('div'); body.textContent=maskedText; // textContent prevents XSS
  bubble.appendChild(meta); bubble.appendChild(body);
  row.appendChild(av); row.appendChild(bubble);
  messagesEl.appendChild(row); messagesEl.scrollTop=messagesEl.scrollHeight;
}
function renderTyping(channel){
  const map=typingUsers.get(channel)||new Map();
  const names=Array.from(map.values()).filter(n=>n!==username);
  typingEl.textContent=names.length?(names.join(', ')+(names.length>1?' are':' is')+' typing…'):'';
}
let typingTimer=null,typingState=false;
function notifyTyping(is){ if(typingState===is) return; typingState=is; ws.send(JSON.stringify({type:'typing',channel:current,isTyping:!!is})); }

inputEl.addEventListener('input',()=>{ if(!username) return; notifyTyping(true); clearTimeout(typingTimer); typingTimer=setTimeout(()=>notifyTyping(false),1200); });
sendBtn.addEventListener('click',send);
inputEl.addEventListener('keydown',e=>{ if(e.key==='Enter') send() });

function send(){
  const text=inputEl.value.trim();
  if(!text) return;
  ws.send(JSON.stringify({type:'chat',channel:current,text}));
  inputEl.value=''; notifyTyping(false);
}
nameEl.addEventListener('change',()=>{
  username=nameEl.value.trim();
  localStorage.setItem('da_username',username);
  ws.send(JSON.stringify({type:'hello',username}));
});
addBtn.addEventListener('click',()=>{
  const name=(addEl.value||'').trim().toLowerCase().replace(/[^a-z0-9-_]/g,'-').slice(0,32);
  if(!name) return;
  addEl.value='';
  addChannel(name); join(name);
});
ws.addEventListener('open',()=>{ if(username) ws.send(JSON.stringify({type:'hello',username})) });
ws.addEventListener('message',ev=>{
  let d; try{ d=JSON.parse(ev.data) }catch{ return }
  if(d.type==='welcome'){ userId=d.id; (d.channels||[]).forEach(addChannel); join('general'); }
  else if(d.type==='history'){ if(d.channel===current){ messagesEl.innerHTML=''; (d.messages||[]).forEach(pushMessage); messagesEl.scrollTop=messagesEl.scrollHeight; } }
  else if(d.type==='chat'||d.type==='system'){ pushMessage(d); }
  else if(d.type==='channels'){ (d.channels||[]).forEach(addChannel); }
  else if(d.type==='typing'){
    let map=typingUsers.get(d.channel); if(!map){ map=new Map(); typingUsers.set(d.channel,map); }
    if(d.isTyping) map.set(d.userId,d.username); else map.delete(d.userId);
    renderTyping(d.channel);
  }
});
ws.addEventListener('close',()=>{
  const d=document.createElement('div'); d.className='system'; d.textContent='Disconnected. Reload to reconnect.'; messagesEl.appendChild(d);
});