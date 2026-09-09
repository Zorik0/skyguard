/**
 * Render the presentation deck to PDF.
 *
 * `docs/presentation.html` is the source of truth — edit that, then run this to
 * regenerate `docs/SkyGuard-Presentation.pdf`. Each <section class="slide"> is a
 * fixed 1280×720 page, so the deck opens full-screen in any PDF reader.
 *
 *   npm run deck
 *
 * Needs a local Chrome. Override with CHROME_PATH=... if yours lives elsewhere.
 */
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const src = resolve(process.argv[2] ?? 'docs/presentation.html');
const out = resolve(process.argv[3] ?? 'docs/SkyGuard-Presentation.pdf');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle0' });
  await page.evaluateHandle('document.fonts.ready');

  // A slide that outgrows its page is silently clipped — `.slide` is a fixed
  // 720px box with `overflow:hidden`, so `scrollHeight` alone would report it
  // as fine. Measure what the content actually needs instead: the body is
  // vertically centred, which pushes overflow off *both* edges, so switch it to
  // top-aligned first and then add up padding + header + content.
  const overflow = await page.evaluate(() => {
    document.querySelectorAll('.body').forEach((el) => {
      el.style.justifyContent = 'flex-start';
    });
    return [...document.querySelectorAll('.slide')]
      .map((slide, i) => {
        const cs = getComputedStyle(slide);
        const top = slide.querySelector('.top');
        const body = slide.querySelector('.body');
        const needed =
          parseFloat(cs.paddingTop) +
          (top ? top.offsetHeight + parseFloat(getComputedStyle(top).marginBottom) : 0) +
          (body ? body.scrollHeight : 0) +
          parseFloat(cs.paddingBottom);
        return { slide: i + 1, needed: Math.round(needed), over: Math.round(needed - 720) };
      })
      .filter((s) => s.over > 0);
  });
  // Undo the measurement tweak before rendering.
  await page.evaluate(() => {
    document.querySelectorAll('.body').forEach((el) => {
      el.style.justifyContent = '';
    });
  });

  await page.pdf({
    path: out,
    width: '1280px',
    height: '720px',
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  if (overflow.length) {
    console.error('Slides overflowing 1280×720:', JSON.stringify(overflow));
    process.exitCode = 1;
  } else {
    console.log('Layout OK — every slide fits 1280×720.');
  }
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
}
