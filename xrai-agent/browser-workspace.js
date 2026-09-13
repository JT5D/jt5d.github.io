const WC_CDN='https://cdn.jsdelivr.net/npm/@webcontainer/api@1.6.4/+esm';
const DEFAULT_REPO='JT5D/xrai-agent';
const MAX_FILES=260,MAX_FILE_BYTES=220_000,MAX_TOTAL_BYTES=2_400_000;
const SKIP_EXT=/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp[34]|mov|avi|wasm|bin|lockb)$/i;
const SKIP_PATH=/(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor|target)(\/|$)/;
let wcPromise=null;
const uid=()=>globalThis.crypto?.randomUUID?.()||`xrai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;

export function parseGitHubRepo(task='',fallback=DEFAULT_REPO){
  const text=String(task);
  const url=text.match(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[\s/#?]|$)/i);
  if(url)return `${url[1]}/${url[2].replace(/\.git$/,'')}`;
  const explicit=text.match(/\b(?:repo(?:sitory)?\s*[:=]?\s*)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/);
  if(explicit&&!['http','https'].includes(explicit[1].toLowerCase()))return `${explicit[1]}/${explicit[2].replace(/[.,;:)]+$/,'')}`;
  return fallback;
}

export function browserRepoSupport(nav=globalThis.navigator||{}){
  const ua=String(nav.userAgent||'');
  const chromium=/Chrome|Chromium|Edg\//i.test(ua)&&!/CriOS/i.test(ua);
  const mobile=/iPhone|iPad|iPod|Android|Mobile/i.test(ua);
  return {supported:chromium&&!mobile,chromium,mobile,reason:mobile?'Repo execution currently needs a desktop browser.':chromium?'':'Repo execution currently uses the Chromium WebContainer runtime.'};
}

async function fetchJson(url){const r=await fetch(url,{headers:{accept:'application/vnd.github+json'}});if(!r.ok)throw new Error(`GitHub request failed (${r.status}) for ${url}`);return r.json()}
export async function inspectPublicRepo(repo,progress=()=>{}){
  progress(`Inspecting public repo ${repo}…`);
  const meta=await fetchJson(`https://api.github.com/repos/${repo}`);
  if(meta.private)throw new Error('This browser path supports public repositories without login. Connect GitHub for private repositories.');
  const branch=meta.default_branch||'main';
  const tree=await fetchJson(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if(tree.truncated)throw new Error('Repository tree is too large for the zero-install browser lane. Use the hosted execution lane for large repos.');
  const files=(tree.tree||[]).filter(x=>x.type==='blob'&&!SKIP_PATH.test(x.path)&&!SKIP_EXT.test(x.path)&&(x.size||0)<=MAX_FILE_BYTES).sort((a,b)=>{
    const rank=p=>/package\.json$|test|spec|src\//i.test(p)?0:1;return rank(a.path)-rank(b.path)||(a.size||0)-(b.size||0)
  });
  let bytes=0;const selected=[];
  for(const f of files){if(selected.length>=MAX_FILES||bytes+(f.size||0)>MAX_TOTAL_BYTES)break;selected.push(f);bytes+=f.size||0}
  progress(`Importing ${selected.length} source files (${Math.round(bytes/1024)} KB)…`);
  const rows=[];let index=0;
  const worker=async()=>{while(index<selected.length){const f=selected[index++],raw=`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${f.path.split('/').map(encodeURIComponent).join('/')}`;const r=await fetch(raw);if(!r.ok)continue;const text=await r.text();if(/\u0000/.test(text))continue;rows.push({path:f.path,text})}};
  await Promise.all(Array.from({length:Math.min(8,selected.length)},worker));
  return{repo,branch,meta:{name:meta.name,fullName:meta.full_name,htmlUrl:meta.html_url},files:rows};
}

function toMountTree(files){const root={};for(const {path,text} of files){const parts=path.split('/');let node=root;for(let i=0;i<parts.length-1;i++)node=node[parts[i]]||(node[parts[i]]={directory:{}}),node=node.directory;node[parts.at(-1)]={file:{contents:text}}}return root}
async function webcontainer(progress=()=>{}){
  if(!wcPromise)wcPromise=(async()=>{progress('Booting zero-install Node sandbox…');const{WebContainer}=await import(WC_CDN);return WebContainer.boot({coep:'credentialless',workdirName:'xrai-workspace'})})();
  return wcPromise;
}
async function runProcess(wc,cmd,args=[],progress=()=>{},cwd){
  progress(`$ ${cmd} ${args.join(' ')}`.trim());const p=await wc.spawn(cmd,args,cwd?{cwd}:undefined);let out='';
  const reader=p.output.getReader();const pump=(async()=>{while(true){const{value,done}=await reader.read();if(done)break;out+=value;progress(String(value).trim().slice(-500));if(out.length>80_000)out=out.slice(-80_000)}})();const code=await p.exit;await pump;return{code,output:out}
}
function scriptsFrom(files){try{return JSON.parse(files.find(f=>f.path==='package.json')?.text||'{}').scripts||{}}catch{return{}}}
function installCommand(files){if(files.some(f=>f.path==='pnpm-lock.yaml'))return['pnpm',['install','--frozen-lockfile']];if(files.some(f=>f.path==='yarn.lock'))return['yarn',['install','--immutable']];if(files.some(f=>f.path==='package-lock.json'))return['npm',['ci','--no-audit','--no-fund']];return['npm',['install','--no-audit','--no-fund']]}
function verificationCommands(files){const s=scriptsFrom(files),cmds=[];if(s.test)cmds.push(['npm',['test']]);if(s.check)cmds.push(['npm',['run','check']]);else{if(s.lint)cmds.push(['npm',['run','lint']]);if(s.build)cmds.push(['npm',['run','build']])}return cmds.length?cmds:[['npm',['test']]]}
function compactFiles(files,limit=38_000){const ranked=files.filter(f=>/\.(m?[jt]sx?|json|md|css|html)$/.test(f.path)&&!/lock\.json$/.test(f.path)).sort((a,b)=>(/test|spec/i.test(a.path)?-1:0)-(/test|spec/i.test(b.path)?-1:0));let out='';for(const f of ranked){const chunk=`\n--- ${f.path} ---\n${f.text.slice(0,8000)}\n`;if(out.length+chunk.length>limit)break;out+=chunk}return out}
function parsePatch(text){const m=String(text).match(/\{[\s\S]*\}/);if(!m)return null;try{const x=JSON.parse(m[0]);if(!Array.isArray(x.edits))x.edits=[];return x}catch{return null}}
async function applyEdits(wc,edits,progress=()=>{}){let applied=0;for(const e of edits.slice(0,8)){if(!e?.path||typeof e.search!=='string'||typeof e.replace!=='string')continue;let cur;try{cur=await wc.fs.readFile(e.path,'utf8')}catch{continue}if(!cur.includes(e.search)){progress(`Skipped ${e.path}: search text not found`);continue}await wc.fs.writeFile(e.path,cur.replace(e.search,e.replace));progress(`Edited ${e.path}`);applied++}return applied}

export async function runBrowserRepoTask(task,opts={},emit=()=>{},progress=()=>{}){
  const support=browserRepoSupport();if(!support.supported)throw new Error(support.reason);
  const repo=parseGitHubRepo(task,opts.defaultRepo||DEFAULT_REPO),runId=uid(),event=(type,summary,meta={})=>emit({id:uid(),runId,ts:new Date().toISOString(),type,summary,...meta});
  event('run:start',task,{data:{provider:'browser-webcontainer',repo}});event('tool:start',`Inspecting ${repo}`,{name:'GitHub public repo'});
  const snapshot=await inspectPublicRepo(repo,progress);event('tool:done',`Imported ${snapshot.files.length} files from ${repo}@${snapshot.branch}`,{name:'GitHub public repo',data:{repo,branch:snapshot.branch,fileCount:snapshot.files.length}});
  if(!snapshot.files.some(f=>f.path==='package.json'))throw new Error('The zero-install browser execution lane currently supports Node/JS/TS repositories with a package.json.');
  const wc=await webcontainer(progress);await wc.mount(toMountTree(snapshot.files));event('tool:start','Installing repository dependencies',{name:'Dependency install'});
  const [im,ia]=installCommand(snapshot.files),installed=await runProcess(wc,im,ia,progress);event('tool:done',`Dependency install exit ${installed.code}`,{name:'Dependency install',data:{exitCode:installed.code}});if(installed.code!==0)throw new Error(`Dependency installation failed.\n${installed.output.slice(-3000)}`);
  const commands=verificationCommands(snapshot.files);let evidence=[];for(const [cmd,args] of commands){event('tool:start',`$ ${cmd} ${args.join(' ')}`,{name:'Test verifier'});const r=await runProcess(wc,cmd,args,progress);evidence.push({cmd:[cmd,...args].join(' '),...r});event('tool:done',`${r.code===0?'PASS':'FAIL'} · ${cmd} ${args.join(' ')}`,{name:'Test verifier',data:{exitCode:r.code}})}
  let failing=evidence.filter(x=>x.code!==0),edits=0,modelName='deterministic verifier';
  if(failing.length){
    const{getLocalModel}=await import('./local-agent.js');const model=await getLocalModel(progress);modelName=model.name;event('agent:start','Diagnosing failing tests from real repository evidence',{agentId:'repo-fixer',name:'Repo fixer'});
    for(let round=1;round<=2&&failing.length;round++){
      const prompt=`TASK:\n${task}\n\nREPO: ${repo}@${snapshot.branch}\n\nREAL FAILING COMMAND OUTPUT:\n${failing.map(x=>`$ ${x.cmd}\n${x.output.slice(-9000)}`).join('\n\n')}\n\nRELEVANT FILES:\n${compactFiles(snapshot.files)}\n\nReturn JSON only: {"summary":"short public diagnosis","edits":[{"path":"relative/path","search":"exact existing text","replace":"replacement text"}]}. Make the smallest correct edits. Do not invent files or test results.`;
      const answer=await model.prompt([{role:'system',content:'You are XRAI Repo Fixer. Use only the supplied real repo files and test output. Return JSON only. No hidden chain-of-thought.'},{role:'user',content:prompt}]),patch=parsePatch(answer);if(!patch)break;event('agent:done',patch.summary||`Patch round ${round}`,{agentId:'repo-fixer',name:'Repo fixer'});const n=await applyEdits(wc,patch.edits,progress);edits+=n;if(!n)break;evidence=[];for(const [cmd,args] of commands){event('tool:start',`Re-verify: $ ${cmd} ${args.join(' ')}`,{name:'Test verifier'});const r=await runProcess(wc,cmd,args,progress);evidence.push({cmd:[cmd,...args].join(' '),...r});event('tool:done',`${r.code===0?'PASS':'FAIL'} · ${cmd} ${args.join(' ')}`,{name:'Test verifier',data:{exitCode:r.code}})}failing=evidence.filter(x=>x.code!==0)
    }
  }
  const passed=failing.length===0,summary=`${repo}@${snapshot.branch}: ${passed?'verified successfully':'verification still failing'}. ${evidence.map(x=>`${x.code===0?'PASS':'FAIL'} ${x.cmd}`).join(' · ')}${edits?` · ${edits} file edit${edits===1?'':'s'} applied in the browser sandbox.`:' · No code edits were necessary.'}`;
  event('eval',`${passed?'Verified':'Not verified'} from real command exit codes`,{name:'Evidence gate',data:{score:passed?1:0,commands:evidence.map(x=>({cmd:x.cmd,exitCode:x.code}))}});event('run:done',summary,{data:{score:passed?1:0,attempts:edits?2:1,provider:`WebContainer + ${modelName}`,learning:'evidence'}});
  return{runId,output:summary,score:passed?1:0,attempts:edits?2:1,provider:`WebContainer + ${modelName}`,learning:{status:passed?'verified':'rejected'},evidence,repo,branch:snapshot.branch,edits};
}
