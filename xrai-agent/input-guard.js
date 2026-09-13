const LEGACY_UI_KEY='xrai-ui-v3';
const CURRENT_UI_KEY='xrai-ui-v4';
const DEFAULT_REPO='JT5D/xrai-agent';

const API_REPO_URL=/https?:\/\/api\.github\.com\/repos\/[^\s)\]}>'"]+/gi;
const BAD_PAIR=/\b(filesystem|file|files|repo|repository|repos|codebase|src|test|tests|build|api\.github\.com|github\.com|https?|localhost)\/(filesystem|file|files|repo|repository|repos|codebase|src|test|tests|build|api\.github\.com|github\.com|https?|localhost)\b/gi;
const VAGUE_FOLLOWUP=/^(?:is|was|did|does|has|have|can|could|will|would)\s+(?:it|that|this)\b[^\n]{0,80}[?.!]?$/i;

export function sanitizeTask(task=''){
  let text=String(task);
  text=text.replace(API_REPO_URL,'[GitHub API error URL]');
  text=text.replace(BAD_PAIR,(m,a,b)=>`${a} ${b}`);
  return text;
}

export function stateLooksStale(value){
  if(!value||typeof value!=='object')return false;
  const hay=[...(Array.isArray(value.messages)?value.messages.map(m=>m?.text):[]),value?.result?.output,value?.statusText].filter(Boolean).join('\n');
  return /public github pages runtime does not have those capabilities|open runtime and use the local execution host|api\.github\.com\/repos\/(?:filesystem|api\.github\.com)|filesystem\/repository/i.test(hay);
}

export function migrateLegacyUiState(storage=globalThis.localStorage){
  try{
    if(storage?.getItem(CURRENT_UI_KEY))return false;
    const raw=storage?.getItem(LEGACY_UI_KEY);if(!raw)return false;
    const parsed=JSON.parse(raw);
    if(stateLooksStale(parsed)){storage.removeItem(LEGACY_UI_KEY);return true}
  }catch{}
  return false;
}

export function contextualizeFollowup(task,storage=globalThis.localStorage){
  const clean=sanitizeTask(task);
  if(!VAGUE_FOLLOWUP.test(clean.trim()))return clean;
  try{
    const state=JSON.parse(storage?.getItem(CURRENT_UI_KEY)||'null');
    const priorTask=String(state?.lastTask||'').trim();
    const priorResult=String(state?.result?.output||'').trim();
    if(!priorTask&&!priorResult)return clean;
    return `${clean}\n\nPrevious XRAI context (use this evidence; do not ask what \"it\" refers to):\nTask: ${priorTask||DEFAULT_REPO}\nResult: ${(priorResult||'No completed result was recorded.').slice(0,1600)}`;
  }catch{return clean}
}

if(typeof window!=='undefined'&&typeof document!=='undefined'){
  migrateLegacyUiState(window.localStorage);
  document.addEventListener('submit',event=>{
    const form=event.target;if(!(form instanceof HTMLFormElement)||form.id!=='chatForm')return;
    const input=form.querySelector('#task');if(!(input instanceof HTMLTextAreaElement))return;
    input.value=contextualizeFollowup(input.value,window.localStorage);
  },true);
}
