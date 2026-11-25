// Eclipse tables for the app (build 104, 0.31.0). Not part of the app; run by hand when the tables need extending:
//   node tools/eclipses.js [firstYear] [lastYear]        (default 2027 2040)  → rewrites the block in index.html
// Source: Astronomy Engine (Don Cross, MIT licence, a devDependency only). For each solar eclipse the script works out
// the Besselian elements from the geocentric Sun and Moon (Explanatory Supplement to the Astronomical Almanac, ch. 11)
// every 10 minutes from 4 hours before to 4 hours after the greatest eclipse, and fits a cubic in t (hours from t0,
// UT) to each: x, y, d, μ, l1, l2. tan f1 and tan f2 are the means. Distances are in Earth equatorial radii.
// Lunar eclipses: only partial and total ones (penumbral ones are too faint to notice), as the greatest eclipse (UT)
// and the half-lengths of the partial and total phases in minutes.
'use strict';
const fs = require('fs'), path = require('path');
const A = require('astronomy-engine');
const Y0 = +(process.argv[2] || 2027), Y1 = +(process.argv[3] || 2040);
const AU_KM = 149597870.7, RE = 6378.137, RS = 696000 / RE, K = 0.2725076, R = Math.PI / 180;

function eqd(vec, time){ const v = A.RotateVector(A.Rotation_EQJ_EQD(time), vec); return [v.x * AU_KM / RE, v.y * AU_KM / RE, v.z * AU_KM / RE]; }
function besselAt(time){
  const S = eqd(A.GeoVector(A.Body.Sun, time, true), time), M = eqd(A.GeoMoon(time), time);
  const G = [S[0] - M[0], S[1] - M[1], S[2] - M[2]], gl = Math.hypot(...G), g = G.map(c => c / gl);
  const d = Math.asin(g[2]), a = Math.atan2(g[1], g[0]);
  const x = -M[0] * Math.sin(a) + M[1] * Math.cos(a);
  const y = -M[0] * Math.sin(d) * Math.cos(a) - M[1] * Math.sin(d) * Math.sin(a) + M[2] * Math.cos(d);
  const z = M[0] * g[0] + M[1] * g[1] + M[2] * g[2];
  const f1 = Math.asin((RS + K) / gl), f2 = Math.asin((RS - K) / gl);
  const l1 = z * Math.tan(f1) + K / Math.cos(f1), l2 = z * Math.tan(f2) - K / Math.cos(f2);
  const mu = A.SiderealTime(time) * 15 - a / R;
  return {x, y, d: d / R, mu, l1, l2, tf1: Math.tan(f1), tf2: Math.tan(f2)};
}
// least squares cubic through (t, v)
function cubic(ts, vs){
  const n = 4, M = Array.from({length:n}, () => new Array(n + 1).fill(0));
  ts.forEach((t, k) => { for (let i = 0; i < n; i++){ for (let j = 0; j < n; j++) M[i][j] += t ** (i + j); M[i][n] += vs[k] * t ** i; } });
  for (let i = 0; i < n; i++){ const p = M[i][i]; for (let j = i; j <= n; j++) M[i][j] /= p;
    for (let r = 0; r < n; r++) if (r !== i){ const f = M[r][i]; for (let j = i; j <= n; j++) M[r][j] -= f * M[i][j]; } }
  return M.map(r => r[n]);
}
const rd = (v, k) => +v.toFixed(k);
const solar = [];
let e = A.SearchGlobalSolarEclipse(new Date(Date.UTC(Y0, 0, 1)));
while (e.peak.date.getUTCFullYear() <= Y1){
  const t0 = Math.round(e.peak.date.getTime() / 60000) * 60000, ts = [], el = [];
  for (let m = -240; m <= 240; m += 10){ ts.push(m / 60); el.push(besselAt(A.MakeTime(new Date(t0 + m * 60000)))); }
  let mus = el.map(b => b.mu), prev = mus[0];
  mus = mus.map(v => { while (v - prev > 180) v -= 360; while (v - prev < -180) v += 360; prev = v; return v; });
  const f = k => cubic(ts, el.map(b => b[k]));
  const row = [t0, ...f('x').map(v => rd(v, 7)), ...f('y').map(v => rd(v, 7)), ...f('d').map(v => rd(v, 7)),
    ...cubic(ts, mus).map((v, i) => rd(i ? v : ((v % 360) + 360) % 360, 6)), ...f('l1').map(v => rd(v, 7)), ...f('l2').map(v => rd(v, 7)),
    rd(el.reduce((s, b) => s + b.tf1, 0) / el.length, 8), rd(el.reduce((s, b) => s + b.tf2, 0) / el.length, 8)];
  solar.push(row);
  e = A.NextGlobalSolarEclipse(e.peak);
}
const lunar = [];
let l = A.SearchLunarEclipse(new Date(Date.UTC(Y0, 0, 1)));
while (l.peak.date.getUTCFullYear() <= Y1){
  if (l.kind !== 'penumbral') lunar.push([Math.round(l.peak.date.getTime() / 60000) * 60000, rd(l.sd_partial, 1), rd(l.sd_total, 1)]);
  l = A.NextLunarEclipse(l.peak);
}
const block = `/* ECLIPSES ${Y0}–${Y1}: written by tools/eclipses.js from Astronomy Engine; do not edit by hand.
   ECL_SOLAR rows: t0 (ms, UT), then cubics in hours from t0 (c0..c3) for x, y, d (°), μ (°), l1, l2, then tan f1, tan f2.
   ECL_LUNAR rows: greatest eclipse (ms, UT), half-length of the partial phase, of the total phase (minutes; 0 = partial). */
const ECL_UNTIL = ${Y1};
const ECL_SOLAR = ${JSON.stringify(solar)};
const ECL_LUNAR = ${JSON.stringify(lunar)};
/* end of ECLIPSES */`;
const file = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8'), a = html.indexOf('/* ECLIPSES '), b = html.indexOf('/* end of ECLIPSES */');
if (a < 0 || b < 0) throw new Error('the ECLIPSES block is missing in index.html');
fs.writeFileSync(file, html.slice(0, a) + block + html.slice(b + '/* end of ECLIPSES */'.length));
console.log(`${solar.length} solar and ${lunar.length} lunar eclipses ${Y0}–${Y1} written to index.html`);
