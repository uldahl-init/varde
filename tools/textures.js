// Background patterns for the skins (build 109, 0.36.0). Not part of the app; run by hand after changing a pattern:
//   node tools/textures.js            → rewrites the block between /* TEXTURES … */ and /* end of TEXTURES */ in index.html
//   node tools/textures.js --check    → exits 1 if the block differs from what this script writes (the smoke test runs it)
// Each pattern is a small SVG written into the styles as a data: address (nothing loaded from outside, works offline).
// Four per skin: page and header, light and dark mode. Shown only with body.pattern (the switch «Mønster i bakgrunnen»,
// off by default), never in Nattlys (body.night) and never with true black (body.black in dark mode).
// Fjell's lines are the tops of LAND_RIDGES (the Rondeslottet landscape in Notater and Innstillinger), read from index.html.
// Strength: thin lines at most 22 % opacity, areas at most 12 %; weaker in dark mode. Motifs for Fjell, Sommereng and
// Snø: Svein Atle, 25 Nov 2026.
'use strict';
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

// the ridge tops as points, thinned (Douglas–Peucker, 1.5 units: about half a pixel on a phone) and rounded to whole units
const simplify = (pts, tol) => {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  let k = 0, m = 0;
  for (let i = 1; i < pts.length - 1; i++){ const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len; if (d > m){ m = d; k = i; } }
  return m <= tol ? [a, b] : simplify(pts.slice(0, k + 1), tol).slice(0, -1).concat(simplify(pts.slice(k), tol));
};
const ridges = JSON.parse(html.match(/const LAND_RIDGES = (\[[^\]]*\]);/)[1]).map(d => {
  const pts = d.replace(/ L1037\.7,1040 L-13\.7,1040Z$/, '').replace(/^M/, '').trim().split(/\s+/).map(q => q.split(',').map(Number));
  return 'M' + simplify(pts, 1.5).map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ');
});
const f1 = v => Math.round(v).toString();   // whole units: the motifs are drawn at about one pixel per unit
const f3 = v => (Math.round(v * 1000) / 1000).toString();
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const url = svg => 'url("data:image/svg+xml,' + encodeURIComponent(svg).replace(/%20/g, ' ').replace(/%3D/g, '=').replace(/%3A/g, ':')
  .replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/'/g, "'") + '")';
const W = '#FFFFFF';

// fractal noise in one colour; alpha = am · noise + ab
function noise(w, bf, oct, seed, col, am, ab){
  const [r, g, b] = rgb(col);
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${w}'><filter id='f' x='0' y='0' width='100%' height='100%'>`
    + `<feTurbulence type='fractalNoise' baseFrequency='${bf}' numOctaves='${oct}' seed='${seed}' stitchTiles='stitch'/>`
    + `<feColorMatrix values='0 0 0 0 ${f3(r)} 0 0 0 0 ${f3(g)} 0 0 0 0 ${f3(b)} ${am} 0 0 0 ${ab}'/></filter>`
    + `<rect width='100%' height='100%' filter='url(#f)'/></svg>`;
}
const grain = (col, am, ab, bf) => noise(180, bf, 3, 0, col, am, ab);
// Fjell: the ridge tops, stacked; the picture is stretched to the page width and repeated downwards
function fjell(col, a){
  const g = [0, 2, 3, 4, 5].map(i => `<path d='${ridges[i]}' fill='none' stroke='${col}' stroke-opacity='${a}' stroke-width='2.6' stroke-linejoin='round'/>`).join('');
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 360 1024 480' width='1024' height='480'>${g}</svg>`;
}
// Snø: small six-armed crystals with a pair of side branches on each arm
function crystal(cx, cy, r, rot){
  let d = '';
  for (let k = 0; k < 6; k++){
    const a = (rot + 60 * k) * Math.PI / 180;
    d += `M${f1(cx)},${f1(cy)}L${f1(cx + r * Math.cos(a))},${f1(cy + r * Math.sin(a))}`;
    for (const s of [-1, 1]){
      const bx = cx + .55 * r * Math.cos(a), by = cy + .55 * r * Math.sin(a), b = a + s * Math.PI / 4;
      d += `M${f1(bx)},${f1(by)}L${f1(bx + .32 * r * Math.cos(b))},${f1(by + .32 * r * Math.sin(b))}`;
    }
  }
  return d;
}
const CRYSTALS = [[40, 50, 9, 0], [170, 30, 6, 20], [120, 130, 11, 10], [215, 190, 7, 35], [55, 205, 8, 15], [240, 90, 5, 0]].map(c => crystal(...c)).join('');
const sno = (col, a) => `<svg xmlns='http://www.w3.org/2000/svg' width='260' height='240'><path d='${CRYSTALS}' fill='none' stroke='${col}' stroke-opacity='${a}' stroke-width='1.1' stroke-linecap='round'/></svg>`;
// Sommereng: dandelion clocks (seed lines with a dot at the end, and a stem) and tufts of grass
function dandelion(cx, cy, r, stem){
  let d = `M${cx},${cy + 2}Q${cx - 4},${f1(cy + stem * .5)} ${cx + 2},${cy + stem}`, dots = '';
  for (let k = 0; k < 18; k++){
    const a = k * 20 * Math.PI / 180, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    d += `M${f1(cx + 2.2 * Math.cos(a))},${f1(cy + 2.2 * Math.sin(a))}L${f1(x)},${f1(y)}`;
    dots += `M${f1(x)},${f1(y)}h0`;   // a dot: a zero-length line with a round cap
  }
  return [d, dots];
}
const grass = (x, y, h) => [[0, -6, 1], [4, 3, .8], [7, 9, .65], [-3, -11, .55]]
  .map(([dx, bend, f]) => `M${x + dx},${y}Q${f1(x + dx + bend * .4)},${f1(y - h * f * .6)} ${x + dx + bend},${f1(y - h * f)}`).join('');
const [D1, C1] = dandelion(70, 70, 16, 60), [D2, C2] = dandelion(230, 180, 11, 45);
const GRASS = grass(150, 140, 40) + grass(30, 300, 32) + grass(270, 300, 26);
const eng = (col, a) => `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'><g fill='none' stroke='${col}' stroke-opacity='${a}' stroke-width='1.2' stroke-linecap='round'><path d='${D1}${D2}${GRASS}'/></g>`
  + `<path d='${C1}${C2}' stroke='${col}' stroke-opacity='${f3(+a + .03)}' stroke-width='2.2' stroke-linecap='round'/></svg>`;

// [page light, header light, page dark, header dark]
const T = {
  fjell: [fjell('#1D2B2A', '.09'), fjell(W, '.13'), fjell('#E3EAE6', '.07'), fjell(W, '.09')],
  mose: [noise(300, '.025', 3, 7, '#3D4F2E', '.45', '-.17'), noise(300, '.025', 3, 7, W, '.3', '-.11'), noise(300, '.025', 3, 7, '#A9BD8A', '.2', '-.075'), noise(300, '.025', 3, 7, W, '.2', '-.075')],
  fjord: [noise(400, '.003 .11', 2, 2, '#1D3A4F', '.5', '-.22'), noise(400, '.003 .11', 2, 2, W, '.45', '-.2'), noise(400, '.003 .11', 2, 2, '#7FB6C6', '.25', '-.11'), noise(400, '.003 .11', 2, 2, W, '.25', '-.11')],
  eng: [eng('#6B4A73', '.17'), eng(W, '.2'), eng('#F0E8F0', '.1'), eng(W, '.12')],
  berg: [grain('#000000', '.55', '-.18', '.85'), grain('#000000', '.55', '-.18', '.85'), grain(W, '.4', '-.14', '.85'), grain(W, '.4', '-.14', '.85')],
  bris: [noise(400, '.0025 .06', 2, 5, '#2E6FA3', '.38', '-.18'), noise(400, '.0025 .06', 2, 5, '#17324A', '.3', '-.14'), noise(400, '.0025 .06', 2, 5, '#74B4EA', '.2', '-.095'), noise(400, '.0025 .06', 2, 5, W, '.18', '-.085')],
  sno: [sno('#5E7BA6', '.22'), sno('#5E7BA6', '.22'), sno('#EDEDF0', '.12'), sno(W, '.12')],
  sand: [grain('#6B5230', '.5', '-.2', '1.4'), grain('#6B5230', '.5', '-.2', '1.4'), grain('#FFEBC7', '.38', '-.15', '1.4'), grain('#FFEBC7', '.38', '-.15', '1.4')]
};
const SIZE = {fjell: ';background-size:100% auto;background-repeat:repeat-y'};

const L = (k, h) => `body.pattern:not(.night)[data-skin="${k}"]${h ? ' header.top' : ''}`;
const D = (pre, k, h) => `${pre} body.pattern:not(.night):not(.black)[data-skin="${k}"]${h ? ' header.top' : ''}`;
let out = '';
for (const [k, [pl, hl, pd, hd]] of Object.entries(T)){
  const sz = SIZE[k] || '';
  out += `${L(k, 0)}{background-image:${url(pl)}${sz}}\n${L(k, 1)}{background-image:${url(hl)}${sz}}\n`;
  out += `@media (prefers-color-scheme: dark){${D(':root:not([data-theme="light"])', k, 0)}{background-image:${url(pd)}}${D(':root:not([data-theme="light"])', k, 1)}{background-image:${url(hd)}}}\n`;
  out += `${D(':root[data-theme="dark"]', k, 0)}{background-image:${url(pd)}}${D(':root[data-theme="dark"]', k, 1)}{background-image:${url(hd)}}\n`;
}
// true black in dark mode: no pattern (the light-mode rules above would otherwise still apply there)
out += `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) body.pattern.black,:root:not([data-theme="light"]) body.pattern.black header.top{background-image:none}}\n`;
out += `:root[data-theme="dark"] body.pattern.black,:root[data-theme="dark"] body.pattern.black header.top{background-image:none}\n`;

const START = '/* TEXTURES: written by tools/textures.js; do not edit by hand. */\n', END = '/* end of TEXTURES */';
const i = html.indexOf(START), j = html.indexOf(END);
if (i < 0 || j < i){ console.error('markers not found in index.html'); process.exit(2); }
const next = html.slice(0, i + START.length) + out + html.slice(j);
if (process.argv.includes('--check')){
  if (next !== html){ console.error('the TEXTURES block is out of date: run node tools/textures.js'); process.exit(1); }
  console.log('TEXTURES block up to date');
} else {
  fs.writeFileSync(FILE, next);
  console.log(`TEXTURES block written: ${Object.keys(T).length} skins, ${out.length} characters`);
}
