import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const BASE=process.env.XRAI_URL||'https://jt5d.github.io/xrai-agent/';
const EXPECTED_VERSION=process.env.XRAI_VERSION||'0.3.5';
const outDir=process.env.XRAI_E2E_OUT||'xrai-e2e-artifacts';
await fs.mkdir(outDir,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1512,height:982},serviceWorkers:'allow'});
const page=await context.newPage();
const consoleErrors=[],badRequests=[],githubRequests=[],mirrorRequests=[],searchRequests=[];
const expectedMirrorProbe=url=>/data\.jsdelivr\.com\/v1\/package\/gh\/JT5D\/xrai-agent@(main|develop|dev|trunk|gh-pages)\/flat/i.test(String(url));
page.on('console',m=>{if(m.type()!=='error')return;const loc=m.location()?.url||'';if(expectedMirrorProbe(loc)&&/404|failed to load resource/i.test(m.text()))return;consoleErrors.push(m.text())});
page.on('pageerror',e=>consoleErrors.push(`pageerror: ${e.message}`));
page.on('request',r=>{const u=r.url();if(u.includes('api.github.com/repos/'))githubRequests.push(u);if(u.includes('data.jsdelivr.com/v1/package/gh/'))mirrorRequests.push(u);if(/api\.duckduckgo\.com|wikipedia\.org\/w\/api\.php|hn\.algolia\.com|api\.github\.com\/search\/repositories|search\.jina\.ai/i.test(u))searchRequests.push(u);if(/api\.github\.com\/repos\/(filesystem\/repository|api\.github\.com\/repos)/i.test(u))badRequests.push(u)});
page.on('response',r=>{const u=r.url(),optionalSearch=/search\.jina\.ai/i.test(u),expectedProbe=expectedMirrorProbe(u)&&r.status()===404;if(!optionalSearch&&!expectedProbe&&r.status()>=400&&/jt5d\.github\.io\/xrai-agent|api\.github\.com|raw\.githubusercontent\.com|webcontainer|jsdelivr|wikipedia|algolia|duckduckgo/i.test(u))consoleErrors.push(`HTTP ${r.status()} ${u}`)});
const screenshot=n=>page.screenshot({path:`${outDir}/${n}.png`,fullPage:false});
async function waitForApp(){await page.waitForSelector('#chatForm',{timeout:30000});await page.waitForFunction(v=>document.body.innerText.includes(v),EXPECTED_VERSION,{timeout:30000})}
async function stabilize(){await waitForApp();for(let i=0;i<4;i++){if(await page.evaluate(()=>Boolean(navigator.serviceWorker?.controller&&globalThis.crossOriginIsolated))){await page.waitForFunction(()=>{const mode=document.querySelector('#modeLabel')?.textContent||'';const messages=document.querySelectorAll('.msg').length;return mode!=='detecting'&&messages>0},null,{timeout:30000});await page.waitForTimeout(500);return}await page.waitForTimeout(1000);await page.reload({waitUntil:'domcontentloaded'});await waitForApp()}throw new Error('Pages never became service-worker controlled and cross-origin isolated.')}
async function waitForRunDone(timeout=300000){await page.waitForFunction(()=>{const b=document.querySelector('#runButton'),p=document.querySelector('#progressValue')?.textContent?.trim()||'',s=document.querySelector('#status')?.textContent||'';return b&&!b.disabled&&(p==='100%'||/error|failed|timeout|interrupted/i.test(s))},null,{timeout});await page.waitForTimeout(700)}
async function submit(t){
  const before=await page.locator('#messages').innerText();
  await page.locator('#task').fill(t);
  const state=await page.evaluate(()=>({value:document.querySelector('#task')?.value,disabled:document.querySelector('#runButton')?.disabled,mode:document.querySelector('#modeLabel')?.textContent,isolated:globalThis.crossOriginIsolated,controlled:Boolean(navigator.serviceWorker?.controller)}));
  if(state.value!==t||state.disabled||!state.isolated||!state.controlled)throw new Error(`Composer not ready before submit: ${JSON.stringify(state)}`);
  await page.locator('#chatForm').evaluate(form=>form.requestSubmit());
  await page.waitForFunction(({text,before})=>{const now=document.querySelector('#messages')?.innerText||'';return now!==before&&now.includes(text)}, {text:t,before}, {timeout:15000});
}
try{
  await page.goto(`${BASE}?e2e=${Date.now()}`,{waitUntil:'domcontentloaded',timeout:60000});await stabilize();
  await page.evaluate(()=>{localStorage.removeItem('xrai-ui-v4');localStorage.removeItem('xrai-e2e-force-mirror');localStorage.setItem('xrai-ui-v3',JSON.stringify({version:3,view:'workspace',lastTask:'review repo, fix any failed tests, verify & explain',runStatus:'error',statusText:'GitHub request failed (404) for https://api.github.com/repos/filesystem/repository',messages:[{role:'user',text:'review repo, fix any failed tests, verify & explain'},{role:'agent',text:'This task requires filesystem/repository and test execution. The public GitHub Pages runtime does not have those capabilities, so I stopped rather than pretending to inspect or modify a repo. Open Runtime and use the local execution host.'}],events:[],result:{output:'GitHub request failed (404) for https://api.github.com/repos/api.github.com/repos'},options:{workspace:'.',maxDepth:2,maxChildren:2,retries:1}}))});
  await page.reload({waitUntil:'domcontentloaded'});await stabilize();const stale=await page.locator('body').innerText();if(/public GitHub Pages runtime does not have those capabilities|repos\/filesystem\/repository|repos\/api\.github\.com\/repos/i.test(stale))throw new Error('Stale failure state survived migration.');await screenshot('01-clean-after-migration');

  const capabilityPrompt='what are all agent capabilities? can it search the web? if not add this skill & ensure it is state of art & fast';
  const searchCount=searchRequests.length;await submit(capabilityPrompt);await waitForRunDone(30000);const capabilityBody=await page.locator('#messages').innerText();
  if(!/web search is a real built-in runtime tool/i.test(capabilityBody))throw new Error('Grounded web-search capability answer was not rendered.');
  if(/"score"\s*:|"critique"\s*:|work_product|missing_elements|api_selection_justification|Redis configuration/i.test(capabilityBody))throw new Error('Internal evaluator/planning artifact leaked into user-visible capability answer.');
  if(searchRequests.length<=searchCount)throw new Error('Capability request did not execute a real browser web-search provider.');
  if(!/Web-search smoke check:/i.test(capabilityBody))throw new Error('Capability answer did not include web-search execution evidence.');await screenshot('02-grounded-capabilities');

  await page.evaluate(()=>localStorage.setItem('xrai-e2e-force-mirror','1'));
  await submit('review repo, fix any failed tests, verify & explain');await page.waitForFunction(()=>document.querySelector('#currentTask')?.textContent?.includes('review repo'),null,{timeout:10000});await waitForRunDone();await screenshot('03-repo-run-complete');
  const body=await page.locator('body').innerText();if(badRequests.length)throw new Error(`Bogus GitHub requests: ${badRequests.join(', ')}`);if(!mirrorRequests.some(u=>u.includes('JT5D/xrai-agent')))throw new Error('Forced rate-limit path did not use the jsDelivr public repo mirror.');if(!/verified successfully/i.test(body)||!/PASS npm test/i.test(body)||!/PASS npm run check/i.test(body))throw new Error('Repo execution did not render complete real verification evidence.');
  await page.evaluate(()=>localStorage.removeItem('xrai-e2e-force-mirror'));

  const before=await page.locator('#messages').innerText();await page.reload({waitUntil:'domcontentloaded'});await stabilize();const after=await page.locator('#messages').innerText();if(!after.includes('review repo')||!after.includes('verified successfully')||after.length<Math.min(120,before.length/2))throw new Error('Completed result did not survive reload.');await screenshot('04-after-reload');

  const githubCount=githubRequests.length;await submit('is it fixed?');await page.waitForTimeout(1500);const userTail=(await page.locator('.msg.user .bubble p').allTextContents()).at(-1)||'';if(!userTail.includes('Previous XRAI context')||!userTail.includes('Task: review repo')||!userTail.includes('Result:')||userTail.includes('No completed result was recorded'))throw new Error('Follow-up did not receive prior run context.');if(githubRequests.length!==githubCount)throw new Error('Vague follow-up incorrectly started another repo execution.');if(badRequests.length)throw new Error(`Bogus GitHub requests after follow-up: ${badRequests.join(', ')}`);await screenshot('05-followup-context');

  const errors=consoleErrors.filter(x=>!/favicon\.ico|search\.jina\.ai/i.test(x)&&!(mirrorRequests.some(expectedMirrorProbe)&&/^Failed to load resource: the server responded with a status of 404/i.test(x)));await fs.writeFile(`${outDir}/console-errors.txt`,errors.join('\n'));await fs.writeFile(`${outDir}/github-requests.txt`,githubRequests.join('\n'));await fs.writeFile(`${outDir}/mirror-requests.txt`,mirrorRequests.join('\n'));await fs.writeFile(`${outDir}/search-requests.txt`,searchRequests.join('\n'));if(errors.length)throw new Error(`Relevant browser/network errors:\n${errors.join('\n')}`);console.log('XRAI live E2E PASS');console.log(`Search requests: ${searchRequests.length}; GitHub requests: ${githubRequests.length}; mirror requests: ${mirrorRequests.length}`);
}catch(e){await screenshot('99-failure').catch(()=>{});await fs.writeFile(`${outDir}/failure.txt`,String(e?.stack||e)).catch(()=>{});await fs.writeFile(`${outDir}/console-errors.txt`,consoleErrors.join('\n')).catch(()=>{});await fs.writeFile(`${outDir}/github-requests.txt`,githubRequests.join('\n')).catch(()=>{});await fs.writeFile(`${outDir}/mirror-requests.txt`,mirrorRequests.join('\n')).catch(()=>{});await fs.writeFile(`${outDir}/search-requests.txt`,searchRequests.join('\n')).catch(()=>{});console.error(e);process.exitCode=1}finally{await browser.close()}