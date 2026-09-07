/**
 * Browser smoke test.
 *
 * Visits every route against a running dev server, fails on any console error,
 * page error, or failed request, and reports what actually rendered. Catches
 * the class of breakage TypeScript cannot: hydration mismatches, undefined
 * reads inside render, and charts that throw on empty data.
 *
 *   npm run dev          # in one terminal
 *   npm run smoke        # in another
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SMOKE_SHOTS ?? null;

const ROUTES = [
  ['/', 'Network overview'],
  ['/map', 'Network map'],
  ['/monitoring', 'Live monitoring'],
  ['/anomalies', 'Anomalies'],
  ['/incidents', 'Incidents'],
  ['/events', 'Weather event analysis'],
  ['/corrections', 'Corrected values'],
  ['/health', 'Sensor health'],
  ['/maintenance', 'Maintenance'],
  ['/history', 'Historical analysis'],
  ['/models', 'Model lab'],
  ['/alerts', 'Alerts'],
  ['/reports', 'Reports'],
  ['/audit', 'Audit log'],
  ['/settings', 'Settings'],
  ['/mission-control', 'Mission control'],
  ['/stations/AWS-007', 'Station detail'],
];

// Noise that is expected and not a defect.
const IGNORE = [
  /Download the React DevTools/i,
  /favicon\.ico/i,
  /\[Fast Refresh\]/i,
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

for (const [route, name] of ROUTES) {
  const problems = [];

  const onConsole = (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (IGNORE.some((re) => re.test(text))) return;
    problems.push(`console.${msg.type()}: ${text.slice(0, 300)}`);
  };
  const onPageError = (err) => problems.push(`pageerror: ${String(err).slice(0, 300)}`);
  const onFailed = (req) => {
    const url = req.url();
    if (IGNORE.some((re) => re.test(url))) return;
    // Navigating away cancels in-flight tile requests. That is the harness
    // moving on, not a defect in the page.
    const reason = req.failure()?.errorText ?? '';
    if (reason.includes('ERR_ABORTED')) return;
    problems.push(`requestfailed (${reason}): ${url.slice(0, 140)}`);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onFailed);

  let rendered = '';
  try {
    const res = await page.goto(`${BASE}${route}`, {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });
    if (!res || res.status() >= 400) problems.push(`http ${res?.status()}`);

    // Wait for the client to finish booting the simulation.
    await page
      .waitForFunction(
        () => !document.body.innerText.includes('Initialising station network'),
        { timeout: 30000 },
      )
      .catch(() => problems.push('stuck on boot screen'));

    rendered = await page.evaluate(() =>
      document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 110),
    );
    if (rendered.length < 40) problems.push('page rendered almost nothing');

    if (SHOTS) {
      const file = `${SHOTS}/${route.replace(/\//g, '_') || '_root'}.png`;
      await page.screenshot({ path: file, fullPage: false });
    }
  } catch (err) {
    problems.push(`navigation: ${String(err).slice(0, 200)}`);
  }

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('requestfailed', onFailed);

  if (problems.length) {
    failures++;
    console.log(`FAIL  ${route.padEnd(22)} ${name}`);
    for (const p of problems) console.log(`        ${p}`);
  } else {
    console.log(`ok    ${route.padEnd(22)} ${rendered.slice(0, 74)}`);
  }
}

await browser.close();
console.log(failures ? `\n${failures} route(s) failed.` : '\nAll routes clean.');
process.exit(failures ? 1 : 0);
