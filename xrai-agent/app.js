import { clearUiState,isConstrainedDevice,loadUiState,saveUiState,taskNeedsExecutionHost } from './state.js';

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const uid=()=>globalThis.crypto?.randomUUID?.()||`xrai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
let ui=loadUiState(localStorage);
let mode='detecting';
let capabilities=null;
let sse=null;
let pollingRunId=null;

const welcome={id:'welcome',role:'agent',text:'Give me a task. I will check what this runtime can actually access before I act. Repo edits and test execution only run when an execution host is connected; the public browser never pretends it changed files.',ts:Date.now(),runId:null};
if(!ui.messages.length)ui.messages=[welcome];

function persist(){ui=saveUiState(localStorage,ui)}
function escTime(ts){try{return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}catch{return''}}
function makeEvent(type,summary,extra={}){return{id:uid(),runId:ui.activeRunId||uid(),ts:Date.now(),type,summary,...extra}}
function activeEvents(){return ui.events.filter(e=>e.runId===ui.activeRunId)}

function setView(view,persistView=true){
  ui.view=view;
  $('#mainStage').dataset.view=view;
  $$('.side-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  if(persistView)persist();
}

function renderMessages(){
  const box=$('#messages');box.innerHTML='';
  for(const m of ui.messages){
    const el=document.createElement('article');el.className=`msg ${m.role}`;
    const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=m.role==='user'?'Y':m.role==='system'?'':'△';
    const bubble=document.createElement('div');bubble.className='bubble';
    const name=document.createElement('b');name.textContent=m.role==='user'?'You':m.role==='system'?'System':'XRAI Agent';
    const p=document.createElement('p');p.textContent=m.text;
    bubble.append(name,p);el.append(avatar,bubble);box.append(el);
  }
  box.scrollTop=box.scrollHeight;
}
function addMessage(role,text,{runId=ui.activeRunId,persistMessage=true}={}){
  const duplicate=ui.messages.at(-1);
  if(duplicate?.role===role&&duplicate?.text===text&&duplicate?.runId===runId)return;
  ui.messages.push({id:uid(),role,text:String(text),ts:Date.now(),runId});
  ui.messages=ui.messages.slice(-100);
  if(persistMessage)persist();renderMessages();
}

function eventProgress(ev){
  if(ev.type==='run:start')return[5,'Starting'];
  if(ev.type==='model:ready')return[14,'Model ready'];
  if(ev.type.startsWith('knowledge:')||ev.type==='skill:hit')return[22,'Retrieving'];
  if(ev.type==='agent:delegate')return[38,'Delegating'];
  if(ev.type==='agent:start')return[34,'Working'];
  if(ev.type==='tool:start')return[52,ev.name||'Using tool'];
  if(ev.type==='tool:done')return[62,'Tool complete'];
  if(ev.type==='agent:done')return[70,'Synthesizing'];
  if(ev.type==='eval')return[84,'Verifying'];
  if(ev.type==='retry')return[58,'Retrying'];
  if(ev.type.startsWith('skill:')||ev.type==='meta:update')return[93,'Learning'];
  if(ev.type==='capability:blocked')return[100,'Needs execution host'];
  if(ev.type==='run:done')return[100,'Complete'];
  return null;
}
function updateFromEvent(ev){
  const p=eventProgress(ev);if(p){$('#progressBar').style.width=`${p[0]}%`;$('#progressValue').textContent=`${p[0]}%`;$('#progressLabel').textContent=p[1]}
  if(ev.type==='run:start'){$('#currentTask').textContent=ev.summary;$('#runMeta').textContent=`run ${ev.runId.slice(0,8)}`;$('#agentState').textContent='Agent running'}
  if(ev.type==='eval'&&ev.data?.score!=null)$('#score').textContent=`${Math.round(ev.data.score*100)}%`;
  if(ev.type.startsWith('skill:')&&ev.type!=='skill:hit')$('#learning').textContent=ev.type.replace('skill:','');
  if(ev.type==='meta:update')$('#metaVersion').textContent=`v${ev.data?.meta?.version||ev.data?.version||'—'}`;
  if(ev.type==='run:done')$('#agentState').textContent='Agent ready';
}
function acceptEvent(ev,{persistEvent=true}={}){
  if(!ev?.id||!ev?.runId)return;
  if(ui.events.some(x=>x.id===ev.id))return;
  ui.activeRunId=ev.runId;
  ui.events.push(ev);ui.events=ui.events.slice(-500);
  updateFromEvent(ev);
  if(persistEvent)persist();
  renderGraph();renderActivity();renderTimeline();
}
function mergeEvents(rows=[]){for(const ev of rows)acceptEvent(ev,{persistEvent:false});persist()}

function kind(ev){
  if(ev.type==='capability:blocked')return'blocked';
  if(ev.type.startsWith('agent:'))return'agent';
  if(ev.type.startsWith('tool:')||ev.type==='model:ready')return'tool';
  if(ev.type.startsWith('knowledge:')||ev.type==='skill:hit')return'knowledge';
  if(ev.type==='eval'||ev.type==='retry')return'eval';
  if(ev.type.startsWith('skill:')||ev.type==='meta:update')return'learn';
  return'agent';
}
function renderGraph(){
  const rows=activeEvents();const graph=$('#graph');
  if(!rows.length){graph.innerHTML='<div class="empty-state"><span class="empty-mark">△</span><strong>Ready for a task</strong><p>Execution events will build the graph here.</p></div>';return}
  graph.innerHTML='';const nodes=[];const byId=new Map();let rootAgent=null;
  const add=(id,title,parent,k,summary,running=false)=>{
    if(!byId.has(id)){const n={id,title,parent,k,summary,running};byId.set(id,n);nodes.push(n)}
    else{const n=byId.get(id);n.summary=summary||n.summary;n.running=running}
  };
  for(const ev of rows){
    const k=kind(ev);let id=null,title=null,parent=null;
    if(ev.type==='run:start'){id='goal';title='User Goal'}
    else if(ev.type==='model:ready'){id='runtime';title='Runtime';parent='goal'}
    else if(ev.type==='capability:blocked'){id='blocked';title='Execution Host';parent='goal'}
    else if(ev.type==='eval'||ev.type==='retry'){id='eval';title='Evaluator';parent=rootAgent||'goal'}
    else if(ev.type==='skill:hit'||ev.type.startsWith('knowledge:')){id='knowledge';title='Knowledge + Skills';parent=rootAgent||'goal'}
    else if(ev.type.startsWith('skill:')||ev.type==='meta:update'){id='learning';title='Self-improvement';parent='eval'}
    else if(ev.type.startsWith('tool:')){id=`tool:${ev.name||'tool'}`;title=ev.name||'Tool';parent=ev.agentId?`agent:${ev.agentId}`:(rootAgent||'goal')}
    else if(ev.agentId){id=`agent:${ev.agentId}`;title=ev.name||'Agent';parent=ev.parentAgentId?`agent:${ev.parentAgentId}`:'goal';if(!ev.parentAgentId&&!rootAgent)rootAgent=id}
    if(!id)continue;
    add(id,title,parent,k,ev.summary,ev.type.endsWith(':start')||ev.type==='agent:delegate');
    if(ev.type.endsWith(':done')||ev.type==='eval'||ev.type==='capability:blocked')byId.get(id).running=false;
  }
  const depth=id=>{let d=0,n=byId.get(id),guard=0;while(n?.parent&&guard++<10){d++;n=byId.get(n.parent)}return Math.min(d,4)};
  const layers=new Map();for(const n of nodes){const d=depth(n.id);if(!layers.has(d))layers.set(d,[]);layers.get(d).push(n)}
  const width=Math.max(graph.clientWidth,690),colW=Math.max(190,width/5),pos=new Map();
  for(const [d,layer] of layers){layer.forEach((n,i)=>{const total=layer.length,rowGap=96,startY=Math.max(24,240-(total-1)*rowGap/2),x=24+d*colW,y=startY+i*rowGap;pos.set(n.id,{x,y});const el=document.createElement('div');el.className=`node ${n.k}${n.running?' running':''}`;el.style.left=`${x}px`;el.style.top=`${y}px`;const kd=document.createElement('div');kd.className='kind';kd.textContent=n.k;const ti=document.createElement('div');ti.className='title';ti.textContent=n.title;const sm=document.createElement('div');sm.className='summary';sm.textContent=n.summary||'';el.append(kd,ti,sm);graph.append(el)})}
  for(const n of nodes){if(!n.parent||!pos.has(n.parent)||!pos.has(n.id))continue;const a=pos.get(n.parent),b=pos.get(n.id),x1=a.x+176,y1=a.y+29,x2=b.x,y2=b.y+29,dx=x2-x1,dy=y2-y1,len=Math.hypot(dx,dy);const edge=document.createElement('div');edge.className='edge';edge.style.left=`${x1}px`;edge.style.top=`${y1}px`;edge.style.width=`${len}px`;edge.style.transform=`rotate(${Math.atan2(dy,dx)}rad)`;graph.append(edge)}
}
function renderActivity(){
  const rows=activeEvents().slice(-5).reverse();const box=$('#activityList');box.innerHTML='';
  if(!rows.length){box.innerHTML='<p class="muted">No activity yet.</p>';return}
  for(const ev of rows){const row=document.createElement('div');row.className='activity-row';const dot=document.createElement('i');const text=document.createElement('span');text.textContent=ev.summary;const time=document.createElement('time');time.textContent=escTime(ev.ts);row.append(dot,text,time);box.append(row)}
}
function renderTimeline(){
  const box=$('#timeline');const rows=activeEvents().slice().reverse();box.innerHTML='';
  if(!rows.length){box.innerHTML='<div class="empty-state small"><strong>No activity yet.</strong></div>';return}
  for(const ev of rows){const el=document.createElement('div');el.className='event';const meta=document.createElement('div');meta.className='meta';const type=document.createElement('span');type.textContent=`${ev.type}${ev.name?` · ${ev.name}`:''}`;const time=document.createElement('span');time.textContent=escTime(ev.ts);meta.append(type,time);const summary=document.createElement('div');summary.className='summary';summary.textContent=ev.summary;el.append(meta,summary);box.append(el)}
}

function setRunStatus(status,text=status){
  ui.runStatus=status;ui.statusText=text;$('#status').textContent=text;$('#runButton').disabled=status==='running';$('#rerun').disabled=!ui.lastTask||status==='running';
  $('#statusHealth').textContent=status==='running'?'Running':status==='error'?'Needs attention':'Healthy';
  persist();
}
function applyResult(result,runId=ui.activeRunId){
  ui.result={runId,output:result.output||'',score:result.score??null,attempts:result.attempts??0,learning:result.learning??null,provider:result.provider||mode};
  $('#score').textContent=result.score==null?'—':`${Math.round(result.score*100)}%`;$('#attempts').textContent=result.attempts??'—';
  const learningStatus=result.learning?.status||result.learning||'none';$('#learning').textContent=learningStatus;
  $('#progressBar').style.width='100%';$('#progressValue').textContent='100%';$('#progressLabel').textContent='Complete';
  if(result.output)addMessage('agent',result.output,{runId});
  setRunStatus('completed',`done · ${result.provider||mode}`);
}

function connectSse(){
  if(sse||mode!=='server')return;
  sse=new EventSource('./events');
  sse.onmessage=e=>{try{const ev=JSON.parse(e.data);if(!ui.activeRunId||ev.runId===ui.activeRunId)acceptEvent(ev)}catch{}};
}

async function pollServerRun(runId){
  if(!runId||pollingRunId===runId)return;pollingRunId=runId;
  try{
    while(ui.activeRunId===runId&&ui.runStatus==='running'){
      const res=await fetch(`./api/runs/${runId}`,{cache:'no-store'});if(!res.ok)throw new Error('Run state unavailable');const state=await res.json();mergeEvents(state.events||[]);
      if(state.status==='completed'){applyResult(state.result||state,runId);break}
      if(state.status==='error'){setRunStatus('error',state.error||'run failed');addMessage('agent',`Run failed: ${state.error||'Unknown error'}`,{runId});break}
      await sleep(650);
    }
  }catch(error){if(ui.activeRunId===runId&&ui.runStatus==='running'){setRunStatus('interrupted','connection interrupted · run may still be active');showResume('The local execution host became unreachable. Reconnect to recover the run.')}}
  finally{if(pollingRunId===runId)pollingRunId=null}
}

function showResume(text){$('#resumeText').textContent=text;$('#resumeBar').hidden=false}
function hideResume(){$('#resumeBar').hidden=true}
function capabilityMessage(){
  if(mode==='browser')return '<strong>Public browser mode</strong>This page can chat locally, retrieve XRAI knowledge, learn browser skills, and preserve your run state. It cannot read or modify a repository, run shell commands, or execute tests. Repo/code tasks are blocked instead of simulated.';
  if(capabilities?.autonomous)return '';
  return '<strong>Execution host connected, reasoning host missing</strong>Start Ollama for no-key autonomous repo work, or use ChatGPT/Claude as the MCP reasoning host.';
}
function renderCapabilities(){
  const list=$('#capabilityList');list.innerHTML='';
  const c=capabilities?.capabilities||{};
  const items=mode==='browser'?
    [['On-device chat',true,isConstrainedDevice(navigator)?'mobile-safe':'local'],['XRAI knowledge',true,'local'],['Refresh recovery',true,'durable'],['Filesystem + shell',false,'host needed'],['Repo + test execution',false,'host needed']]:
    [['Reasoning host',Boolean(capabilities?.autonomous),capabilities?.provider||'none'],['Filesystem + shell',Boolean(c.shell),'local'],['Repo + test execution',Boolean(c.repoExecution),'local'],['Refresh recovery',Boolean(c.runPersistence),'server'],['MCP endpoint',Boolean(c.mcp),'ready']];
  for(const [label,ok,note] of items){const li=document.createElement('li');const dot=document.createElement('i');dot.className=ok?'yes':'no';const text=document.createElement('span');text.textContent=label;const em=document.createElement('em');em.textContent=note;li.append(dot,text,em);list.append(li)}
}
async function renderSkills(){
  const box=$('#skillsContent');
  if(mode==='server')try{const res=await fetch('./api/skills',{cache:'no-store'});if(res.ok){const s=await res.json();box.innerHTML=`<div class="runtime-grid"><article><strong>${s.promoted||0} promoted</strong><p>Eligible for retrieval after passing evidence gates.</p></article><article><strong>${s.candidates||s.candidate||0} candidates</strong><p>Quarantined until enough independent evidence exists.</p></article></div>`;return}}catch{}
  try{const rows=JSON.parse(localStorage.getItem('xrai-skills-v2')||'[]'),promoted=rows.filter(x=>x.status==='promoted').length,candidates=rows.filter(x=>x.status==='candidate').length;box.innerHTML=`<div class="runtime-grid"><article><strong>${promoted} promoted</strong><p>Stored only on this device in browser mode.</p></article><article><strong>${candidates} candidates</strong><p>Need repeated successful support before promotion.</p></article></div>`}catch{box.innerHTML='<p class="muted">No browser skill data yet.</p>'}
}
function updateCapabilityNotice(){const html=capabilityMessage();const el=$('#capabilityNotice');el.hidden=!html;el.innerHTML=html}

async function startServerRun(task){
  const res=await fetch('./api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task,workspace:ui.options.workspace,retries:ui.options.retries,maxDepth:ui.options.maxDepth,maxChildren:ui.options.maxChildren})});
  const state=await res.json();if(!res.ok)throw new Error(state.error||'Run failed to start');ui.activeRunId=state.runId;mergeEvents(state.events||[]);persist();connectSse();await pollServerRun(state.runId);
}
async function startBrowserRun(task){
  if(taskNeedsExecutionHost(task)){
    ui.activeRunId=uid();persist();
    acceptEvent(makeEvent('run:start',task));
    acceptEvent(makeEvent('capability:blocked','Repo/filesystem/test execution requires a connected execution host.',{name:'Capability check',data:{required:['filesystem','shell','repoExecution']}}));
    const text='This task requires filesystem/repository and test execution. The public GitHub Pages runtime does not have those capabilities, so I stopped rather than pretending to inspect or modify a repo. Open Runtime and use the local execution host (Ollama needs no hosted API key), or connect XRAI through ChatGPT/Claude MCP.';
    addMessage('agent',text);ui.result={runId:ui.activeRunId,output:text,score:null,attempts:0,learning:'none',provider:'browser-capability-check'};
    acceptEvent(makeEvent('run:done','Task stopped safely before fake execution.',{data:{attempts:0,learning:'none'}}));setRunStatus('needs-host','execution host required');return;
  }
  const {runLocalTask}=await import('./local-agent.js');
  const opts={retries:ui.options.retries,maxChildren:ui.options.maxChildren};
  const data=await runLocalTask(task,opts,acceptEvent,msg=>{ui.statusText=msg;$('#status').textContent=msg;persist()});
  ui.activeRunId=data.runId;applyResult(data,data.runId);
}
async function run(task,{resume=false}={}){
  const cleaned=String(task||'').trim();if(!cleaned)return;
  hideResume();ui.lastTask=cleaned;ui.result=null;ui.events=[];ui.activeRunId=null;
  $('#score').textContent='—';$('#attempts').textContent='—';$('#learning').textContent='—';$('#progressBar').style.width='0%';$('#progressValue').textContent='0%';$('#progressLabel').textContent='Starting';$('#currentTask').textContent=cleaned;$('#runMeta').textContent='starting…';
  if(!resume)addMessage('user',cleaned,{runId:null});
  setRunStatus('running','starting');setView(window.innerWidth<760?'chat':'workspace',false);renderGraph();renderActivity();renderTimeline();
  try{if(mode==='server'&&capabilities?.autonomous)await startServerRun(cleaned);else await startBrowserRun(cleaned)}catch(error){const message=error instanceof Error?error.message:String(error);setRunStatus('error',message);addMessage('agent',`Error: ${message}`)}finally{$('#runButton').disabled=ui.runStatus==='running';$('#rerun').disabled=!ui.lastTask||ui.runStatus==='running';persist()}
}

async function recoverRun(){
  renderMessages();renderGraph();renderActivity();renderTimeline();
  $('#status').textContent=ui.statusText||ui.runStatus||'ready';$('#runButton').disabled=ui.runStatus==='running';$('#rerun').disabled=!ui.lastTask||ui.runStatus==='running';
  for(const ev of activeEvents())updateFromEvent(ev);
  if(ui.result){$('#score').textContent=ui.result.score==null?'—':`${Math.round(ui.result.score*100)}%`;$('#attempts').textContent=ui.result.attempts??'—';$('#learning').textContent=ui.result.learning?.status||ui.result.learning||'—'}
  if(ui.lastTask)$('#currentTask').textContent=ui.lastTask;
  if(ui.runStatus!=='running')return;
  if(mode==='server'&&ui.activeRunId){
    try{const res=await fetch(`./api/runs/${ui.activeRunId}`,{cache:'no-store'});if(res.ok){const state=await res.json();mergeEvents(state.events||[]);if(state.status==='completed'){applyResult(state.result||state,ui.activeRunId);return}if(state.status==='running'){setRunStatus('running','reconnected · run still active');showResume('The server run is still active; progress has been restored.');hideResume();pollServerRun(ui.activeRunId);return}}}catch{}
  }
  ui.runStatus='interrupted';persist();setRunStatus('interrupted','interrupted by page reload');showResume('Your task and visible progress were restored. Resume restarts the browser-only run safely.');
}

async function detectRuntime(){
  try{
    const res=await fetch('./api/capabilities',{headers:{accept:'application/json'},cache:'no-store'});if(!res.ok)throw new Error('static');
    capabilities=await res.json();mode='server';connectSse();
    $('#modeLabel').textContent=capabilities.autonomous?`${capabilities.provider}`:'server + browser';
    $('#health').textContent=capabilities.autonomous?'execution host ready':'server connected';
    $('#chatModeHint').textContent=capabilities.autonomous?'Full local execution host: files, shell, repo edits, tests, and durable runs.':'Local server connected; browser AI remains available, MCP is ready.';
  }catch{
    mode='browser';capabilities={autonomous:false,provider:'browser-local',capabilities:{browserLocal:true,runPersistence:true}};
    $('#modeLabel').textContent=isConstrainedDevice(navigator)?'browser · mobile-safe':'browser · no-key';
    $('#health').textContent=isConstrainedDevice(navigator)?'browser · mobile-safe':'browser · no-key';
    $('#chatModeHint').textContent='Public browser: no-key local chat. Repo/file/test tasks require an execution host.';
  }
  updateCapabilityNotice();renderCapabilities();renderSkills();await recoverRun();
}

function resetUi(){
  ui=clearUiState(localStorage);ui.messages=[welcome];if(window.innerWidth<760)ui.view='chat';persist();renderMessages();renderGraph();renderActivity();renderTimeline();$('#currentTask').textContent='No task running.';$('#score').textContent='—';$('#attempts').textContent='—';$('#learning').textContent='—';$('#progressBar').style.width='0%';$('#progressValue').textContent='0%';$('#progressLabel').textContent='Idle';$('#runMeta').textContent='No active run';$('#status').textContent='ready';hideResume();setView(ui.view,false)
}

$$('.side-nav button').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
$$('.back-workspace').forEach(button=>button.addEventListener('click',()=>setView('workspace')));
$$('[data-runtime-target]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.runtimeTarget)));
$('#runtimeButton').addEventListener('click',()=>setView('runtime'));
$('#chatFocusButton').addEventListener('click',()=>setView('chat'));
$('#activityFocusButton').addEventListener('click',()=>setView('activity'));
$('#chatForm').addEventListener('submit',event=>{event.preventDefault();const task=$('#task').value.trim();if(!task)return;$('#task').value='';run(task)});
$('#rerun').addEventListener('click',()=>ui.lastTask&&run(ui.lastTask,{resume:true}));
$('#resumeButton').addEventListener('click',()=>{hideResume();if(mode==='server'&&ui.activeRunId&&ui.runStatus==='running')pollServerRun(ui.activeRunId);else ui.lastTask&&run(ui.lastTask,{resume:true})});
$('#clear').addEventListener('click',resetUi);
window.addEventListener('pagehide',persist);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')persist()});
window.addEventListener('resize',()=>{if(ui.view==='workspace'&&window.innerWidth<760)setView('chat')});

try{const m=JSON.parse(localStorage.getItem('xrai-meta-v2')||'{}');if(m.version)$('#metaVersion').textContent=`v${m.version}`}catch{}
if(window.innerWidth<760&&ui.view==='workspace')ui.view='chat';
setView(ui.view,false);renderMessages();renderGraph();renderActivity();renderTimeline();detectRuntime();
