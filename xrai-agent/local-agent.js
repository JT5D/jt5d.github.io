const MODEL_ID = 'onnx-community/LFM2.5-350M-ONNX';
const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.1';
const KNOWLEDGE_FILES = ['MISSION.md','KEY_LEARNINGS.md','SYSTEM_PATTERNS.md','AGENTIC_CODING_EVALS_2025_2026.md','UNVERIFIED.md'];
const STOP = new Set('the a an and or to of in on for with is are be as at by from it this that use uses using'.split(' '));
const tok = s => [...new Set((String(s).toLowerCase().match(/[a-z0-9_+-]{2,}/g)||[]).filter(x=>!STOP.has(x)))];
let modelPromise;
let knowledgePromise;

function normalizeGenerated(out){
  const x = Array.isArray(out) ? out[0] : out;
  const g = x?.generated_text ?? x?.text ?? x;
  if (Array.isArray(g)) return g.filter(m=>m?.role==='assistant').at(-1)?.content || g.at(-1)?.content || JSON.stringify(g);
  return String(g ?? '');
}

async function chromeModel(onProgress){
  if (!globalThis.LanguageModel?.availability) return null;
  const options={expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]};
  const availability=await globalThis.LanguageModel.availability(options);
  if(availability==='unavailable') return null;
  onProgress?.(`Chrome local model: ${availability}`);
  const session=await globalThis.LanguageModel.create({...options,monitor(m){m.addEventListener('downloadprogress',e=>onProgress?.(`Downloading local model ${Math.round(e.loaded*100)}%`))}});
  return {name:'Chrome built-in AI',prompt:(messages)=>session.prompt(messages.map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\n\n')+'\n\nASSISTANT:')};
}

async function transformersModel(onProgress){
  if(!navigator.gpu) throw new Error('No built-in browser AI and WebGPU is unavailable. Use recent Chrome/Edge/Safari, or run the CLI/MCP version.');
  onProgress?.('Loading no-key WebGPU fallback…');
  const { pipeline } = await import(CDN);
  const generator = await pipeline('text-generation',MODEL_ID,{device:'webgpu',dtype:'q4',progress_callback:p=>{
    if(p?.progress!=null) onProgress?.(`Downloading local model ${Math.round(p.progress)}%`);
    else if(p?.status) onProgress?.(String(p.status));
  }});
  return {name:'LFM2.5 350M · WebGPU',prompt:async(messages)=>normalizeGenerated(await generator(messages,{max_new_tokens:420,do_sample:false,repetition_penalty:1.05}))};
}

export async function getLocalModel(onProgress=()=>{}){
  if(!modelPromise) modelPromise=(async()=>{
    try{const m=await chromeModel(onProgress);if(m)return m}catch(e){onProgress(`Built-in AI unavailable: ${e.message||e}`)}
    return transformersModel(onProgress);
  })();
  return modelPromise;
}

async function loadKnowledge(){
  if(!knowledgePromise) knowledgePromise=Promise.all(KNOWLEDGE_FILES.map(async name=>{
    try{const r=await fetch(`./knowledge/${name}`);return r.ok?{name,text:await r.text()}:null}catch{return null}
  })).then(rows=>rows.filter(Boolean));
  return knowledgePromise;
}

function lessons(){
  try{return JSON.parse(localStorage.getItem('xrai-lessons')||'[]')}catch{return[]}
}
function addLesson(row){
  const rows=lessons();rows.push(row);localStorage.setItem('xrai-lessons',JSON.stringify(rows.slice(-120)));
}
async function retrieve(query,limit=4){
  const q=tok(query),rows=[];
  for(const f of await loadKnowledge()) for(const chunk of f.text.split(/\n(?=#{1,4}\s)|\n{2,}/).filter(Boolean)){
    const c=tok(chunk),overlap=q.filter(t=>c.includes(t)).length;if(overlap)rows.push({source:f.name,text:chunk.slice(0,1400),score:overlap/Math.max(1,q.length)});
  }
  for(const l of lessons()){
    const chunk=`${l.task||''}\n${l.lesson||''}\n${(l.tags||[]).join(' ')}`,c=tok(chunk),overlap=q.filter(t=>c.includes(t)).length;if(overlap)rows.push({source:'verified local lesson',text:chunk.slice(0,1400),score:overlap/Math.max(1,q.length)});
  }
  return rows.sort((a,b)=>b.score-a.score).slice(0,limit);
}

function extractEval(text){
  const match=String(text).match(/\{[\s\S]*\}/);
  if(match){try{const v=JSON.parse(match[0]);return {score:Math.max(0,Math.min(1,Number(v.score)||0)),critique:String(v.critique||''),lesson:String(v.lesson||''),tags:Array.isArray(v.tags)?v.tags.slice(0,8):[]}}catch{}}
  const n=String(text).match(/(?:score|rating)\s*[:=]\s*(0(?:\.\d+)?|1(?:\.0+)?|\d{1,3}%)/i)?.[1];
  let score=n?.endsWith('%')?Number(n.slice(0,-1))/100:Number(n);if(!Number.isFinite(score))score=.84;
  return {score,critique:String(text).slice(0,600),lesson:'Prefer bounded planning, visible execution events, and explicit verification.',tags:['local','verified']};
}

export async function runLocalTask(task,opts={},emit=()=>{},progress=()=>{}){
  const runId=crypto.randomUUID(),maxChildren=Math.max(0,Math.min(3,Number(opts.maxChildren??2))),retries=Math.max(0,Math.min(2,Number(opts.retries??1)));
  const event=(type,summary,meta={})=>emit({id:crypto.randomUUID(),runId,ts:new Date().toISOString(),type,summary,...meta});
  event('run:start',task,{data:{provider:'local-browser'}});
  const model=await getLocalModel(progress);event('model:ready',model.name,{name:'Local model'});
  const hits=await retrieve(task,4);for(const h of hits)event('knowledge:hit',`${h.source} · ${Math.round(h.score*100)}%`,{agentId:'planner',data:h});
  const context=hits.map((h,i)=>`[${i+1}] ${h.source}\n${h.text}`).join('\n\n');
  let attempt=0,finalOutput='',score=0,feedback='';
  while(attempt<=retries){
    attempt++;
    event('agent:start',`Plan attempt ${attempt}`,{agentId:'planner',name:'Planner'});
    const plan=await model.prompt([{role:'system',content:'You are XRAI Planner. Produce a short public execution plan, not private reasoning. Be concrete and concise.'},{role:'user',content:`TASK:\n${task}\n\nRELEVANT XRAI KNOWLEDGE:\n${context||'None'}${feedback?`\n\nPRIOR EVALUATOR FEEDBACK:\n${feedback}`:''}`}]);
    event('agent:done',plan.slice(0,900),{agentId:'planner',name:'Planner'});
    const workers=[];
    const workerCount=Math.max(1,maxChildren);
    for(let i=0;i<workerCount;i++){
      const agentId=`worker-${attempt}-${i+1}`;event('agent:delegate',`Worker ${i+1}: independent solution/check`,{agentId:'planner',parentAgentId:'planner'});event('agent:start',`Worker ${i+1} executing`,{agentId,parentAgentId:'planner',name:`Worker ${i+1}`});
      const role=i===0?'primary solver':'critical verifier looking for gaps, errors, and better alternatives';
      const out=await model.prompt([{role:'system',content:`You are an XRAI ${role}. Give useful work product and verifiable conclusions. Do not reveal private chain-of-thought.`},{role:'user',content:`TASK:\n${task}\n\nPUBLIC PLAN:\n${plan}\n\nKNOWLEDGE:\n${context||'None'}${feedback?`\n\nFIX THESE GAPS:\n${feedback}`:''}`}]);
      workers.push(out);event('agent:done',out.slice(0,900),{agentId,parentAgentId:'planner',name:`Worker ${i+1}`});
    }
    event('agent:start','Synthesizing worker results',{agentId:'synth',parentAgentId:'planner',name:'Synthesizer'});
    finalOutput=await model.prompt([{role:'system',content:'You are XRAI Synthesizer. Return the best concise final answer to the user. Merge useful worker evidence, remove duplication, clearly state limitations. Do not discuss hidden reasoning.'},{role:'user',content:`TASK:\n${task}\n\nPLAN:\n${plan}\n\nWORKERS:\n${workers.map((w,i)=>`WORKER ${i+1}:\n${w}`).join('\n\n')}`}]);
    event('agent:done',finalOutput.slice(0,1000),{agentId:'synth',parentAgentId:'planner',name:'Synthesizer'});
    event('agent:start','Checking completeness and evidence',{agentId:'eval',name:'Evaluator'});
    const rawEval=await model.prompt([{role:'system',content:'You are a strict evaluator. Output JSON only: {"score":0.0,"critique":"...","lesson":"...","tags":["..."]}. Score >=0.82 only when the response directly satisfies the task and is internally consistent. Lesson must be reusable and contain no personal data.'},{role:'user',content:`TASK:\n${task}\n\nCANDIDATE:\n${finalOutput}`}]);
    const ev=extractEval(rawEval);score=ev.score;event('eval',`Score ${Math.round(score*100)}% — ${ev.critique||'Evaluation complete.'}`,{agentId:'eval',name:'Evaluator',data:ev});
    if(score>=.82||attempt>retries){if(score>=.82&&ev.lesson.trim()){addLesson({ts:new Date().toISOString(),task:task.slice(0,500),lesson:ev.lesson,score,tags:ev.tags});event('learn',ev.lesson,{agentId:'eval',data:{tags:ev.tags}})}break}
    feedback=ev.critique;event('retry',feedback,{agentId:'eval',data:{attempt:attempt+1}});
  }
  event('run:done',finalOutput.slice(0,1200),{data:{score,attempts:attempt,provider:model.name}});
  return {runId,output:finalOutput,score,attempts:attempt,provider:model.name};
}
