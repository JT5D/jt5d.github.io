export const UI_STATE_KEY='xrai-ui-v3';
export const UI_STATE_VERSION=3;

const HOST_PATTERNS=[
  /\b(repo|repository|codebase|github|git)\b/i,
  /\b(file|files|filesystem|terminal|shell|command line|cli)\b/i,
  /\b(fix|edit|modify|patch|commit|push|checkout|refactor)\b[\s\S]{0,40}\b(code|test|tests|build|lint|file|repo|repository)\b/i,
  /\b(npm|pnpm|yarn|bun|pytest|cargo|go test|make|cmake|gradle|mvn)\b/i,
  /\b(run|execute|verify)\b[\s\S]{0,30}\b(test|tests|build|lint|command|script)\b/i
];

export function taskNeedsExecutionHost(task=''){
  return HOST_PATTERNS.some(pattern=>pattern.test(String(task)));
}

export function isConstrainedDevice(nav={}){
  const ua=String(nav.userAgent||'');
  const mobile=/iPhone|iPad|iPod|Android|Mobile/i.test(ua);
  const lowMemory=Number(nav.deviceMemory||0)>0&&Number(nav.deviceMemory)<=4;
  return mobile||lowMemory;
}

export function defaultUiState(){
  return {
    version:UI_STATE_VERSION,
    view:'workspace',
    activeRunId:null,
    lastTask:'',
    runStatus:'idle',
    statusText:'ready',
    messages:[],
    events:[],
    result:null,
    options:{workspace:'.',maxDepth:2,maxChildren:2,retries:1},
    updatedAt:Date.now()
  };
}

export function normalizeUiState(value){
  const base=defaultUiState();
  if(!value||typeof value!=='object'||value.version!==UI_STATE_VERSION)return base;
  return {
    ...base,
    ...value,
    messages:Array.isArray(value.messages)?value.messages.slice(-100):[],
    events:Array.isArray(value.events)?value.events.slice(-500):[],
    options:{...base.options,...(value.options||{})},
    result:value.result&&typeof value.result==='object'?value.result:null
  };
}

export function loadUiState(storage){
  try{return normalizeUiState(JSON.parse(storage?.getItem(UI_STATE_KEY)||'null'))}catch{return defaultUiState()}
}

export function saveUiState(storage,state){
  const next=normalizeUiState({...state,version:UI_STATE_VERSION,updatedAt:Date.now()});
  try{storage?.setItem(UI_STATE_KEY,JSON.stringify(next))}catch{}
  return next;
}

export function clearUiState(storage){
  try{storage?.removeItem(UI_STATE_KEY)}catch{}
  return defaultUiState();
}
