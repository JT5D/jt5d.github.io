const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let lastTask = ''; let events = []; let activeRun = null; let mode='detecting'; let sse;

function show(view){
  $$('.view').forEach(v=>v.classList.toggle('active',v.id===view+'View'));
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===view));
}
$$('.tab').forEach(t=>t.onclick=()=>show(t.dataset.view));
$('#openControl').onclick=()=>show('control'); $('#backChat').onclick=()=>show('chat');

function addMessage(role,text){
  const el=document.createElement('article'); el.className='msg '+role;
  el.innerHTML=`<div class="avatar">${role==='user'?'Y':'△'}</div><div><b>${role==='user'?'You':'XRAI Agent'}</b><p></p></div>`;
  el.querySelector('p').textContent=text; $('#messages').append(el); $('#messages').scrollTop=$('#messages').scrollHeight;
}
function acceptEvent(ev){events.push(ev);activeRun=ev.runId;renderEvent(ev);renderGraph()}
function connectSse(){if(sse)return;sse=new EventSource('./events');sse.onmessage=e=>{const ev=JSON.parse(e.data);if(!activeRun||ev.runId===activeRun)acceptEvent(ev)}}

function renderEvent(ev){
  const empty=$('#timeline .empty'); if(empty) empty.remove();
  const el=document.createElement('div'); el.className='event';
  const time=new Date(ev.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  el.innerHTML=`<div class="meta"><span>${ev.type}${ev.name?' · '+ev.name:''}</span><span>${time}</span></div><div class="summary"></div>`;
  el.querySelector('.summary').textContent=ev.summary.slice(0,900); $('#timeline').prepend(el);
  $('#eventCount').textContent=events.filter(x=>x.runId===activeRun).length;
  if(ev.type==='run:start'){$('#runId').textContent=ev.runId.slice(0,8);$('#health').textContent='● running';$('#health').style.color='var(--cyan)'}
  if(ev.type==='eval'&&ev.data?.score!=null) $('#score').textContent=Math.round(ev.data.score*100)+'%';
  if(ev.type==='run:done'){$('#health').textContent=`● ${mode==='server'?'server':'local'} ready`;$('#health').style.color='var(--green)';$('#attempts').textContent=ev.data?.attempts??'—'}
}
function kind(ev){if(ev.type.startsWith('agent:'))return'agent';if(ev.type.startsWith('tool:')||ev.type==='model:ready')return'tool';if(ev.type.startsWith('knowledge:'))return'knowledge';if(ev.type==='eval'||ev.type==='retry')return'eval';if(ev.type==='learn')return'learn';return'agent'}
function renderGraph(){
  const runEvents=events.filter(e=>e.runId===activeRun); if(!runEvents.length)return;
  const graph=$('#graph'); graph.innerHTML=''; const entities=[]; const byId=new Map();
  for(const ev of runEvents){
    let id=null,title=null,parent=null,k=kind(ev),summary=ev.summary;
    if(ev.type==='run:start'){id='goal';title='User goal';k='agent'}
    else if(ev.agentId){id='a:'+ev.agentId;title=ev.name||ev.type;parent=ev.parentAgentId?'a:'+ev.parentAgentId:'goal'}
    else if(ev.type==='eval'){id='eval';title='Evaluator';parent='goal';k='eval'}
    else if(ev.type==='learn'){id='learn';title='Verified lesson';parent='eval';k='learn'}
    if(!id)continue;
    if(!byId.has(id)){const n={id,title,parent,k,summary,running:ev.type.endsWith(':start')};byId.set(id,n);entities.push(n)}else{const n=byId.get(id);n.summary=summary;if(ev.type.endsWith(':done')||ev.type==='eval')n.running=false}
  }
  const depth=id=>{let d=0,n=byId.get(id),guard=0;while(n?.parent&&guard++<8){d++;n=byId.get(n.parent)}return d};
  const layers=new Map();for(const n of entities){const d=n.id==='learn'?3:Math.min(3,depth(n.id));if(!layers.has(d))layers.set(d,[]);layers.get(d).push(n)}
  const W=Math.max(760,graph.clientWidth),colW=W/4,pos=new Map();
  for(const [d,nodes] of layers){nodes.forEach((n,i)=>{const x=20+d*colW,y=28+i*92+(d%2?32:0);pos.set(n.id,{x,y});const el=document.createElement('div');el.className=`node ${n.k}${n.running?' running':''}`;el.style.left=x+'px';el.style.top=y+'px';el.innerHTML=`<div class="kind">${n.k}</div><div class="title"></div><div class="summary"></div>`;el.querySelector('.title').textContent=n.title;el.querySelector('.summary').textContent=n.summary;graph.append(el)})}
  for(const n of entities){if(!n.parent||!pos.has(n.id)||!pos.has(n.parent))continue;const a=pos.get(n.parent),b=pos.get(n.id),x1=a.x+168,y1=a.y+32,x2=b.x,y2=b.y+32,dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy);const e=document.createElement('div');e.className='edge';e.style.left=x1+'px';e.style.top=y1+'px';e.style.width=len+'px';e.style.transform=`rotate(${Math.atan2(dy,dx)}rad)`;graph.append(e)}
}

async function run(task){
  lastTask=task;$('#rerun').disabled=false;activeRun=null;events=[];$('#timeline').innerHTML='<div class="empty">Starting…</div>';$('#graph').innerHTML='<div class="empty">Starting agent…</div>';$('#latestOutput').textContent='Running…';$('#score').textContent='—';$('#attempts').textContent='—';$('#eventCount').textContent='0';$('#status').textContent='running';$('#runButton').disabled=true;show('control');
  try{
    let data;
    if(mode==='server'){
      const res=await fetch('./api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task,workspace:$('#workspace').value,retries:Number($('#retries').value),maxDepth:Number($('#maxDepth').value),maxChildren:Number($('#maxChildren').value)})});
      data=await res.json();if(!res.ok)throw new Error(data.error||'Run failed');activeRun=data.runId;
    }else{
      $('#status').textContent='loading local AI';
      const {runLocalTask}=await import('./local-agent.js');
      data=await runLocalTask(task,{retries:Number($('#retries').value),maxChildren:Number($('#maxChildren').value)},acceptEvent,msg=>{$('#status').textContent=msg});activeRun=data.runId;
    }
    $('#latestOutput').textContent=data.output;$('#score').textContent=Math.round(data.score*100)+'%';$('#attempts').textContent=data.attempts;addMessage('agent',data.output);$('#status').textContent=`done · ${data.provider||mode}`;
  }catch(e){$('#latestOutput').textContent=String(e.message||e);addMessage('agent','Error: '+String(e.message||e));$('#status').textContent='error'}finally{$('#runButton').disabled=false}
}
$('#chatForm').onsubmit=e=>{e.preventDefault();const task=$('#task').value.trim();if(!task)return;addMessage('user',task);$('#task').value='';run(task)};
$('#rerun').onclick=()=>lastTask&&run(lastTask);$('#clear').onclick=()=>{events=[];activeRun=null;$('#timeline').innerHTML='<div class="empty">No activity yet.</div>';$('#graph').innerHTML='<div class="empty">Run a task to see the execution DAG.</div>';$('#latestOutput').textContent='No result yet.'};

(async()=>{
  try{const r=await fetch('./api/capabilities',{headers:{accept:'application/json'}});if(!r.ok)throw new Error('static');const c=await r.json();if(c.autonomous){mode='server';connectSse();$('#health').textContent='● server ready';$('#status').textContent=`server · ${c.model}`}else{mode='local';$('#health').textContent='● no-key local';$('#health').style.color='var(--green)';$('#status').textContent='no-key local AI · server tools remain available through MCP';$('#workspace').disabled=true;$('#workspace').value='browser sandbox'}}
  catch{mode='local';$('#health').textContent='● no-key local';$('#health').style.color='var(--green)';$('#status').textContent='no-key local AI · model loads on first message';$('#workspace').disabled=true;$('#workspace').value='browser sandbox';}
})();
