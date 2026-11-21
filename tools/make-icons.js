// Builds the app icons from one landscape in design/icons (see "App icon" in CLAUDE.md). Not part of the app.
//   node tools/make-icons.js            the active variant (ACTIVE below) into the repository root
//   node tools/make-icons.js night      another variant
//   node tools/make-icons.js dusk out/  into another folder (for previews)
// Writes icon-192.png and icon-512.png (rounded square, transparent corners), icon-maskable-512.png (Android crops it
// to its own shape), apple-touch-icon.png (square; iPhone rounds it) and icon.svg (the browser tab).
// The frame follows the icon's shape: the landscape sits in a rounded square inset by MARGIN, with a corner radius of
// the outer radius minus MARGIN, so the frame is equally wide all round, also in the corners.
// Uses Chromium from Playwright (the smoke test's); CHROMIUM_PATH points to another Chromium if needed.
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const ACTIVE = 'dusk';
// frame colour per variant: a little darker than the ground at the bottom, so the frame reads as even all round
// (the ground's own colour hid the frame along the bottom edge)
const VARIANTS = { dusk:'#263B52', night:'#080D19', sunset:'#252934' };
const S = 1024;                   // design size of the landscapes
const RADIUS = 0.2237 * S;        // outer corner radius, as iPhone rounds its icons
const MARGIN = 48;                // frame width
const INNER = RADIUS - MARGIN;    // inner radius: the frame keeps its width round the corners

const variant = process.argv[2] || ACTIVE;
const outDir = path.resolve(process.argv[3] || path.join(__dirname, '..'));
if (!VARIANTS[variant]) { console.error(`Unknown variant "${variant}". Known: ${Object.keys(VARIANTS).join(', ')}`); process.exit(1); }
const frame = VARIANTS[variant];
const src = fs.readFileSync(path.join(__dirname, '..', 'design', 'icons', `landscape-${variant}.svg`), 'utf8');
const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');   // the landscape without its <svg> wrapper

// framed: the landscape scaled into the inner rounded square; outer = 'round' (transparent corners) or 'square'.
// The frame is laid on top as a ring (a passe-partout), and the landscape runs BLEED px in under it: clipping the
// landscape itself at the opening let the light sky shine through the ground along the edge (a thin light line).
// A frame-coloured base under it means the edge pixels only ever mix frame and landscape.
const BLEED = 12;
function framed(outer){
  const k = (S - 2 * MARGIN) / S, b = MARGIN - BLEED;   // b: how far out the landscape runs under the frame
  const out = outer === 'round' ? `M${RADIUS},0H${S - RADIUS}A${RADIUS},${RADIUS} 0 0 1 ${S},${RADIUS}V${S - RADIUS}A${RADIUS},${RADIUS} 0 0 1 ${S - RADIUS},${S}H${RADIUS}A${RADIUS},${RADIUS} 0 0 1 0,${S - RADIUS}V${RADIUS}A${RADIUS},${RADIUS} 0 0 1 ${RADIUS},0Z`
    : `M0,0H${S}V${S}H0Z`;
  const m = MARGIN, r = INNER;
  const hole = `M${m + r},${m}H${S - m - r}A${r},${r} 0 0 1 ${S - m},${m + r}V${S - m - r}A${r},${r} 0 0 1 ${S - m - r},${S - m}H${m + r}A${r},${r} 0 0 1 ${m},${S - m - r}V${m + r}A${r},${r} 0 0 1 ${m + r},${m}Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
<defs><clipPath id="under-frame"><rect x="${b}" y="${b}" width="${S - 2 * b}" height="${S - 2 * b}" rx="${INNER + BLEED}"/></clipPath></defs>
<rect x="${b}" y="${b}" width="${S - 2 * b}" height="${S - 2 * b}" rx="${INNER + BLEED}" fill="${frame}"/>
<g clip-path="url(#under-frame)"><g transform="translate(${MARGIN} ${MARGIN}) scale(${k})">${inner}</g></g>
<path fill="${frame}" fill-rule="evenodd" d="${out}${hole}"/>
</svg>\n`;
}
// bleed: the landscape to every edge; Android's own shape is the edge (no frame can follow every launcher's shape)
const bleed = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">${inner}</svg>\n`;

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {});
  const page = await browser.newPage();
  const png = async (svg, size, file) => {
    await page.setViewportSize({width: size, height: size});
    await page.setContent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
    await page.locator('img').evaluate(i => i.decode());
    await page.screenshot({path: path.join(outDir, file), omitBackground: true, clip: {x: 0, y: 0, width: size, height: size}});
  };
  fs.mkdirSync(outDir, {recursive: true});
  const round = framed('round');
  await png(round, 512, 'icon-512.png');
  await png(round, 192, 'icon-192.png');
  await png(bleed(), 512, 'icon-maskable-512.png');
  await png(framed('square'), 180, 'apple-touch-icon.png');
  fs.writeFileSync(path.join(outDir, 'icon.svg'), round);
  await browser.close();
  console.log(`Icons from "${variant}" written to ${outDir}`);
})();
