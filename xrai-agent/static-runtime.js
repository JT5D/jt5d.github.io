(()=>{
  if(!/\.github\.io$/i.test(location.hostname))return;
  const nativeFetch=globalThis.fetch.bind(globalThis),jsonHeaders={'content-type':'application/json'};
  const flatCache=new Map(),branchCache=new Map();
  const response=value=>new Response(JSON.stringify(value),{status:200,headers:jsonHeaders});
  const splitRepo=s=>{const p=String(s).split('/');return p.length===2&&p.every(Boolean)?p:null};
  const forceMirror=()=>{try{return localStorage.getItem('xrai-e2e-force-mirror')==='1'}catch{return false}};
  async function flat(repo,ref){
    const key=`${repo}@${ref}`;if(flatCache.has(key))return flatCache.get(key);
    const url=`https://data.jsdelivr.com/v1/package/gh/${repo}@${encodeURIComponent(ref)}/flat`,r=await nativeFetch(url,{headers:{accept:'application/json'}});
    if(!r.ok)throw new Error(`Public repo mirror failed (${r.status}) for ${repo}@${ref}`);
    const data=await r.json();flatCache.set(key,data);return data;
  }
  async function resolveBranch(repo){
    if(branchCache.has(repo))return branchCache.get(repo);
    for(const ref of ['main','master','develop','dev','trunk','gh-pages']){
      try{await flat(repo,ref);branchCache.set(repo,ref);return ref}catch{}
    }
    throw new Error(`Could not resolve a public branch for ${repo} after GitHub rate limiting.`);
  }
  async function fallbackGitHub(url){
    const u=new URL(url),parts=u.pathname.split('/').filter(Boolean);
    if(parts[0]!=='repos'||parts.length<3)return null;
    const repoParts=splitRepo(`${parts[1]}/${parts[2]}`);if(!repoParts)return null;
    const repo=repoParts.join('/');
    if(parts.length===3){
      const branch=await resolveBranch(repo),name=repoParts[1];
      return response({private:false,default_branch:branch,name,full_name:repo,html_url:`https://github.com/${repo}`,xrai_mirror:'jsdelivr'});
    }
    if(parts[3]==='commits'&&parts[4]){
      const ref=decodeURIComponent(parts[4]);await flat(repo,ref);return response({sha:ref,xrai_mirror:'jsdelivr'});
    }
    if(parts[3]==='git'&&parts[4]==='trees'&&parts[5]){
      const ref=decodeURIComponent(parts[5]),data=await flat(repo,ref),tree=(data.files||[]).filter(f=>f?.name&&f.type!=='directory').map(f=>({path:String(f.name).replace(/^\//,''),type:'blob',size:Number(f.size||0),sha:String(f.hash||'')}));
      return response({sha:ref,truncated:false,tree,xrai_mirror:'jsdelivr'});
    }
    return null;
  }
  globalThis.fetch=async(input,init)=>{
    const url=typeof input==='string'?input:input?.url||'';
    if(/(?:^|\/)api\/capabilities(?:$|[?#])/i.test(url))return new Response('{}',{status:404,headers:jsonHeaders});
    const githubRepo=/^https:\/\/api\.github\.com\/repos\//i.test(url);
    if(githubRepo&&forceMirror()){
      try{return await fallbackGitHub(url)||new Response('{"message":"forced mirror unsupported"}',{status:429,headers:jsonHeaders})}catch(error){console.warn('XRAI forced public repo mirror unavailable:',error);return new Response('{"message":"forced mirror unavailable"}',{status:429,headers:jsonHeaders})}
    }
    const r=await nativeFetch(input,init);
    if(!githubRepo||![403,429].includes(r.status))return r;
    try{return await fallbackGitHub(url)||r}catch(error){console.warn('XRAI public repo mirror fallback unavailable:',error);return r}
  };
})();