(()=>{
  if(globalThis.crossOriginIsolated||!('serviceWorker' in navigator))return;
  const key='xrai-coi-reload-v1';
  navigator.serviceWorker.register('./coi-sw.js',{scope:'./'}).then(async()=>{
    await navigator.serviceWorker.ready;
    if(navigator.serviceWorker.controller){sessionStorage.removeItem(key);return}
    if(sessionStorage.getItem(key))return;
    sessionStorage.setItem(key,'1');
    location.reload();
  }).catch(error=>console.warn('XRAI browser sandbox isolation unavailable:',error));
})();
