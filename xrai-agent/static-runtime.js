(()=>{
  if(!/\.github\.io$/i.test(location.hostname))return;
  const nativeFetch=globalThis.fetch.bind(globalThis);
  globalThis.fetch=(input,init)=>{
    const url=typeof input==='string'?input:input?.url||'';
    if(/(?:^|\/)api\/capabilities(?:$|[?#])/i.test(url)){
      return Promise.resolve(new Response('{}',{status:404,headers:{'content-type':'application/json'}}));
    }
    return nativeFetch(input,init);
  };
})();
