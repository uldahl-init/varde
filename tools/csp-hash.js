// Varde: keep the script hash in the Content-Security-Policy <meta> tag in step with the inline script.
// The CSP only lets the inline script run if its SHA-256 hash is listed, so every change to the script
// needs a new hash, or the app will not start. Not part of the app (no build step): run it before committing.
//   node tools/csp-hash.js          check (exit code 1 if the hash is out of date)
//   node tools/csp-hash.js --write  write the current hash into index.html
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const file = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length !== 1){ console.error(`Expected one inline <script>, found ${scripts.length}.`); process.exit(1); }
const hash = "'sha256-" + crypto.createHash('sha256').update(scripts[0].replace(/\r\n?/g, '\n'), 'utf8').digest('base64') + "'";
const rx = /'sha256-[A-Za-z0-9+/=]+'/;
const meta = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/) || [])[1];
if (!meta || !rx.test(meta)){ console.error('No Content-Security-Policy <meta> tag with a sha256 hash found.'); process.exit(1); }
if (meta.match(rx)[0] === hash){ console.log('CSP hash is up to date: ' + hash); process.exit(0); }
if (process.argv.includes('--write')){
  fs.writeFileSync(file, html.replace(meta, meta.replace(rx, hash)));
  console.log('CSP hash written: ' + hash);
} else { console.error('CSP hash is out of date. Run: node tools/csp-hash.js --write'); process.exit(1); }
