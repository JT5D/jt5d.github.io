import { browserRepoSupport,runBrowserRepoTask } from './browser-workspace.js';
import { loadUiState,saveUiState,taskNeedsExecutionHost } from './state.js';

const STATIC_HOST=/\.github\.io$/i.test(location.hostname);
const NEW_WELCOME='Give me a task. Public Node/JS/TS repos can be inspected, tested, and repaired directly in a zero-install browser sandbox on compatible desktop browsers. XRAI reports real command evidence and never fabricates repo access.';
let ownsState=false;

function migrateWelcome(){
  const ui=loadUiState(localStorage);
  if(ui.messages?.[0]?.id==='welcome'&&/execution host|public browser never/i.test(ui.messages[0].text||'')){
    ui.messages[0].text=NEW_WELCOME;saveUiState(localStorage,ui);
  }
}
function msg(role,text,runId=null){return{id:crypto.randomUUID(),role,text:String(text),ts:Date.now(),runId}}
function renderMessages(ui){
  const box=document.querySelector('#messages');if(!box)return;box.innerHTML='';
  for(const m of ui.messages){const el=document.createElement('article');el.className=`msg ${m.role}`;const av=document.createElement('div');av.className='avatar';av.textContent=m.role==='user'?'Y':m.role==='system'?'':'△';const bubble=document.createElement('div');bubble.className='bubble';const b=document.createElement('b');b.textContent=m.role==='user'?'You':m.role==='system'?'System':'XRAI Agent';const p=document.createElement('p');p.textContent=m.text;bubble.append(b,p);el.append(av,bubble);box.append(el)}box.scrollTop=box.scrollHeight;
}
function progressFor(type){if(type==='run:start')return[5,'Starting'];if(type==='tool:start')return[42,'Executing'];if(type==='tool:done')return[66,'Verifying'];if(type==='agent:start')return[70,'Repairing'];if(type==='agent:done')return[78,'Repair ready'];if(type==='eval')return[92,'Evidence gate'];if(type==='run:done')return[100,'Complete'];return null}
function paint(ui,event){
  const p=progressFor(event?.type);if(p){document.querySelector('#progressBar')?.style.setProperty('width',`${p[0]}%`);if(document.querySelector('#progressValue'))document.querySelector('#progressValue').textContent=`${p[0]}%`;if(document.querySelector('#progressLabel'))document.querySelector('#progressLabel').textContent=p[1]}
  if(document.querySelector('#currentTask'))document.querySelector('#currentTask').textContent=ui.lastTask||'No task running.';
  if(document.querySelector('#status'))document.querySelector('#status').textContent=ui.statusText||ui.runStatus;
  if(document.querySelector('#agentState'))document.querySelector('#agentState').textContent=ui.runStatus==='running'?'Agent running':'Agent ready';
  const activity=document.querySelector('#activityList');if(activity&&event){const row=document.createElement('div');row.className='activity-row';const dot=document.createElement('i');const span=document.createElement('span');span.textContent=event.summary;const time=document.createElement('time');time.textContent=new Date(event.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});row.append(dot,span,time);activity.prepend(row);while(activity.children.length>5)activity.lastElementChild?.remove()}
}
function patchPublicUi(){
  if(!STATIC_HOST)return;const support=browserRepoSupport(navigator);
  const notice=document.querySelector('#capabilityNotice');if(notice){notice.hidden=false;notice.innerHTML=support.supported?'<strong>Zero-install browser execution</strong>Public Node/JS/TS repos run in an isolated WebContainer with real files, npm commands, tests, bounded edits, and re-verification. No user API key or local install.':`<strong>Browser execution compatibility</strong>${support.reason} Normal no-key chat still works here.`}
  const hint=document.querySelector('#chatModeHint');if(hint)hint.textContent=support.supported?'Public browser: no-key chat + real public Node repo execution in an isolated browser sandbox.':'Public browser: no-key chat. Zero-install public repo execution currently needs desktop Chrome/Edge.';
  const mode=document.querySelector('#modeLabel');if(mode)mode.textContent=support.supported?'browser · repo sandbox':'browser · no-key';
  const health=document.querySelector('#health');if(health)health.textContent=support.supported?'browser sandbox ready':'browser · no-key';
  const list=document.querySelector('#capabilityList');if(list){const items=[['On-device chat',true,'local'],['XRAI knowledge',true,'local'],['Refresh recovery',true,'durable'],['Browser Node sandbox',support.supported,support.supported?'WebContainer':'desktop Chromium'],['Public repo + tests',support.supported,support.supported?'zero-install':'compatibility']];list.innerHTML='';for(const [label,ok,note] of items){const li=document.createElement('li'),i=document.createElement('i'),s=document.createElement('span'),e=document.createElement('em');i.className=ok?'yes':'no';s.textContent=label;e.textContent=note;li.append(i,s,e);list.append(li)}}
}

migrateWelcome();
window.addEventListener('pagehide',event=>{if(ownsState)event.stopImmediatePropagation()},true);
document.addEventListener('visibilitychange',event=>{if(ownsState&&document.visibilityState==='hidden')event.stopImmediatePropagation()},true);

document.addEventListener('submit',async event=>{
  if(!STATIC_HOST||event.target?.id!=='chatForm')return;
  const input=document.querySelector('#task'),task=input?.value.trim()||'';
  if(!task||!taskNeedsExecutionHost(task))return;
  event.preventDefault();event.stopImmediatePropagation();ownsState=true;if(input)input.value='';
  let ui=loadUiState(localStorage);ui.lastTask=task;ui.activeRunId=null;ui.events=[];ui.result=null;ui.runStatus='running';ui.statusText='starting zero-install repo sandbox';ui.messages.push(msg('user',task));ui.messages=ui.messages.slice(-100);ui=saveUiState(localStorage,ui);renderMessages(ui);paint(ui);
  const support=browserRepoSupport(navigator);
  if(!support.supported){const text=`${support.reason} Open this same XRAI URL in current desktop Chrome or Edge for zero-install public-repo execution; no local install or API key is required.`;ui.runStatus='error';ui.statusText='browser compatibility';ui.messages.push(msg('agent',text));ui.result={output:text,score:null,attempts:0,learning:'none',provider:'browser-compatibility'};saveUiState(localStorage,ui);renderMessages(ui);paint(ui);ownsState=false;return}
  try{
    const data=await runBrowserRepoTask(task,{},ev=>{ui.activeRunId=ev.runId;ui.events.push(ev);ui.events=ui.events.slice(-500);ui.statusText=ev.summary;ui=saveUiState(localStorage,ui);paint(ui,ev)},text=>{ui.statusText=text;ui=saveUiState(localStorage,ui);paint(ui)});
    ui.activeRunId=data.runId;ui.runStatus='completed';ui.statusText=`done · ${data.provider}`;ui.result={runId:data.runId,output:data.output,score:data.score,attempts:data.attempts,learning:data.learning,provider:data.provider};ui.messages.push(msg('agent',data.output,data.runId));ui.messages=ui.messages.slice(-100);ui=saveUiState(localStorage,ui);renderMessages(ui);paint(ui,{type:'run:done',summary:data.output,ts:Date.now()});
  }catch(error){const text=`Repo execution error: ${error instanceof Error?error.message:String(error)}`;ui.runStatus='error';ui.statusText='repo execution failed';ui.messages.push(msg('agent',text,ui.activeRunId));ui.result={runId:ui.activeRunId,output:text,score:0,attempts:0,learning:'none',provider:'browser-webcontainer'};ui=saveUiState(localStorage,ui);renderMessages(ui);paint(ui)}
  setTimeout(()=>location.reload(),500);
},true);

if(STATIC_HOST){addEventListener('DOMContentLoaded',()=>{patchPublicUi();setTimeout(patchPublicUi,350);setTimeout(patchPublicUi,1200)});}
