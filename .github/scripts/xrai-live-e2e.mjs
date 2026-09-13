import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const BASE = process.env.XRAI_URL || 'https://jt5d.github.io/xrai-agent/';
const EXPECTED_VERSION = process.env.XRAI_VERSION || '0.3.2';
const outDir = process.env.XRAI_E2E_OUT || 'xrai-e2e-artifacts';
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1512, height: 982 },
  serviceWorkers: 'allow',
});
const page = await context.newPage();
const consoleErrors = [];
const badRequests = [];
const githubRequests = [];

page.on('console', msg => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));
page.on('request', req => {
  const url = req.url();
  if (url.includes('api.github.com/repos/')) githubRequests.push(url);
  if (/api\.github\.com\/repos\/(filesystem\/repository|api\.github\.com\/repos)/i.test(url)) badRequests.push(url);
});
page.on('response', res => {
  const url = res.url();
  if (res.status() >= 400 && /jt5d\.github\.io\/xrai-agent|api\.github\.com|raw\.githubusercontent\.com|webcontainer|jsdelivr/i.test(url)) {
    consoleErrors.push(`HTTP ${res.status()} ${url}`);
  }
});

async function screenshot(name) {
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false });
}
async function waitForApp() {
  await page.waitForSelector('#chatForm', { timeout: 30_000 });
  await page.waitForFunction(v => document.body.innerText.includes(`Version\n${v}`) || document.body.innerText.includes(v), EXPECTED_VERSION, { timeout: 30_000 });
}
async function waitForRunDone(timeout = 300_000) {
  await page.waitForFunction(() => {
    const status = document.querySelector('#status')?.textContent || '';
    const health = document.querySelector('#statusHealth')?.textContent || '';
    return /done|completed|pass|error|fail|timeout|verified/i.test(status) || /healthy|needs attention/i.test(health) && !/running/i.test(status);
  }, null, { timeout });
  await page.waitForTimeout(1000);
}
async function submit(text) {
  await page.locator('#task').fill(text);
  await page.locator('#runButton').click();
}

try {
  // First load lets the COI service worker install/control the Pages scope.
  await page.goto(`${BASE}?e2e=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForApp();
  await page.waitForTimeout(1500);
  if (!await page.evaluate(() => navigator.serviceWorker?.controller != null)) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp();
  }

  // Reproduce the user's stale-state scenario exactly. v0.3.2 must migrate it away.
  await page.evaluate(() => {
    localStorage.removeItem('xrai-ui-v4');
    localStorage.setItem('xrai-ui-v3', JSON.stringify({
      version: 3,
      view: 'workspace',
      lastTask: 'review repo, fix any failed tests, verify & explain',
      runStatus: 'error',
      statusText: 'GitHub request failed (404) for https://api.github.com/repos/filesystem/repository',
      messages: [
        { role: 'user', text: 'review repo, fix any failed tests, verify & explain' },
        { role: 'agent', text: 'This task requires filesystem/repository and test execution. The public GitHub Pages runtime does not have those capabilities, so I stopped rather than pretending to inspect or modify a repo. Open Runtime and use the local execution host.' }
      ],
      events: [],
      result: { output: 'GitHub request failed (404) for https://api.github.com/repos/api.github.com/repos' },
      options: { workspace: '.', maxDepth: 2, maxChildren: 2, retries: 1 }
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp();
  await page.waitForTimeout(1200);
  const staleText = await page.locator('body').innerText();
  if (/public GitHub Pages runtime does not have those capabilities|repos\/filesystem\/repository|repos\/api\.github\.com\/repos/i.test(staleText)) {
    throw new Error('Stale v0.2/v0.3 failure state survived migration.');
  }
  await screenshot('01-clean-after-migration');

  // Exact primary flow from the user's report.
  await submit('review repo, fix any failed tests, verify & explain');
  await page.waitForFunction(() => document.querySelector('#currentTask')?.textContent?.includes('review repo'), null, { timeout: 10_000 });
  await page.waitForFunction(() => document.body.innerText.includes('JT5D/xrai-agent') || document.body.innerText.includes('Inspecting public repo'), null, { timeout: 30_000 });
  await waitForRunDone();
  await screenshot('02-repo-run-complete');

  const bodyAfterRun = await page.locator('body').innerText();
  if (badRequests.length) throw new Error(`Bogus GitHub repo requests observed: ${badRequests.join(', ')}`);
  if (!githubRequests.some(u => /api\.github\.com\/repos\/JT5D\/xrai-agent(?:$|\/)/i.test(u))) {
    throw new Error(`Did not observe a real JT5D/xrai-agent GitHub API request. Seen: ${githubRequests.slice(0,10).join(', ')}`);
  }
  if (!/PASS|verified|verification|tests?/i.test(bodyAfterRun)) {
    throw new Error('Completed repo flow did not render verification evidence.');
  }

  // Reload recovery: completed result must survive.
  const beforeReload = await page.locator('#messages').innerText();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp();
  await page.waitForTimeout(1200);
  const afterReload = await page.locator('#messages').innerText();
  if (!afterReload.includes('review repo') || afterReload.length < Math.min(120, beforeReload.length / 2)) {
    throw new Error('Completed chat/result did not survive reload.');
  }
  await screenshot('03-after-reload');

  // Follow-up context should refer to the previous run, not ask what "it" means.
  await submit('is it fixed?');
  await waitForRunDone(180_000);
  await page.waitForTimeout(1000);
  const followup = await page.locator('#messages').innerText();
  if (/what ["“]?it["”]? refers to|need more context/i.test(followup)) {
    throw new Error('Follow-up lost prior run context.');
  }
  if (badRequests.length) throw new Error(`Bogus GitHub repo requests observed after follow-up: ${badRequests.join(', ')}`);
  await screenshot('04-followup-context');

  const relevantErrors = consoleErrors.filter(x => !/favicon\.ico/i.test(x));
  await fs.writeFile(`${outDir}/console-errors.txt`, relevantErrors.join('\n'));
  await fs.writeFile(`${outDir}/github-requests.txt`, githubRequests.join('\n'));
  if (relevantErrors.length) throw new Error(`Relevant browser/network errors:\n${relevantErrors.join('\n')}`);

  console.log('XRAI live E2E PASS');
  console.log(`GitHub requests observed: ${githubRequests.length}`);
} catch (error) {
  await screenshot('99-failure').catch(() => {});
  await fs.writeFile(`${outDir}/failure.txt`, String(error?.stack || error)).catch(() => {});
  await fs.writeFile(`${outDir}/console-errors.txt`, consoleErrors.join('\n')).catch(() => {});
  await fs.writeFile(`${outDir}/github-requests.txt`, githubRequests.join('\n')).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
