// Visual QA: drives the system Chrome headless through every arcade screen and saves screenshots.
//   npx tsx scripts/qa-shots.ts <baseUrl> <outDir>
// Needs a running dev server (offchain is fine). Uses playwright-core with the installed Chrome.
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:5199';
const out = process.argv[3] ?? 'qa';
mkdirSync(out, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const errors: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
}

async function tour(label: string, viewport: { width: number; height: number }, mobile: boolean) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] PAGEERROR ${e.message}`));

  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await sleep(2500);
  await shot(page, `${label}-01-attract`);
  await sleep(4000);
  await shot(page, `${label}-02-attract-later`);
  await page.keyboard.press('5');
  await sleep(600);
  await page.keyboard.press('Enter');
  await sleep(1500);
  await shot(page, `${label}-03-select`);

  const routes: [string, number][] = [['micro', 1800], ['catch', 2500], ['prizes', 2000], ['bestiary', 2000], ['broadcast', 2500], ['about', 1500], ['ai-test', 2500]];
  for (const [r, wait] of routes) {
    await page.goto(`${base}/#${r}`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(wait);
    await shot(page, `${label}-${r}`);
    if (r === 'micro') {
      await page.keyboard.press('Enter');
      await sleep(1200);
      await shot(page, `${label}-micro-2`);
      await sleep(2500);
      await shot(page, `${label}-micro-3`);
    }
    if (r === 'catch') {
      // pick the first habitat (Enter / A) and let the hunt run
      await page.keyboard.press('Enter');
      await sleep(1500);
      await page.keyboard.press('Enter');
      await sleep(3500);
      await shot(page, `${label}-catch-2`);
      const vp = page.viewportSize()!;
      for (let i = 0; i < 6; i++) { await page.mouse.click(vp.width * (0.3 + 0.08 * i), vp.height * 0.45); await sleep(250); }
      await sleep(1500);
      await shot(page, `${label}-catch-3`);
    }
    if (r === 'prizes') {
      await page.evaluate(() => { try { localStorage.setItem('beastarcade.tickets.v1', '5000'); } catch {} });
      await page.reload({ waitUntil: 'networkidle' });
      await sleep(1500);
      await page.keyboard.press('Enter');
      await sleep(3500);
      await shot(page, `${label}-prizes-2`);
    }
  }
  await browser.close();
}

await tour('desk', { width: 1280, height: 800 }, false);
await tour('phone', { width: 390, height: 844 }, true);
console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 30)) console.log(e);
