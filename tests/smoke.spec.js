// Smoke test for Varde (see "Smoke test" in CLAUDE.md): does the app still load and work?
// Guides and calculators are read from the page, so new ones are tested without changes here.
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const KEY = 'outdoor-lists-v1';
const APP_VERSION = (HTML.match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
const APP_BUILD = (HTML.match(/const APP_BUILD\s*=\s*(\d+)/) || [])[1];

// Files the app may ask for that are allowed to be missing (a 404 for these is not an error).
const OPTIONAL = ['/favicon.ico'];
const optional = url => { try { return OPTIONAL.includes(new URL(url).pathname); } catch(e){ return false; } };

const LANGS = [
  {lang:'no', locale:'nb-NO', htmlLang:'nb', main:['Før tur', 'Overnatting', 'Generelt turutstyr', 'Tøy', 'Matlaging', 'Mat']},
  {lang:'en', locale:'en-GB', htmlLang:'en', main:['Before you go', 'Sleeping', 'General gear', 'Clothing', 'Cooking', 'Food']}
];

/* ---------- static checks (no browser) ---------- */
test.describe('static', () => {
  test('inline script passes node --check', () => {
    const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim());
    expect(scripts.length).toBeGreaterThan(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varde-'));
    scripts.forEach((s, i) => {
      const f = path.join(dir, `inline-${i}.js`);
      fs.writeFileSync(f, s);
      execFileSync(process.execPath, ['--check', f], {stdio:'pipe'});
    });
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'sw.js')], {stdio:'pipe'});
  });

  test('APP_BUILD matches the CACHE build in sw.js', () => {
    const cache = (SW.match(/const CACHE\s*=\s*'[a-z]+-b(\d+)'/) || [])[1];
    expect(APP_BUILD, 'APP_BUILD in index.html').toBeTruthy();
    expect(cache, 'build number in CACHE in sw.js').toBeTruthy();
    expect(cache).toBe(APP_BUILD);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('storage KEY is unchanged', () => {
    expect((HTML.match(/const KEY\s*=\s*'([^']+)'/) || [])[1]).toBe(KEY);
  });

  test('CSP hash matches the inline script (build 58)', () => {
    // A stale hash stops the whole app from starting. Fix: node tools/csp-hash.js --write
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'csp-hash.js')], {stdio:'pipe'});
  });

  test('every file in ASSETS in sw.js exists', () => {
    const list = (SW.match(/const ASSETS\s*=\s*\[([\s\S]*?)\]/) || [])[1];
    expect(list).toBeTruthy();
    const files = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
    expect(files.length).toBeGreaterThan(5);
    const missing = files.filter(f => f !== './' && !fs.existsSync(path.join(ROOT, f)));
    expect(missing).toEqual([]);
  });
});

/* ---------- in the browser ---------- */
// GUIDE_GROUPS as written in index.html, to check that the Guider page shows every one of them.
function guideKeysFromSource(){
  const block = (HTML.match(/const GUIDE_GROUPS\s*=\s*\[([\s\S]*?)\n\];/) || [])[1] || '';
  return [...block.matchAll(/items:\s*\[([^\]]*)\]/g)].flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
}

function watchErrors(page){
  const errors = [];
  page.on('pageerror', e => errors.push('page error: ' + (e.stack || e.message)));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const url = (msg.location() || {}).url || '';
    if (optional(url) && /404/.test(msg.text())) return;
    errors.push('console error: ' + msg.text() + (url ? ' (' + url + ')' : ''));
  });
  page.on('response', r => { if (r.status() >= 400 && !optional(r.url())) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  page.on('requestfailed', r => { if (!optional(r.url())) errors.push(`request failed: ${r.url()} (${(r.failure() || {}).errorText})`); });
  return errors;
}

async function openApp(page){
  // The introduction is marked as done; the language comes from the browser locale, as on a new phone.
  await page.addInitScript(([key]) => {
    try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({lists:[], hidePacked:false, introDone:true})); } catch(e){}
  }, [KEY]);
  await page.goto('./');
  await expect(page.locator('#tabbar [data-tab]')).toHaveCount(5);
  await expect(page.locator('#intro')).toBeHidden();
}

const title = page => page.locator('#listName');
const tabLabel = (page, k) => page.locator(`#tabbar [data-tab="${k}"] span`).innerText();
async function goTab(page, k){
  await page.locator(`#tabbar [data-tab="${k}"]`).click();
  await expect(page.locator(`#tabbar [data-tab="${k}"]`)).toHaveAttribute('aria-current', 'page');
}
// 0.15.0: Guider groups fold; open the row's group first (Planlegg rows are never folded)
async function openRow(page, k){
  await page.evaluate(k => { const r = document.querySelector(`#main [data-open="${k}"]`), ix = r && r.closest('.index.gf-closed'); if (ix) ix.previousElementSibling.click(); }, k);
  await page.locator(`#main [data-open="${k}"]`).click();
}
async function settle(page, errors){
  await page.waitForTimeout(300);
  expect(errors, 'no page errors, console errors or failed requests').toEqual([]);
}

for (const L of LANGS){
  test.describe(`app (${L.locale})`, () => {
    test.use({locale: L.locale});
    let errors;
    test.beforeEach(async ({page}) => { errors = watchErrors(page); await openApp(page); });

    test('loads in the right language', async ({page}) => {
      await expect(page.locator('html')).toHaveAttribute('lang', L.htmlLang);
      await expect(title(page)).not.toBeEmpty();
      await expect(page.locator('#main section.cat').first()).toBeVisible();
      await settle(page, errors);
    });

    test('all five tabs open', async ({page}) => {
      for (const k of ['list', 'notes', 'plan', 'guide', 'compass']){
        await goTab(page, k);
        await expect(title(page)).not.toBeEmpty();
        await expect(page.locator('#main')).not.toBeEmpty();
      }
      await settle(page, errors);
    });

    test('every guide opens and Back returns to Guider', async ({page}) => {
      await goTab(page, 'guide');
      const guider = await tabLabel(page, 'guide');
      const keys = await page.locator('#main [data-open]').evaluateAll(els => els.map(e => e.dataset.open));
      expect(keys).toEqual(guideKeysFromSource());
      for (const k of keys){
        await openRow(page, k);
        await expect(page.locator('#main .back'), `guide ${k} has a back button`).toBeVisible();
        await expect(title(page), `guide ${k} shows a title`).not.toBeEmpty();
        await expect(title(page), `guide ${k} shows its own title`).not.toHaveText(guider);
        await page.locator('#main .back').click();
        await expect(title(page)).toHaveText(guider);
        await expect(page.locator('#main [data-open]')).toHaveCount(keys.length);
      }
      await settle(page, errors);
    });

    test('Søk i Guider: every guide is searchable and results open their section', async ({page}) => {
      await goTab(page, 'guide');
      const guider = await tabLabel(page, 'guide');
      // the first section heading of every guide, read from the guide itself
      const keys = await page.locator('#main [data-open]').evaluateAll(els => els.map(e => e.dataset.open));
      expect(keys).toEqual(guideKeysFromSource());
      const firstSec = {};
      for (const k of keys){
        await openRow(page, k);
        const su = page.locator('#main details > summary').first();
        firstSec[k] = (await su.innerText()).split('\n').map(x => x.trim()).filter(Boolean)[0];
        expect(firstSec[k], `guide ${k} has a section`).toBeTruthy();
        await page.locator('#main .back').click();
      }
      // closed: the magnifier; open: the field, with focus
      await page.locator('#main .gs-btn').click();
      const input = page.locator('#gsInput');
      await expect(input).toBeFocused();
      // one letter keeps the groups; a word with no match says so
      await input.fill('e');
      await expect(page.locator('#main .ix-group').first()).toBeVisible();
      await input.fill('qqzzxx');
      await expect(page.locator('#main .gs-count')).toBeVisible();
      await expect(page.locator('#main .gs-hit')).toHaveCount(0);
      // every guide: search for its first section heading, open the result, the section is unfolded, Back keeps the search
      for (const k of keys){
        const sec = firstSec[k];
        await input.fill(sec);
        const hit = page.locator(`#main .gs-hit[data-guide="${k}"]`).filter({has: page.locator('.gs-s', {hasText: sec})}).first();
        await expect(hit, `result for ${k} / ${sec}`).toBeVisible();
        await hit.click();
        await expect(title(page)).not.toHaveText(guider);
        const open = await page.locator('#main details[open] > summary').allInnerTexts();
        expect(open.some(x => x.replace(/\s+/g, ' ').toLowerCase().includes(sec.toLowerCase())), `section ${sec} in ${k} is open`).toBe(true);
        await page.locator('#main .back').click();
        await expect(title(page)).toHaveText(guider);
        await expect(input).toHaveValue(sec);
      }
      // × closes, and leaving Guider clears the search
      await page.locator('#main .gs-x').click();
      await expect(page.locator('#main .gs-btn')).toBeVisible();
      await page.locator('#main .gs-btn').click();
      await input.fill('telt');
      await goTab(page, 'plan');
      await goTab(page, 'guide');
      await expect(page.locator('#main .gs-btn')).toBeVisible();
      await expect(page.locator('#gsInput')).toHaveCount(0);
      await settle(page, errors);
    });

    test('Søk i Guider finds text in the other language', async ({page}) => {
      // first section heading and section count of every guide, read from the guides themselves
      const readGuides = async () => {
        await goTab(page, 'guide');
        const keys = await page.locator('#main [data-open]').evaluateAll(els => els.map(e => e.dataset.open));
        const out = {};
        for (const k of keys){
          await openRow(page, k);
          const heads = (await page.locator('#main details > summary').allInnerTexts()).map(x => x.split('\n').map(y => y.trim()).filter(Boolean)[0]);
          out[k] = {first:heads[0], n:heads.length};
          await page.locator('#main .back').click();
        }
        return out;
      };
      const before = await readGuides();
      // switch to the other language in Innstillinger (from build 80, the gear in the header)
      const other = L.lang === 'no' ? 'en' : 'no';
      await goTab(page, 'list');
      await page.locator('#hdrSet').click();
      await page.locator(`#main [data-lang="${other}"]`).click();
      const after = await readGuides();
      for (const k of Object.keys(before)) expect(after[k].n, `guide ${k} has the same sections in both languages`).toBe(before[k].n);
      // search for each guide's first heading in the language just left: a result opens that section in the language now shown
      const guider = await tabLabel(page, 'guide');
      await page.locator('#main .gs-btn').click();
      const input = page.locator('#gsInput');
      let tagged = 0;
      for (const k of Object.keys(before)){
        await input.fill(before[k].first);
        tagged += await page.locator(`#main .gs-lang`).filter({hasText: L.lang === 'no' ? 'NO' : 'EN'}).count();
        const hit = page.locator(`#main .gs-hit[data-guide="${k}"]`).filter({has: page.locator('.gs-s', {hasText: after[k].first})}).first();
        await expect(hit, `result for ${k} / ${before[k].first}`).toBeVisible();
        await hit.click();
        const open = await page.locator('#main details[open] > summary').allInnerTexts();
        expect(open.some(x => x.replace(/\s+/g, ' ').toLowerCase().includes(after[k].first.toLowerCase())), `section ${after[k].first} in ${k} is open`).toBe(true);
        await page.locator('#main .back').click();
        await expect(title(page)).toHaveText(guider);
      }
      // some of those results came from the other language only and carry its tag
      expect(tagged, 'results tagged with the other language').toBeGreaterThan(0);
      await settle(page, errors);
    });

    test('every calculator in Planlegg opens', async ({page}) => {
      await goTab(page, 'plan');
      const plan = await tabLabel(page, 'plan');
      const keys = await page.locator('#main [data-open]').evaluateAll(els => els.map(e => e.dataset.open));
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys){
        await openRow(page, k);
        await expect(page.locator('#main .back'), `calculator ${k} has a back button`).toBeVisible();
        await expect(title(page), `calculator ${k} shows its own title`).not.toHaveText(plan);
        await page.locator('#main .back').click();
        await expect(title(page)).toHaveText(plan);
      }
      await settle(page, errors);
    });

    test('standard list, trip types and guide links', async ({page}) => {
      const heads = page.locator('#main section.cat .cat-head h2');
      await expect(heads).toHaveText(L.main);
      // switch on every trip type
      await page.locator('#main .modes-toggle').click();
      const modes = await page.locator('#main [data-mode]').evaluateAll(els => els.map(e => e.dataset.mode));
      expect(modes.length).toBeGreaterThan(0);
      for (const m of modes){
        await page.locator(`#main [data-mode="${m}"]`).click();
        await expect(page.locator(`#main [data-mode="${m}"]`)).toHaveAttribute('aria-pressed', 'true');
      }
      expect(await heads.count()).toBeGreaterThanOrEqual(L.main.length + modes.length);
      expect((await heads.allInnerTexts()).slice(0, L.main.length)).toEqual(L.main);
      // open every section, then follow every guide link
      const all = page.locator('#main [data-act="foldAll"]');
      if (await all.getAttribute('aria-expanded') !== 'true') await all.click();
      await expect(page.locator('#main section.cat.closed')).toHaveCount(0);
      const listName = await title(page).innerText();
      const links = await page.locator('#main [data-act="openGuide"]').evaluateAll(els => [...new Set(els.map(e => e.dataset.guide + '#' + (e.dataset.sec || '')))].map(x => x.split('#')));
      expect(links.length).toBeGreaterThan(0);
      const guider = await tabLabel(page, 'guide');
      for (const [g, s] of links){
        const sel = `#main [data-act="openGuide"][data-guide="${g}"]` + (s ? `[data-sec="${s}"]` : ':not([data-sec])');
        await page.locator(sel).first().click();
        await expect(page.locator('#tabbar [data-tab="guide"]')).toHaveAttribute('aria-current', 'page');
        await expect(title(page), `guide link ${g} opens a guide`).not.toHaveText(guider);
        await expect(title(page)).not.toBeEmpty();
        if (s) await expect(page.locator(`#main [data-sec="${s}"]`), `guide ${g} has section ${s}`).toHaveCount(1);
        await page.locator('#main .back').click();
        await expect(title(page)).toHaveText(listName);
      }
      await settle(page, errors);
    });

    test('version line under Hjelp', async ({page}) => {
      await page.locator('#hdrSet').click();
      const ver = page.locator('#main .app-ver');
      await expect(ver).toContainText(APP_VERSION);
      await expect(ver).toContainText(new RegExp(`\\b${APP_BUILD}\\b`));
      await settle(page, errors);
    });

    // From build 41 (0.6.0): Notater edited in place, Fest øverst, Del with preview, and a received note.
    test('Notater: edit in place, pin, share and receive', async ({page, browser}) => {
      const sheetOk = page.locator('#overlay [data-s="ok"]');
      await goTab(page, 'notes');
      for (const [ti, tx] of [['Alpha', 'first text'], ['Beta', 'second text']]){
        await page.locator('#main [data-act="newNote"]').click();
        await expect(page.locator('#noteTitle')).toBeFocused();   // the sheet focuses the title 30 ms after opening (build 82)
        await page.locator('#noteTitle').fill(ti);
        await page.locator('#noteText').fill(tx);
        await sheetOk.click();
        await expect(page.locator('#main .note-full h2')).toHaveText(ti);
        await page.locator('#main [data-act="back"]').click();
      }
      const rows = page.locator('#main .notes-ix [data-act="openNote"] .ix-t');
      await expect(rows.first()).toHaveText('Beta');
      // Fest øverst: Alpha goes to the top with a pin
      await page.locator('#main .notes-ix [data-act="openNote"]', {hasText: 'Alpha'}).click();
      await page.locator('#main [data-act="notePin"]').click();
      await page.locator('#main [data-act="back"]').click();
      await expect(rows.first()).toHaveText('Alpha');
      await expect(page.locator('#main .notes-ix .pin-ic')).toHaveCount(1);
      // edit in place: tapping the text gives fields on the page, no sheet
      await page.locator('#main .notes-ix [data-act="openNote"]', {hasText: 'Alpha'}).click();
      await page.locator('#main .note-body').click();
      await expect(page.locator('#overlay')).toBeHidden();
      await page.locator('#neText').fill('changed text');
      await page.locator('#main [data-act="noteSave"]').click();
      await expect(page.locator('#main .note-body')).toHaveText('changed text');
      // Del: preview first, then the link carries only title, text and the optional name
      await page.evaluate(() => { window.__shared = null; navigator.share = async d => { window.__shared = d.url; }; });
      await page.locator('#main [data-act="noteShare"]').click();
      await expect(page.locator('#overlay .sh-prev')).toContainText('changed text');
      await page.locator('#shName').fill('Kari');
      await sheetOk.click();
      await expect.poll(() => page.evaluate(() => window.__shared)).toContain('#note=');
      const url = await page.evaluate(() => window.__shared);
      await expect(page.locator('#main .note-tags')).not.toBeEmpty();
      // another phone opens the link: preview, add, dashed outline and the name in the tag
      const ctx = await browser.newContext({locale: L.locale, serviceWorkers: 'block', viewport: {width: 390, height: 780}});
      const p2 = await ctx.newPage();
      const err2 = watchErrors(p2);
      await p2.addInitScript(([key]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({lists:[], hidePacked:false, introDone:true})); } catch(e){} }, [KEY]);
      await p2.goto(url);
      await expect(p2.locator('#overlay .sh-prev')).toContainText('Alpha');
      await p2.locator('#overlay [data-s="ok"]').click();
      await expect(p2.locator('#main .note-full.rcv h2')).toHaveText('Alpha');
      await expect(p2.locator('#main .note-tags')).toContainText('Kari');
      await p2.waitForTimeout(300);
      expect(err2, 'no errors on the receiving phone').toEqual([]);
      await ctx.close();
      await settle(page, errors);
    });

    // From build 42 (0.7.0): emergency numbers follow the saved position, and guide web links offer «Legg til i Dine lenker».
    test('Medisiner på tur: emergency numbers by place, suggested links', async ({browser}) => {
      const places = [
        [null, '113', true], [{lat:59.91, lon:10.75}, '113', true],
        [{lat:48.14, lon:11.58}, '112', false], [{lat:40.71, lon:-74.0}, null, false]
      ];
      for (const [pos, num, norway] of places){
        const ctx = await browser.newContext({locale: L.locale, serviceWorkers: 'block', viewport: {width: 390, height: 780}});
        const p = await ctx.newPage();
        const err = watchErrors(p);
        await p.addInitScript(([key, pos]) => { try { localStorage.setItem(key, JSON.stringify(Object.assign({lists:[], hidePacked:false, introDone:true}, pos ? {pos} : {}))); } catch(e){} }, [KEY, pos]);
        await p.goto('./');
        await p.locator('#tabbar [data-tab="guide"]').click();
        await openRow(p, 'meds');
        await p.locator('#main details[data-sec="help"] summary').click();
        const nums = p.locator('#main details[data-sec="help"] .em-num');
        if (num) await expect(nums.first(), `first number at ${JSON.stringify(pos)}`).toHaveText(num);
        await expect(p.locator('#main details[data-sec="help"] a[href="tel:113"]')).toHaveCount(norway ? 1 : 0);
        await expect(p.locator('#main details[data-sec="help"] a[href="tel:112"]')).toHaveCount(num === '112' ? 1 : 0);
        // every web link in the guide offers «Legg til i Dine lenker»
        const rows = p.locator('#main .sug-row');
        await expect(rows).toHaveCount(await p.locator('#main a.wl').count());
        await p.waitForTimeout(200);
        expect(err, `no errors at ${JSON.stringify(pos)}`).toEqual([]);
        await ctx.close();
      }
    });

    // From build 43 (0.8.0): Dyrespor loads all ten drawings, and they are sized by real size.
    test('Dyrespor: drawings load at proportional sizes', async ({page}) => {
      await goTab(page, 'guide');
      await openRow(page, 'tracks');
      const secs = page.locator('#main details[data-sec]');
      const n = await secs.count();
      for (let i = 0; i < n; i++) await secs.nth(i).locator('summary').click();
      await expect(page.locator('#main .sb-fig.trk svg')).toHaveCount(10);
      const w = async k => (await page.locator(`#main [data-svgsrc="guides/track-${k}.svg"]`).boundingBox()).width;
      expect(await w('bear'), 'bear drawing wider than ptarmigan').toBeGreaterThan((await w('grouse')) * 2);
      await settle(page, errors);
    });

    // From build 44 (0.9.0): sorting in Rediger. Grip drag, long press, sub-items follow, Angre, keyboard, auto-scroll.
    test('Rediger: sorting rows', async ({browser}) => {
      const ctx = await browser.newContext({locale: L.locale, serviceWorkers: 'block', viewport: {width: 390, height: 780}, hasTouch: true});
      const p = await ctx.newPage();
      const err = watchErrors(p);
      const it = (id, sub) => Object.assign({id, text:id.toUpperCase(), done:false}, sub ? {sub:true} : {});
      const long = Array.from({length:30}, (_, k) => it('z' + k));
      const st = {introDone:true, lang:L.lang, hidePacked:false, lists:[{id:'L1', name:'Test', notes:'', modes:{}, cats:[
        {id:'k1', name:'K1', open:true, items:[it('a'), it('a1', 1), it('a2', 1), it('b'), it('c'), it('c1', 1)]},
        {id:'k2', name:'K2', open:true, items:long}]}]};
      await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
      await p.goto('./');
      await p.locator('#listBtn').click();
      await p.locator('#main [data-sel="L1"]').click();
      await p.locator('#main [data-la="edit"][data-id="L1"]').click();
      const order = c => p.locator(`#main [data-cat="${c}"] li.item .txt`).allTextContents();
      const box = sel => p.locator('#main ' + sel).first().boundingBox();
      // grip drag: A moves with its sub-items below B
      let g = await box('li.item[data-item="a"] .grip'), b = await box('li.item[data-item="b"]');
      await p.mouse.move(g.x + 20, g.y + 22); await p.mouse.down();
      await p.mouse.move(g.x + 20, g.y + 12, {steps: 2});
      await p.mouse.move(g.x + 20, b.y + b.height + 4, {steps: 12}); await p.waitForTimeout(150);
      await p.mouse.up();
      await expect.poll(() => order('k1')).toEqual(['B', 'A', 'A1', 'A2', 'C', 'C1']);
      await p.locator('#toast button').click();
      await expect.poll(() => order('k1')).toEqual(['A', 'A1', 'A2', 'B', 'C', 'C1']);
      // keyboard: arrow up on B's grip swaps it with the A block
      await p.locator('#main li.item[data-item="b"] .grip').focus(); await p.keyboard.press('ArrowUp');
      await expect.poll(() => order('k1')).toEqual(['B', 'A', 'A1', 'A2', 'C', 'C1']);
      // a sub-item dragged to the top never lands first
      g = await box('li.item[data-item="c1"] .grip'); const top = await box('[data-cat="k1"] li.item');
      await p.mouse.move(g.x + 20, g.y + 22); await p.mouse.down();
      await p.mouse.move(g.x + 20, g.y + 12, {steps: 2});
      await p.mouse.move(g.x + 20, top.y - 40, {steps: 12}); await p.waitForTimeout(150);
      await p.mouse.up();
      await expect.poll(() => order('k1')).toEqual(['B', 'C1', 'A', 'A1', 'A2', 'C']);
      // touch: a swipe scrolls and moves nothing; a long press lifts the row, moves it and does not tick it
      const cdp = await ctx.newCDPSession(p);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y}]});
      let r = await box('li.item[data-item="z2"] .txt');
      await touch('touchStart', r.x + 10, r.y + 10);
      for (let k = 1; k <= 8; k++){ await touch('touchMove', r.x + 10, r.y + 10 - k * 20); await p.waitForTimeout(16); }
      await touch('touchEnd'); await p.waitForTimeout(300);
      expect((await order('k2')).slice(0, 4)).toEqual(['Z0', 'Z1', 'Z2', 'Z3']);
      await p.waitForTimeout(700); await p.evaluate(() => document.querySelector('#main li.item[data-item="z1"]').scrollIntoView({block:'center'})); await p.waitForTimeout(200);
      r = await box('li.item[data-item="z1"] .txt');
      await touch('touchStart', r.x + 10, r.y + 10); await p.waitForTimeout(550);
      for (let k = 1; k <= 12; k++){ await touch('touchMove', r.x + 10, r.y + 10 + k * 14); await p.waitForTimeout(16); }
      await touch('touchEnd');
      await expect.poll(async () => (await order('k2')).indexOf('Z1')).toBeGreaterThan(2);
      await expect(p.locator('#main li.item.done')).toHaveCount(0);
      // auto-scroll: holding a row near the tab bar scrolls the page
      await p.waitForTimeout(500);
      g = await box('li.item[data-item="z5"] .grip');
      const y0 = await p.evaluate(() => scrollY);
      await p.mouse.move(g.x + 20, g.y + 22); await p.mouse.down();
      await p.mouse.move(g.x + 20, g.y + 12, {steps: 2});
      await p.mouse.move(g.x + 20, 700, {steps: 10}); await p.waitForTimeout(1200);
      expect(await p.evaluate(() => scrollY)).toBeGreaterThan(y0 + 200);
      await p.mouse.up(); await p.waitForTimeout(300);
      expect(err, 'no errors while sorting').toEqual([]);
      await ctx.close();
    });

    // From build 45 (0.9.1): Møte med dyr, reached from the tick lines in the list, with the emergency number in Hoggorm.
    test('Møte med dyr: list links and emergency number', async ({page}) => {
      await page.locator('#main [data-act="foldAll"]').click(); // from build 48 the list starts folded
      await page.locator('#main [data-bag="std:firstaid"]').click();
      await page.locator('#main li.item[data-item="std:firstaid:pinsett (flått, fliser)"] [data-act="openGuide"]').click();
      await expect(page.locator('#main details[data-sec="ticks"]')).toHaveAttribute('open', '');
      await page.locator('#main details[data-sec="adder"] summary').click();
      await expect(page.locator('#main details[data-sec="adder"]')).toContainText('113');
      await expect(page.locator('#main details[data-sec="bear"]')).toHaveCount(1);
      await settle(page, errors);
    });

    // From build 47 (0.9.3): notes keep your order, move by long press (not pinned ones), and get a colour with a name.
    test('Notater: move by long press, colour and colour names', async ({browser}) => {
      const ctx = await browser.newContext({locale: L.locale, serviceWorkers: 'block', viewport: {width: 390, height: 780}, hasTouch: true});
      const p = await ctx.newPage();
      const err = watchErrors(p);
      const n = (id, t, extra) => Object.assign({id, title:id.toUpperCase(), text:'text ' + id, t}, extra || {});
      const st = {introDone:true, lang:L.lang, lists:[], noteOrder:1, notes:[n('p', 1, {pin:true}), n('a', 4), n('b', 3), n('c', 2), n('d', 1)]};
      await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
      await p.goto('./');
      await p.locator('#tabbar [data-tab="notes"]').click();
      const order = async () => (await p.locator('#main .notes-ix .ix-t').allTextContents()).map(x => x.trim());
      await expect.poll(order).toEqual(['P', 'A', 'B', 'C', 'D']);
      const cdp = await ctx.newCDPSession(p);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y}]});
      // long press A and drag it below C
      let r = await p.locator('#main .notes-ix button[data-id="a"]').boundingBox();
      const c = await p.locator('#main .notes-ix button[data-id="c"]').boundingBox();
      await touch('touchStart', r.x + 30, r.y + 20); await p.waitForTimeout(550);
      const steps = 12, dy = (c.y + c.height - 10) - (r.y + 20);
      for (let k = 1; k <= steps; k++){ await touch('touchMove', r.x + 30, r.y + 20 + dy * k / steps); await p.waitForTimeout(16); }
      await touch('touchEnd');
      await expect.poll(order).toEqual(['P', 'B', 'C', 'A', 'D']);
      await expect(p.locator('#main .note-full')).toHaveCount(0);
      // the pinned note does not lift
      r = await p.locator('#main .notes-ix button[data-id="p"]').boundingBox();
      await touch('touchStart', r.x + 30, r.y + 20); await p.waitForTimeout(550);
      for (let k = 1; k <= 8; k++){ await touch('touchMove', r.x + 30, r.y + 20 + k * 20); await p.waitForTimeout(16); }
      await touch('touchEnd'); await p.waitForTimeout(400);
      expect((await order())[0]).toBe('P');
      // colour: open B, edit, pick colour 2, name it, save; editing does not move it
      await p.waitForTimeout(500);
      await p.locator('#main .notes-ix button[data-id="b"]').click();
      await p.locator('#main [data-act="editNote"]').first().click();
      await p.locator('#main .nc-dot.nc-2').click();
      await p.locator('#main [data-act="noteCNames"]').click();
      await p.locator('#overlay [data-nc="2"]').fill('Fiske');
      await p.locator('#overlay [data-s="ok"]').click();
      await p.locator('#neText').fill('changed');
      await p.locator('#main [data-act="noteSave"]').click();
      await expect(p.locator('#main .note-full.has-nc.nc-2')).toHaveCount(1);
      await expect(p.locator('#main .note-full .nc-name')).toHaveText('Fiske');
      await p.locator('#main [data-act="back"]').click();
      await expect.poll(order).toEqual(['P', 'B', 'C', 'A', 'D']);
      await expect(p.locator('#main .notes-ix button[data-id="b"].has-nc.nc-2 .nc-name')).toHaveText('Fiske');
      await p.waitForTimeout(200);
      expect(err, 'no errors in notes').toEqual([]);
      await ctx.close();
    });

    // From build 48 (0.10.0): the start state. A fresh start opens Pakkliste folded; a reload (the update reload, or the app
    // coming back) keeps the page; Utemodus shows the list as one row and no Turtype; Start på nytt also resets Lett dagstur and Nattlys.
    test('start state: fresh start, reload, Utemodus page and Start på nytt', async ({browser}) => {
      const ctx = await browser.newContext({locale: L.locale, serviceWorkers: 'block', viewport: {width: 390, height: 780}});
      const p = await ctx.newPage();
      const err = watchErrors(p);
      const st = {lists:[], hidePacked:false, introDone:true, lastNav:{tab:'guide', view:null},
        std:{done:{}, modes:{}, light:{'std:firstaid':true}, open:{'std:start':true}}, v:2, night:true, nightHue:'red'};
      await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
      await p.goto('./');
      // fresh start: Pakkliste, every category folded, even though the last page was Guider
      await expect(p.locator('#tabbar [data-tab="list"]')).toHaveAttribute('aria-current', 'page');
      await expect(p.locator('#main section.cat').first()).toBeVisible();
      await expect(p.locator('#main section.cat:not(.closed)')).toHaveCount(0);
      // a reload keeps the page and the folds
      await p.locator('#main section.cat .cat-head').first().click();
      await expect(p.locator('#main section.cat:not(.closed)')).toHaveCount(1);
      await p.locator('#tabbar [data-tab="compass"]').click();
      await p.reload();
      await expect(p.locator('#tabbar [data-tab="compass"]')).toHaveAttribute('aria-current', 'page');
      await p.locator('#tabbar [data-tab="list"]').click();
      await expect(p.locator('#main section.cat:not(.closed)')).toHaveCount(1);
      // Utemodus: one list row, folded; no Turtype; opening it shows the tools and the folded categories
      await p.locator('#main [data-act="fieldToggle"]').click();
      const row = p.locator('#main [data-act="fieldList"]');
      await expect(row).toHaveAttribute('aria-expanded', 'false');
      await expect(p.locator('#main section.cat')).toHaveCount(0);
      await expect(p.locator('#main [data-act="modesToggle"]')).toHaveCount(0);
      await row.click();
      await expect(row).toHaveAttribute('aria-expanded', 'true');
      await expect(p.locator('#main section.cat').first()).toBeVisible();
      await expect(p.locator('#main [data-act="foldAll"]')).toBeVisible();
      await expect(p.locator('#main [data-act="modesToggle"]')).toHaveCount(0);
      // a new window is a fresh start: Utemodus stays on, the list row and categories are folded again
      // (the app went to the background more than 15 minutes ago, so it is not a return; from build 49)
      const p2 = await ctx.newPage();
      const err2 = watchErrors(p2);
      await p2.addInitScript(k => { try { const s = JSON.parse(localStorage.getItem(k)); s.hiddenAt = Date.now() - 16 * 60000; localStorage.setItem(k, JSON.stringify(s)); } catch(e){} }, KEY);
      await p2.goto('./');
      await expect(p2.locator('#main [data-act="fieldList"]')).toHaveAttribute('aria-expanded', 'false');
      await p2.locator('#main [data-act="fieldList"]').click();
      await expect(p2.locator('#main section.cat:not(.closed)')).toHaveCount(0);
      // Start på nytt (Utemodus off): Lett dagstur and Nattlys are reset, every category folded
      await p2.locator('#main [data-act="fieldToggle"]').click();
      await p2.locator('#hdrSet').click();
      await p2.locator('#main [data-la="startOver"]').click();
      await p2.locator('#panel [data-s="ok"]').click();
      await expect(p2.locator('#main section.cat').first()).toBeVisible();
      await expect(p2.locator('#main section.cat:not(.closed)')).toHaveCount(0);
      const saved = await p2.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
      expect(saved.std.light, 'Lett dagstur reset').toEqual({});
      expect(saved.night, 'Nattlys off').toBe(false);
      await p2.waitForTimeout(200);
      expect(err.concat(err2), 'no errors in the start state test').toEqual([]);
      await ctx.close();
    });

    // From build 49 (0.10.1): Android may close the app in the background, which clears the session marker. Within
    // 15 minutes of going to the background the app returns to the page you were on; after that it is a fresh start.
    test('start state: return within 15 minutes', async ({browser}) => {
      for (const [ago, back] of [[5, true], [16, false]]){
        const ctx = await browser.newContext({locale: L.locale, serviceWorkers: 'block', viewport: {width: 390, height: 780}});
        const p = await ctx.newPage();
        const err = watchErrors(p);
        const st = {lists:[], hidePacked:false, introDone:true, lastNav:{tab:'guide', view:null}, hiddenAt: Date.now() - ago * 60000};
        await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
        await p.goto('./');
        await expect(p.locator(`#tabbar [data-tab="${back ? 'guide' : 'list'}"]`), `${ago} minutes`).toHaveAttribute('aria-current', 'page');
        await p.waitForTimeout(200);
        expect(err, `no errors after ${ago} minutes`).toEqual([]);
        await ctx.close();
      }
    });

    // From build 48 (0.10.0): Om rådene uses the same place rules as every other emergency number.
    test('Om rådene: emergency line by place', async ({browser}) => {
      const places = [[null, ['113', '112']], [{lat:59.91, lon:10.75}, ['113', '112']], [{lat:48.14, lon:11.58}, ['112']], [{lat:40.71, lon:-74.0}, []]];
      for (const [pos, nums] of places){
        const ctx = await browser.newContext({locale: L.locale, serviceWorkers: 'block', viewport: {width: 390, height: 780}});
        const p = await ctx.newPage();
        const err = watchErrors(p);
        await p.addInitScript(([key, pos]) => { try { localStorage.setItem(key, JSON.stringify(Object.assign({lists:[], hidePacked:false, introDone:true}, pos ? {pos} : {}))); } catch(e){} }, [KEY, pos]);
        await p.goto('./');
        await p.locator('#hdrSet').click();
        await expect(p.locator('#main .em-call b'), `numbers at ${JSON.stringify(pos)}`).toHaveText(nums);
        await p.locator('#main [data-act="openGuide"][data-guide="meds"][data-sec="help"]').click();
        await expect(p.locator('#main details[data-sec="help"]')).toHaveAttribute('open', '');
        await p.waitForTimeout(200);
        expect(err, `no errors at ${JSON.stringify(pos)}`).toEqual([]);
        await ctx.close();
      }
    });

    test('tapping the current tab scrolls to the top', async ({page}) => {
      const all = page.locator('#main [data-act="foldAll"]');
      if (await all.getAttribute('aria-expanded') !== 'true') await all.click();
      for (const k of ['list', 'guide']){
        await goTab(page, k);
        // 0.15.1: with every group folded Guider fits on one screen, so open them to get a page that scrolls
        if (k === 'guide') for (const g of await page.locator('#main [data-gfold]').evaluateAll(els => els.map(e => e.dataset.gfold))){
          const h = page.locator(`#main [data-gfold="${g}"]`);
          if (await h.getAttribute('aria-expanded') !== 'true') await h.click();
        }
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(() => page.evaluate(() => window.scrollY), `${k} page is long enough to scroll`).toBeGreaterThan(100);
        await page.locator(`#tabbar [data-tab="${k}"]`).click();
        await expect.poll(() => page.evaluate(() => window.scrollY), `${k} scrolls to the top`).toBe(0);
      }
      await settle(page, errors);
    });
  });
}

/* ---------- From build 46 (0.9.2): Nattlys stays pure red or pure green ----------
   Every skin, in light and dark mode, with red and green light: every visible colour on the main pages must be grey/black
   or a shade of the night light. Catches skins, dark-mode rules or new colours that override Nattlys. */
const SKINS = (HTML.match(/data-skin="([a-z]+)"/g) || []).map(m => m.slice(11, -1)).filter((v, i, a) => a.indexOf(v) === i);
test.describe('nattlys', () => {
  // Build 84: one test per skin, so they run in parallel (all skins in one test took about 90 s)
  test('the skins are found in index.html', () => { expect(SKINS.length, 'skins found in index.html').toBeGreaterThan(3); });
  for (const skin of SKINS) test(`every colour follows the night light: ${skin}, light and dark mode`, async ({browser}) => {
    const audit = hue => {
      const bad = [];
      const parse = s => { const m = s && s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return {r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1}; };
      const ok = c => { if (!c || c.a === 0) return true; const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
        if (mx - mn < 18) return true;
        return hue === 'red' ? (c.r >= c.g && c.r >= c.b && Math.abs(c.g - c.b) < 60) : (c.g >= c.r && c.g >= c.b); };
      document.querySelectorAll('#main *, header *, #tabbar *').forEach(el => {
        const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return;
        for (const p of ['color', 'backgroundColor', 'borderLeftColor', 'borderTopColor', 'fill', 'stroke']){
          if (p.indexOf('border') === 0 && parseFloat(cs[p.replace('Color', 'Width')]) === 0) continue;
          if (!ok(parse(cs[p]))){ const k = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className; bad.push(`${p} ${cs[p]} ${String(k || el.tagName).slice(0, 40)}`); }
        }
      });
      return [...new Set(bad)].slice(0, 8);
    };
    const notes = [{id:'a', title:'A', text:'x', t:1760000000000, rcv:{n:'Kari', t:1760000000000}, c:2}, {id:'b', title:'B', text:'y', t:1750000000000, pin:true, c:4},
      {id:'c', title:'C', text:'z', t:1740000000000, c:1}, {id:'d', title:'D', text:'w', t:1730000000000, c:3}, {id:'e', title:'E', text:'v', t:1720000000000, c:5},
      {id:'f', title:'', text:'', t:1710000000000, priv:1, iv:'AAAAAAAAAAAAAAAA', ct:'AAAAAAAAAAAAAAAAAAAAAAAA'}];   // build 70: a locked private note
    for (const scheme of ['light', 'dark']) for (const hue of ['red', 'green']){
      const ctx = await browser.newContext({colorScheme: scheme, serviceWorkers: 'block', viewport: {width: 390, height: 780}, locale: 'nb-NO'});
      const p = await ctx.newPage();
      const st = {lists:[], introDone:true, lang:'no', skin, field:true, night:true, nightHue:hue, notes, noteOrder:1, noteColors:['Fiske', 'Turer', '', 'Ideer', ''], pos:{lat:58.97, lon:5.73, t:1760000000000}};
      await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
      await p.goto('./');
      const found = {};
      const check = async name => { const r = await p.evaluate(audit, hue); if (r.length) found[name] = r; };
      // 0.10.0: in Utemodus the list is one row; open it and every category before checking
      await p.locator('#main [data-act="fieldList"]').click();
      await p.locator('#main [data-act="foldAll"]').click();
      await check('list');
      await p.locator('#tabbar [data-tab="notes"]').click(); await check('notes');
      await p.locator('#main [data-act="openNote"][data-id="a"]').click(); await check('note');
      await p.locator('#tabbar [data-tab="guide"]').click();
      // 0.15.0: both the folded headings and the open groups
      await check('guides folded');
      for (const h of await p.locator('#main [data-gfold]').all()) await h.click();
      await check('guides');
      for (const g of ['mapcompass', 'meds', 'animals']){
        await p.locator('#tabbar [data-tab="guide"]').click();
        if (!(await p.locator(`#main [data-open="${g}"]`).count())) continue;
        await openRow(p, g);
        const sums = p.locator('#main details summary');
        for (let i = 0; i < await sums.count(); i++) await sums.nth(i).click();
        await check(g);
      }
      await p.locator('#tabbar [data-tab="plan"]').click(); await check('plan');
      // 0.16.0: Kompass and Stjerner og planeter (stars, planets and the moon on the ring)
      await p.locator('#tabbar [data-tab="compass"]').click(); await check('compass');
      await p.locator('#main [data-act="cStars"]').click(); await check('stars');
      // the list heading in Utemodus (the Dine lister row until build 82)
      await p.locator('#tabbar [data-tab="list"]').click(); await p.locator('#tabbar [data-tab="list"]').click(); await check('list rows');
      expect(found, `${skin}, ${scheme} mode, ${hue} light`).toEqual({});
      await ctx.close();
    }
  });
});

/* ---------- From build 50 (0.11.0): Nødmodus ----------
   Opened by holding a Nødmodus button 1 s (also in Regnlås); numbers by place; position and SMS; lights; guide links lead back;
   Avslutt and Back close it; a reload while it is open opens it again. */
test.describe('nødmodus', () => {
  const ctxFor = (browser, extra) => browser.newContext(Object.assign({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}}, extra || {}));
  const start = async (p, st) => {
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
    await p.goto('./');
  };
  const slideOff = async p => {
    const k = await p.locator('#slKnob').boundingBox(), tr = await p.locator('#slTrack').boundingBox();
    await p.mouse.move(k.x + k.width / 2, k.y + k.height / 2); await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(k.x + k.width / 2 + (tr.width - k.width) * i / 10, k.y + k.height / 2);
    await p.mouse.up();
    await expect(p.locator('#slight')).toBeHidden();
  };
  const hold = async (p, sel, ms) => {
    const b = await p.locator(sel).first().boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down(); await p.waitForTimeout(ms); await p.mouse.up();
  };

  test('buttons, hold to open, numbers, exit, Back and reopening', async ({browser}) => {
    const ctx = await ctxFor(browser);
    const p = await ctx.newPage();
    const err = watchErrors(p);
    await start(p, {lists:[], hidePacked:false, introDone:true, lang:'no'});
    // Pakkliste: no button outside Utemodus; Guider: always; Nødsituasjon: at the top
    await expect(p.locator('#main [data-sos-hold]')).toHaveCount(0);
    await p.locator('#tabbar [data-tab="guide"]').click();
    await expect(p.locator('#main [data-sos-hold]')).toHaveCount(1);
    await openRow(p, 'emergency');
    await expect(p.locator('#main [data-sos-hold]')).toHaveCount(1);
    // a short tap does not open it
    await hold(p, '#main [data-sos-hold]', 150);
    await expect(p.locator('#sos')).toBeHidden();
    // holding 1 s opens it; no position = Norway: 113, 112, 110
    await hold(p, '#main [data-sos-hold]', 1200);
    await expect(p.locator('#sos')).toBeVisible();
    await expect(p.locator('#sos a.sos-call')).toHaveText([/113/, /112/, /110/]);
    // a guide link opens the guide, and its back button leads back to Nødmodus
    await p.locator('#sos [data-sg="kantgrop"]').click();
    await expect(p.locator('#sos')).toBeHidden();
    await expect(p.locator('#main [data-act="sosReturn"]')).toHaveCount(1);
    await p.locator('#main [data-act="sosReturn"]').click();
    await expect(p.locator('#sos')).toBeVisible();
    // from build 51: the phone's Back from such a guide also returns to Nødmodus
    await p.locator('#sos [data-sg="emergency"]').first().click();
    await expect(p.locator('#sos')).toBeHidden();
    await p.goBack();
    await expect(p.locator('#sos')).toBeVisible();
    // a reload while it is open opens it again
    await p.reload();
    await expect(p.locator('#sos')).toBeVisible();
    // Avslutt closes it; Back closes it too
    await p.locator('#sos [data-sa="exit"]').click();
    await expect(p.locator('#sos')).toBeHidden();
    await p.locator('#tabbar [data-tab="guide"]').click();
    await hold(p, '#main [data-sos-hold]', 1200);
    await expect(p.locator('#sos')).toBeVisible();
    await p.goBack();
    await expect(p.locator('#sos')).toBeHidden();
    const saved = await p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
    expect(saved.sosOpen, 'closed is saved').toBe(false);
    await p.waitForTimeout(200);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('Utemodus and Regnlås, position, SMS, lights and night colours', async ({browser}) => {
    const ctx = await ctxFor(browser);
    const p = await ctx.newPage();
    const err = watchErrors(p);
    await start(p, {lists:[], hidePacked:false, introDone:true, lang:'no', field:true, rainLocked:true, night:true, nightHue:'green',
      pos:{lat:59.91, lon:10.75, t:Date.now(), acc:12}});
    // the button sits right under the Utemodus button (from build 80; Utemodus keeps its place) and works in Regnlås
    const order = await p.locator('#main > .sos-btn, #main > .field-btn').evaluateAll(els => els.map(e => e.className.split(' ')[0]));
    expect(order.slice(0, 2)).toEqual(['field-btn', 'sos-btn']);
    await hold(p, '#main [data-sos-hold]', 1200);
    await expect(p.locator('#sos')).toBeVisible();
    await expect(p.locator('#sos')).toHaveClass(/h-green/);
    await expect(p.locator('#sos .sos-pos')).toContainText('59.91000° N, 10.75000° Ø');
    await expect(p.locator('#sos .sos-pos + .s-mut')).toContainText('±12 m');
    const href = await p.locator('#sos a[href^="sms:"]').getAttribute('href');
    expect(decodeURIComponent(href)).toContain('59.91000° N, 10.75000° Ø');
    // switch to red, and back to normal (from build 52: Vanlig, Rødt, Grønt)
    await p.locator('#sos [data-sa="hue"][data-h="red"]').click();
    await expect(p.locator('#sos')).toHaveClass(/h-red/);
    await p.locator('#sos [data-sa="hue"][data-h=""]').click();
    await expect(p.locator('#sos')).not.toHaveClass(/h-(red|green)/);
    await expect(p.locator('#sos [data-sa="hue"][data-h=""]')).toHaveAttribute('aria-pressed', 'true');
    await p.locator('#sos [data-sa="hue"][data-h="red"]').click();
    await expect(p.locator('#sos')).toHaveClass(/h-red/);
    // white screen light, then SOS flashes white and black
    await p.locator('#sos [data-sa="white"]').click();
    await expect(p.locator('#slight')).toBeVisible();
    expect(await p.locator('#slight').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    await slideOff(p);
    await p.locator('#sos [data-sa="sosl"]').click();
    const seen = new Set();
    for (let i = 0; i < 12; i++){ seen.add(await p.locator('#slight').evaluate(el => getComputedStyle(el).backgroundColor)); await p.waitForTimeout(150); }
    expect([...seen].sort()).toEqual(['rgb(0, 0, 0)', 'rgb(255, 255, 255)']);
    await p.mouse.click(10, 10); // the slide track shows again on a touch
    await slideOff(p);
    await expect(p.locator('#sos')).toBeVisible();
    // from build 51: 6 a minute starts with a white flash and is dark after it
    await p.locator('#sos [data-sa="six"]').click();
    expect(await p.locator('#slight').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');
    await p.waitForTimeout(1300);
    expect(await p.locator('#slight').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
    await p.mouse.click(10, 10);
    await slideOff(p);

    await p.waitForTimeout(200);
    expect(err).toEqual([]);
    await ctx.close();
  });

  // From build 51: the Notater overview has no Utemodus line (each note still says it)
  test('Notater overview in Utemodus has no Utemodus line', async ({browser}) => {
    const ctx = await ctxFor(browser);
    const p = await ctx.newPage();
    const err = watchErrors(p);
    await start(p, {lists:[], hidePacked:false, introDone:true, lang:'no', field:true, noteOrder:1, notes:[{id:'a', title:'A', text:'x', t:1}]});
    await p.locator('#tabbar [data-tab="notes"]').click();
    await expect(p.locator('#main')).not.toContainText('Utemodus er på');
    await p.locator('#main [data-act="openNote"][data-id="a"]').click();
    await expect(p.locator('#main')).toContainText('Utemodus er på');
    await p.waitForTimeout(200);
    expect(err).toEqual([]);
    await ctx.close();
  });

  // From build 53 (0.11.3): Nødmodus fetches a fresh position when it opens, and says plainly how fresh it is
  test('fresh position on open, old position marked, time in the SMS', async ({browser}) => {
    // with location allowed: an old saved position is replaced straight away
    let ctx = await ctxFor(browser, {permissions:['geolocation'], geolocation:{latitude:60.39, longitude:5.32, accuracy:9}});
    let p = await ctx.newPage();
    let err = watchErrors(p);
    await start(p, {lists:[], hidePacked:false, introDone:true, lang:'no', pos:{lat:59.91, lon:10.75, t:Date.now() - 3 * 3600000, acc:12}});
    await p.locator('#tabbar [data-tab="guide"]').click();
    await hold(p, '#main [data-sos-hold]', 1200);
    await expect(p.locator('#sos .sos-pos')).toContainText('60.39000° N, 5.32000° Ø');
    await expect(p.locator('#sos .sos-st.sos-ok')).toContainText('Posisjon funnet');
    await expect(p.locator('#sos .sos-warn')).toHaveCount(0);
    const href = await p.locator('#sos a[href^="sms:"]').getAttribute('href');
    expect(decodeURIComponent(href)).toContain('60.39000° N, 5.32000° Ø');
    expect(decodeURIComponent(href)).toContain('målt');
    const saved = await p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
    expect(saved.pos.lat, 'the fresh position is kept after Nødmodus').toBeCloseTo(60.39, 5);
    await p.locator('#sos [data-sa="exit"]').click();
    const kept = await p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
    expect(kept.pos.lat).toBeCloseTo(60.39, 5);
    await p.waitForTimeout(200);
    expect(err).toEqual([]);
    await ctx.close();
    // without location: the old position stays, clearly marked old, and the error is shown
    ctx = await ctxFor(browser);
    p = await ctx.newPage();
    err = watchErrors(p);
    await start(p, {lists:[], hidePacked:false, introDone:true, lang:'no', pos:{lat:59.91, lon:10.75, t:Date.now() - 3 * 3600000, acc:12}});
    await p.locator('#tabbar [data-tab="guide"]').click();
    await hold(p, '#main [data-sos-hold]', 1200);
    await expect(p.locator('#sos .sos-pos')).toContainText('59.91000° N, 10.75000° Ø');
    await expect(p.locator('#sos .sos-warn').filter({hasText:'Gammel posisjon'})).toContainText('3 t');
    await expect(p.locator('#sos .sos-st.sos-ok')).toHaveCount(0);
    await p.waitForTimeout(200);
    expect(err).toEqual([]);
    await ctx.close();
    // poor accuracy is flagged
    ctx = await ctxFor(browser, {permissions:['geolocation'], geolocation:{latitude:60.39, longitude:5.32, accuracy:850}});
    p = await ctx.newPage();
    err = watchErrors(p);
    await start(p, {lists:[], hidePacked:false, introDone:true, lang:'en'});
    await p.locator('#tabbar [data-tab="guide"]').click();
    await hold(p, '#main [data-sos-hold]', 1200);
    await expect(p.locator('#sos .sos-warn')).toContainText('Uncertain position (±850 m)');
    await p.waitForTimeout(200);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('numbers follow the place', async ({browser}) => {
    for (const [pos, nums] of [[{lat:48.14, lon:11.58, t:1}, [/112/]], [{lat:40.71, lon:-74.0, t:1}, []]]){
      const ctx = await ctxFor(browser);
      const p = await ctx.newPage();
      const err = watchErrors(p);
      await start(p, {lists:[], hidePacked:false, introDone:true, lang:'no', pos});
      await p.locator('#tabbar [data-tab="guide"]').click();
      await hold(p, '#main [data-sos-hold]', 1200);
      await expect(p.locator('#sos a.sos-call'), JSON.stringify(pos)).toHaveText(nums);
      await p.waitForTimeout(200);
      expect(err).toEqual([]);
      await ctx.close();
    }
  });
});

/* ---------- From build 55 (0.12.0): Bål ----------
   Holding Bål in Utemodus lights the fire on a canvas with the wood hint; holding the screen adds wood without errors;
   every guest can be drawn; sliding the handle puts the fire out and hides the canvas. */
test.describe('bål', () => {
  test('light, add wood, guests, put out', async ({browser}) => {
    const ctx = await browser.newContext({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
    const p = await ctx.newPage();
    const err = watchErrors(p);
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, {lists:[], hidePacked:false, introDone:true, lang:'no', field:true}]);
    await p.goto('./');
    const hold = async (sel, ms) => {
      const b = await p.locator(sel).first().boundingBox();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await p.mouse.down(); await p.waitForTimeout(ms); await p.mouse.up();
    };
    await hold('#main .lt-btn[data-light="fire"]', 1200);
    await expect(p.locator('#slight')).toBeVisible();
    await expect(p.locator('#slight')).toHaveClass(/fire/);
    await expect(p.locator('#slFireCv')).toBeVisible();
    await expect(p.locator('#slNote')).toContainText('legge på ved');
    await p.waitForTimeout(600);
    // the fire is drawn: the middle of the bottom of the canvas is bright
    const px = await p.locator('#slFireCv').evaluate(c => Array.from(c.getContext('2d').getImageData(c.width / 2, c.height - 20, 1, 1).data));
    expect(px[0]).toBeGreaterThan(150);
    // adding wood: hold one spot on the fire for 1.6 s
    await p.mouse.move(195, 300); await p.mouse.down(); await p.waitForTimeout(1600); await p.mouse.up();
    await p.waitForTimeout(300);
    // the slide track is shown again, then the handle puts the fire out
    await p.mouse.click(195, 300);
    const k = await p.locator('#slKnob').boundingBox(), tr = await p.locator('#slTrack').boundingBox();
    await p.mouse.move(k.x + k.width / 2, k.y + k.height / 2); await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(k.x + k.width / 2 + (tr.width - k.width) * i / 10, k.y + k.height / 2);
    await p.mouse.up();
    await expect(p.locator('#slight')).toBeHidden();
    await expect(p.locator('#slFireCv')).toBeHidden();
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- From build 79 (0.21.0): Bål guests in the firelight ----------
   Every guest is brought in turn with Fire.show(kind) (reached through window.__vardeTest, set only by the test) and drawn through its visit with the firelight on, on the
   fire's canvas, with the page clock run forward; any script error fails it. Then Fire.show() goes back to chance. */
test.describe('bål gjester', () => {
  // Build 84: one test per guest, so they run in parallel (all eight in one test took about 90 s)
  const openFire = async browser => {
    const ctx = await browser.newContext({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
    const p = await ctx.newPage();
    const err = watchErrors(p);
    await p.addInitScript(([key, s]) => { window.__vardeTest = {}; try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, {lists:[], hidePacked:false, introDone:true, lang:'no', field:true}]);
    await p.clock.install();
    await p.goto('./');
    const b = await p.locator('#main .lt-btn[data-light="fire"]').boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(1200); await p.mouse.up();
    await expect(p.locator('#slFireCv')).toBeVisible();
    return {ctx, p, err};
  };
  const pic = p => p.locator('#slFireCv').evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0; return h; });
  for (const [kind, dur] of [['troll', 15], ['nisse', 13], ['couple', 16], ['owl', 14], ['fox', 12], ['bat', 4.5], ['reindeer', 14], ['ghosts', 22]]){
    test(`the guest «${kind}» is drawn with the firelight`, async ({browser}) => {
      const {ctx, p, err} = await openFire(browser);
      await p.evaluate(k => window.__vardeTest.Fire.show(k), kind);
      await p.clock.runFor(1000);
      expect(await p.evaluate(() => window.__vardeTest.Fire.guest), kind).toBe(kind);
      for (let k = 0; k < 4; k++){ const a = await pic(p); await p.clock.runFor(dur * 250); expect(await pic(p), kind).not.toBe(a); }
      expect(err).toEqual([]);
      await ctx.close();
    });
  }
  test('after a chosen guest, the guests go back to chance', async ({browser}) => {
    const {ctx, p, err} = await openFire(browser);
    await p.evaluate(() => window.__vardeTest.Fire.show('fox'));
    await p.clock.runFor(4000);
    await p.evaluate(() => window.__vardeTest.Fire.show());
    await p.clock.runFor(30000);
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- From build 80 (0.22.0): Innstillinger og Om Varde, the Utemodus page and header, Bål visitors ----------
   The gear (only with Utemodus off) opens Innstillinger on any tab, Back returns; Dine lister keeps only the lists, the
   backup and a link row; Om Varde has the photo line and the version. In Utemodus the header says «Pakkliste», Regnlås is
   48 px and the sign sits at the right end; Utemodus keeps its place and size, Nødmodus comes under it in the same size,
   then the lights, Dine lister (with the list name) and Pakkliste. A tap grows Nødmodus over Utemodus for about 3 s
   without opening it; a hold on it opens. Besøk Av gives no guest, Ofte one within 3 minutes. */
test.describe('innstillinger 0.22', () => {
  const ctxFor = (browser, extra) => browser.newContext(Object.assign({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}}, extra || {}));
  const start = async (p, st, test) => {
    await p.addInitScript(([key, s, tst]) => { if (tst) window.__vardeTest = {}; try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st, !!test]);
    await p.goto('./');
  };
  const LONG = 'Fjelltur med telt og hund i Jotunheimen';
  const own = {id:'L1', name:LONG, notes:'', modes:{}, cats:[{id:'k1', name:'K1', open:true, items:[{id:'a', text:'A', done:false}]}]};

  test('the gear, the page and Dine lister', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, {lists:[], introDone:true, lang:'no'});
    await expect(p.locator('#hdrSet')).toBeVisible();
    await expect(p.locator('#hdrSet')).toHaveAccessibleName('Innstillinger og om Varde');
    // from Guider: the page opens on that tab and Back returns
    await p.locator('#tabbar [data-tab="guide"]').click();
    await p.locator('#hdrSet').click();
    await expect(p.locator('#listName')).toHaveText('Innstillinger');
    await expect(p.locator('#hdrSet')).toHaveAttribute('aria-current', 'page');
    await expect(p.locator('#tabbar [data-tab="guide"]')).toHaveAttribute('aria-current', /page|true/);
    const labels = (await p.locator('#main .sec-lbl').allTextContents()).map(x => x.trim());
    expect(labels).toEqual(['Utseende', 'Språk', 'Regnlås', 'Bål', 'Start på nytt', 'Hjelp', 'Personvern', 'Om rådene', 'Bildene']);
    await expect(p.locator('#main .part-lbl')).toHaveText('Om Varde');
    await expect(p.locator('#main .app-ver')).toContainText('bygg');
    await expect(p.locator('#main')).toContainText('Bildene i appen er ekte foto');
    await expect(p.locator('#main [data-act="fireGuests"][aria-pressed="true"]')).toHaveText('Av og til');
    await p.locator('#main [data-act="back"]').click();
    await expect(p.locator('#listName')).toHaveText('Guider');
    // Dine lister: the lists and the backup, no settings; from build 82 in sections, and no row to Innstillinger (the gear is it)
    await p.locator('#tabbar [data-tab="list"]').click();
    await p.locator('#listBtn').click();
    expect((await p.locator('#main .sec-lbl').allTextContents()).map(x => x.trim())).toEqual(['Hovedliste', 'Dine egne lister', 'Delte lister', 'Sikkerhetskopi']);
    await expect(p.locator('#main .app-ver')).toHaveCount(0);
    await expect(p.locator('#main [data-la="backup"]')).toBeVisible();
    await expect(p.locator('#main [data-act="openSettings"]')).toHaveCount(0);
    await p.locator('#hdrSet').click();
    await expect(p.locator('#listName')).toHaveText('Innstillinger');
    // Besøk is a setting: stored, and kept by Start på nytt
    await p.locator('#main [data-act="fireGuests"][data-v="often"]').click();
    await expect(p.locator('#main [data-act="fireGuests"][data-v="often"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await p.evaluate(k => JSON.parse(localStorage.getItem(k)).fireGuests, KEY)).toBe('often');
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('Utemodus: header, order and sizes; no gear', async ({browser}) => {
    let ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    // the Utemodus button keeps its place and size (with a one-line list name; a long name may wrap the header with Utemodus off)
    await start(p, {lists:[], introDone:true, lang:'no'});
    const fieldOff = await p.locator('#main .field-btn').boundingBox();
    await p.locator('#main [data-act="fieldToggle"]').click();
    let fieldOn = await p.locator('#main .field-btn').boundingBox();
    expect(Math.abs(fieldOn.y - fieldOff.y)).toBeLessThan(1);
    expect(Math.abs(fieldOn.height - fieldOff.height)).toBeLessThan(1);
    await p.locator('#main [data-act="fieldToggle"]').click();
    // a long list name: the header says Pakkliste in Utemodus, the name is in the Dine lister row
    expect(err).toEqual([]);
    await ctx.close();
    ctx = await ctxFor(browser); p = await ctx.newPage(); err = watchErrors(p);
    await start(p, {v:2, std:{done:{}, modes:{}, light:{}, open:{}}, lists:[own], main:'L1', introDone:true, lang:'no'});
    await expect(p.locator('#listName')).toHaveText(LONG);
    await p.locator('#main [data-act="fieldToggle"]').click();
    fieldOn = await p.locator('#main .field-btn').boundingBox();
    await expect(p.locator('#hdrSet')).toBeHidden();
    await expect(p.locator('#listName')).toHaveText('Pakkliste');
    const order = await p.locator('#main > *').evaluateAll(els => els.map(e => e.classList[0]));
    expect(order.slice(0, 6)).toEqual(['field-btn', 'sos-btn', 'field-tools', 'field-hint', 'field-listhead', 'modes-toggle']);
    const sos = await p.locator('#main .sos-btn').boundingBox();
    expect(Math.abs(sos.height - fieldOn.height)).toBeLessThan(2);
    await expect(p.locator('#main .field-listhead h2')).toHaveText(LONG);   // build 82: a plain heading
    const rain = await p.locator('#hdrLock').boundingBox(), sign = await p.locator('#hdrField').boundingBox();
    expect(rain.height).toBeGreaterThanOrEqual(47.5);
    expect(sign.x).toBeGreaterThan(rain.x + rain.width);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('a long name at 200 % text never meets the gear', async ({browser}) => {
    const ctx = await ctxFor(browser, {viewport:{width:360, height:780}}), p = await ctx.newPage(), err = watchErrors(p);
    await p.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; }));
    await start(p, {v:2, std:{done:{}, modes:{}, light:{}, open:{}}, lists:[own], main:'L1', introDone:true, lang:'no'});
    const a = await p.locator('#listBtn').boundingBox(), g = await p.locator('#hdrSet').boundingBox();
    expect(a.x + a.width).toBeLessThanOrEqual(g.x + 0.5);
    expect(g.x + g.width).toBeLessThanOrEqual(360);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('a tap grows Nødmodus over Utemodus for about 3 s; a hold opens it', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, {lists:[], introDone:true, lang:'no', field:true});
    const f = await p.locator('#main .field-btn').boundingBox(), s0 = await p.locator('#main .sos-btn').boundingBox();
    await p.mouse.click(s0.x + s0.width / 2, s0.y + s0.height / 2);
    await expect(p.locator('#main .sos-btn')).toHaveClass(/grow/);
    await p.waitForTimeout(450);
    await expect(p.locator('#sos')).toBeHidden();
    const s1 = await p.locator('#main .sos-btn').boundingBox();
    expect(s1.height).toBeGreaterThan(125);
    expect(Math.abs(s1.y - f.y)).toBeLessThan(2);                                       // over the Utemodus button
    expect(Math.abs((s1.y + s1.height) - (s0.y + s0.height))).toBeLessThan(2);          // its bottom edge stays: nothing moves
    await expect(p.locator('#main .sos-btn .g')).toHaveText('Hold inne for å åpne');
    const hit = await p.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest('.sos-btn'), [f.x + f.width / 2, f.y + f.height / 2]);
    expect(hit).toBe(true);
    // back to its size after about 3 s
    await p.waitForTimeout(3600);
    await expect(p.locator('#main .sos-btn')).not.toHaveClass(/grow/);
    expect((await p.locator('#main .sos-btn').boundingBox()).height).toBeLessThan(70);
    // tap, then hold on the grown button where Utemodus is: it opens
    await p.mouse.click(s0.x + s0.width / 2, s0.y + s0.height / 2);
    await p.waitForTimeout(450);
    await p.mouse.move(f.x + f.width / 2, f.y + f.height / 2); await p.mouse.down(); await p.waitForTimeout(1200); await p.mouse.up();
    await expect(p.locator('#sos')).toBeVisible();
    expect(await p.evaluate(k => JSON.parse(localStorage.getItem(k)).field, KEY)).toBe(true);   // Utemodus was not touched
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('Bål visitors: Av never, Ofte within 3 minutes', async ({browser}) => {
    for (const [mode, within] of [['off', null], ['often', 3]]){
      const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
      await p.clock.install();
      await start(p, {lists:[], introDone:true, lang:'no', field:true, fireGuests:mode}, true);
      const b = await p.locator('#main .lt-btn[data-light="fire"]').boundingBox();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(1200); await p.mouse.up();
      await expect(p.locator('#slFireCv')).toBeVisible();
      let first = null;
      for (let m = 1; m <= 30 && first === null; m++){
        await p.clock.fastForward('01:00'); await p.clock.runFor(200);
        if (await p.evaluate(() => window.__vardeTest.Fire.guest)) first = m;
      }
      if (within === null) expect(first, mode).toBeNull();
      else { expect(first, mode).not.toBeNull(); expect(first).toBeLessThanOrEqual(within); }
      expect(err).toEqual([]);
      await ctx.close();
    }
  });
});

/* ---------- From build 56 (0.12.1): Bål sleeps when burned out ----------
   With the page clock fast-forwarded: after 45 min the fire is out and soft Z's rise; two minutes later it sleeps,
   the picture stands still and the screen is let go (wake lock released, even in Utemodus); holding the screen to add
   wood wakes it and takes the screen again. The wake lock and fillText are watched through small stand-ins. */
test.describe('bål sover', () => {
  test('burns out, Z, sleeps, wakes on wood', async ({browser}) => {
    const ctx = await browser.newContext({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
    const p = await ctx.newPage();
    const err = watchErrors(p);
    await p.addInitScript(([key, s]) => {
      try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){}
      window.__wl = {held:false, requests:0};
      Object.defineProperty(navigator, 'wakeLock', {configurable:true, value:{ request: async () => {
        window.__wl.requests++; window.__wl.held = true; const fns = [];
        return { addEventListener: (t, f) => fns.push(f), release: async () => { window.__wl.held = false; fns.forEach(f => f()); } };
      }}});
      window.__z = 0;
      const ft = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(t, ...a){ if (t === 'Z') window.__z++; return ft.call(this, t, ...a); };
    }, [KEY, {lists:[], hidePacked:false, introDone:true, lang:'no', field:true}]);
    await p.clock.install();
    await p.goto('./');
    const holdAt = async (x, y, ms) => { await p.mouse.move(x, y); await p.mouse.down(); await p.waitForTimeout(ms); await p.mouse.up(); };
    const b = await p.locator('#main .lt-btn[data-light="fire"]').boundingBox();
    await holdAt(b.x + b.width / 2, b.y + b.height / 2, 1200);
    await expect(p.locator('#slFireCv')).toBeVisible();
    await expect.poll(() => p.evaluate(() => window.__wl.held)).toBe(true);
    const pic = () => p.locator('#slFireCv').evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0; return h; });
    // 45 minutes later: burned out, Z's rise, the screen is still held
    await p.clock.fastForward('45:30');
    await p.clock.runFor(5000);
    expect(await p.evaluate(() => window.__z)).toBeGreaterThan(0);
    expect(await p.evaluate(() => window.__wl.held)).toBe(true);
    // two more minutes: it sleeps, lets go of the screen and stands still
    await p.clock.fastForward('02:05');
    await p.clock.runFor(1000);
    await expect.poll(() => p.evaluate(() => window.__wl.held)).toBe(false);
    await expect(p.locator('#slight')).toBeVisible();
    const a1 = await pic(); await p.clock.runFor(1500); const a2 = await pic();
    expect(a2).toBe(a1);
    // adding wood wakes it: the screen is taken again and the fire moves
    const req = await p.evaluate(() => window.__wl.requests);
    await holdAt(195, 300, 1700);
    await p.clock.runFor(1500);
    await expect.poll(() => p.evaluate(() => window.__wl.held)).toBe(true);
    expect(await p.evaluate(() => window.__wl.requests)).toBeGreaterThan(req);
    const w1 = await pic(); await p.clock.runFor(500); const w2 = await pic();
    expect(w2).not.toBe(w1);
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- From build 58 (0.12.3): backup restore gives fresh ids; the CSP blocks inline handlers ---------- */
test.describe('sikkerhet', () => {
  test.use({locale:'nb-NO'});
  test('a backup with hostile ids runs nothing and the items work', async ({page}) => {
    const errors = watchErrors(page), dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await openApp(page);
    const bad = '"><img src=x onerror=alert(1)>';
    const file = JSON.stringify({app:'trip-checklist', version:3, t:1, lists:[],
      notes:[{id:bad, title:'Fiendtlig', text:'hei', t:5}], packW:{items:[{id:bad, name:'Ting', g:250, cat:'Annet'}]},
      plan:{fuelCalc:{fuel:'<img src=x onerror=alert(2)>', people:2}}});
    await page.locator('#listBtn').click();
    await page.locator('[data-la="backup"]').click();
    await page.locator('#bkFileIn').setInputFiles({name:'b.json', mimeType:'application/json', buffer:Buffer.from(file)});
    await expect(page.locator('#bkRStatus')).toBeVisible();
    const st = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
    expect(st.notes[0].id).not.toBe(bad);
    expect(st.packW.items[0].id).not.toBe(bad);
    expect(st.fuelCalc.fuel).toBeUndefined();
    // a second restore adds nothing
    await page.locator('#bkFileIn').setInputFiles({name:'b.json', mimeType:'application/json', buffer:Buffer.from(file)});
    await page.waitForTimeout(300);
    const st2 = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
    expect([st2.notes.length, st2.packW.items.length]).toEqual([1, 1]);
    await page.locator('[data-s="cancel"]').click();
    await goTab(page, 'notes');
    await page.locator('#main [data-act="openNote"]').click();
    await expect(page.locator('.note-full h2')).toContainText('Fiendtlig');
    await goTab(page, 'plan');
    await openRow(page, 'weight');
    await expect(page.locator('#main input[data-wid]')).toHaveCount(1);
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    await page.goBack();
    await openRow(page, 'fuel');
    await expect(page.locator('#fuelOut')).toBeVisible();
    expect(dialogs).toEqual([]);
    await settle(page, errors);
  });

  test('the CSP blocks inline event handlers', async ({page}) => {
    const csp = [];
    page.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
    await openApp(page);
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<img id="cspT" src="data:," onerror="window.__ran=1" onload="window.__ran=1">'); });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__ran)).toBeUndefined();
    expect(csp.length).toBeGreaterThan(0);
  });
});

/* ---------- From build 63 (0.14.1): damaged data kept aside, save failure, share link in restore, large text ---------- */
test.describe('datasikkerhet', () => {
  test.use({locale:'nb-NO'});
  test('damaged stored data is kept aside and shown in the backup sheet', async ({page}) => {
    const errors = watchErrors(page);
    await page.addInitScript(([key]) => { if (!sessionStorage.getItem('seeded')){ sessionStorage.setItem('seeded', '1'); localStorage.setItem(key, '{"lists":[ ødelagt'); } }, [KEY]);
    await page.goto('./');
    // a new start shows the introduction first, then the notice
    await page.locator('#intro [data-intro="skip"]').click();
    await expect(page.locator('#panel h3')).toContainText('kunne ikke leses');
    expect(await page.evaluate(k => localStorage.getItem(k + '-rescue'), KEY)).toBe('{"lists":[ ødelagt');
    expect(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY)).lists).toEqual([]);
    await page.locator('#panel [data-s="ok"]').click();
    await expect(page.locator('#rsOut')).toHaveValue('{"lists":[ ødelagt');
    // a second start does not overwrite the copy or ask again
    await page.locator('[data-s="cancel"]').last().click();
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.locator('#tabbar [data-tab]')).toHaveCount(5);
    await page.waitForTimeout(300);
    await expect(page.locator('#overlay')).toBeHidden();
    // delete the copy
    await page.locator('#listBtn').click();
    await page.locator('[data-la="backup"]').click();
    await page.locator('#rsDel').click();
    await page.locator('#panel [data-s="ok"]').click();
    await expect(page.locator('#bkIn')).toBeVisible();
    await expect(page.locator('#rsDel')).toHaveCount(0);
    expect(await page.evaluate(k => localStorage.getItem(k + '-rescue'), KEY)).toBeNull();
    await settle(page, errors);
  });

  test('a failed save shows a message once', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await page.evaluate(() => { const real = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v){ if (k === 'outdoor-lists-v1') throw new DOMException('full', 'QuotaExceededError'); return real.call(this, k, v); }; });
    await goTab(page, 'notes');
    await expect(page.locator('#toast')).toContainText('Kunne ikke lagre');
    await settle(page, errors);
  });

  test('restore takes a pasted share link', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    // the uncompressed link code ('j' + base64url of the packed list), as an older phone makes it
    const packed = {v:1, n:'Lenkeliste', o:'', c:[['Ting', '', '', 0, '', [['Kniv', 0, -1]]]]};
    const link = (await page.evaluate(() => location.origin + location.pathname)) + '#share=j' + Buffer.from(JSON.stringify(packed)).toString('base64url');
    await page.locator('#listBtn').click();
    await page.locator('[data-la="backup"]').click();
    await page.locator('#bkIn').fill('Se her: ' + link + ' hilsen meg');
    await page.locator('#bkRestore').click();
    await expect(page.locator('#panel h3')).toContainText('Lenkeliste');
    await page.locator('#panel [data-s="ok"]').click();
    await expect(page.locator('#main')).toContainText('Lenkeliste');
    expect(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).lists.map(l => l.name), KEY)).toEqual(['Lenkeliste']);
    await settle(page, errors);
  });

  test('a cut-off backup text points to Velg fil; a broken file does not', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await page.locator('#listBtn').click();
    await page.locator('[data-la="backup"]').click();
    // build 73: Velg fil is the main restore button, pasting comes second
    await expect(page.locator('#bkFile')).toHaveClass(/primary/);
    await expect(page.locator('#bkRestore')).not.toHaveClass(/primary/);
    const full = await page.locator('#bkOut').inputValue();
    await page.locator('#bkIn').fill(full.slice(0, Math.floor(full.length / 2)));
    await page.locator('#bkRestore').click();
    await expect(page.locator('#bkRStatus')).toHaveText('Teksten ser ut til å være kuttet av underveis. Bruk Velg fil og hent sikkerhetskopien rett fra filen.');
    // other text that is not a backup keeps the old message
    await page.locator('#bkIn').fill('bare litt tekst');
    await page.locator('#bkRestore').click();
    await expect(page.locator('#bkRStatus')).toContainText('ikke en gyldig sikkerhetskopi');
    // a broken file gets the old message, not a pointer to the file picker it came from
    await page.locator('#bkFileIn').setInputFiles({name:'b.json', mimeType:'application/json', buffer:Buffer.from(full.slice(0, 40))});
    await expect(page.locator('#bkRStatus')).toContainText('ikke en gyldig sikkerhetskopi');
    // the whole text still restores
    await page.locator('#bkIn').fill(full);
    await page.locator('#bkRestore').click();
    await expect(page.locator('#bkRStatus')).not.toContainText('kuttet');
    await settle(page, errors);
  });

  test('large text: five tab labels fit and all Nødmodus colours are on screen', async ({page}) => {
    await page.setViewportSize({width:360, height:740});
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; }));
    await openApp(page);
    const boxes = await page.locator('#tabbar [data-tab] span').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1]);
    await goTab(page, 'guide');
    const hb = page.locator('[data-sos-hold]').first();
    const bb = await hb.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.waitForTimeout(1300); await page.mouse.up();
    const hues = await page.locator('.sos-hues button').evaluateAll(els => els.map(e => e.getBoundingClientRect().right));
    expect(hues.length).toBe(3);
    for (const r of hues) expect(r).toBeLessThanOrEqual(360);
  });
});

/* ---------- From build 63: the service worker caches the app and opens it offline ---------- */
// The app registers its service worker on https or localhost only, so these tests use localhost.
async function openSw(page){
  await page.addInitScript(([key]) => {
    try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({lists:[], hidePacked:false, introDone:true})); } catch(e){}
  }, [KEY]);
  await page.goto('http://localhost:4173/');
  await expect(page.locator('#tabbar [data-tab]')).toHaveCount(5);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}
test.describe('service worker', () => {
  test.use({serviceWorkers:'allow', locale:'nb-NO'});
  test('installs, caches every asset, and opens the app offline', async ({page, context}) => {
    await openSw(page);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const cache = (SW.match(/const CACHE\s*=\s*'([^']+)'/) || [])[1];
    const n = (SW.match(/const ASSETS\s*=\s*\[([^\]]*)\]/) || [])[1].split(',').length;
    expect(await page.evaluate(async c => (await (await caches.open(c)).keys()).length, cache)).toBeGreaterThanOrEqual(n - 1);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#tabbar [data-tab]')).toHaveCount(5);
    await context.setOffline(false);
  });

  test('a slow network opens the saved copy within a few seconds', async ({page, context}) => {
    await openSw(page);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.route(/index\.html$|\/$/, async route => { await new Promise(r => setTimeout(r, 10000)); try { await route.continue(); } catch(e){} });
    const t0 = Date.now();
    await page.reload({waitUntil:'domcontentloaded'});
    await expect(page.locator('#tabbar [data-tab]')).toHaveCount(5);
    expect(Date.now() - t0).toBeLessThan(8000);
    await context.unrouteAll({behavior:'ignoreErrors'});
  });
});

/* ---------- From build 64 (0.15.0): Guider groups fold ---------- */
test.describe('guider folds', () => {
  test.use({locale:'nb-NO'});
  test('groups fold, remember and open with a guide', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await goTab(page, 'guide');
    const head = k => page.locator(`#main [data-gfold="${k}"]`);
    // a fresh start: every group folded (0.15.1: Helse og nød too), Nødmodus still at the top
    for (const k of ['field', 'safety', 'sky', 'gear', 'health']) await expect(head(k)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#main [data-open="knots"]')).toBeHidden();
    await expect(page.locator('#main [data-open="emergency"]')).toBeHidden();
    await expect(page.locator('#main [data-sos-hold]')).toBeVisible();
    await expect(head('field').locator('.gf-p')).toContainText('Knuter');
    // 0.15.1: every group heading has its icon
    for (const k of ['field', 'safety', 'sky', 'gear', 'health']) await expect(head(k).locator('svg.gh-ic')).toHaveCount(1);
    // open and close
    await head('sky').click();
    await expect(head('sky')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#main [data-open="aurora"]')).toBeVisible();
    await head('sky').click();
    await expect(page.locator('#main [data-open="aurora"]')).toBeHidden();
    // remembered across a reload
    await head('gear').click();
    await page.reload();
    await expect(page.locator('#main [data-open="tent"]')).toBeVisible();
    await expect(page.locator('#main [data-open="knots"]')).toBeHidden();
    // a guide opened by a link leaves its group open for Back
    await goTab(page, 'list');
    await page.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'openGuide'; b.dataset.guide = 'nightsky'; b.dataset.nav = ''; b.id = 'tLink'; document.getElementById('main').prepend(b); });
    await page.locator('#tLink').click();
    await page.goBack();
    await goTab(page, 'guide');
    await expect(page.locator('#main [data-open="nightsky"]')).toBeVisible();
    // a new window, more than 15 minutes later, is a fresh start: folded again
    await page.evaluate(k => { const s = JSON.parse(localStorage.getItem(k)); s.hiddenAt = 0; localStorage.setItem(k, JSON.stringify(s)); }, KEY);
    const p2 = await page.context().newPage();
    await p2.goto('./');
    await p2.locator('#tabbar [data-tab="guide"]').click();
    await expect(p2.locator('#main [data-gfold="gear"]')).toHaveAttribute('aria-expanded', 'false');
    await settle(page, errors);
  });

  test('folding works in Regnlås', async ({page}) => {
    await openApp(page);
    await page.evaluate(k => { const s = JSON.parse(localStorage.getItem(k)); s.field = true; s.rainLocked = true; localStorage.setItem(k, JSON.stringify(s)); }, KEY);
    await page.reload();
    await page.locator('#tabbar [data-tab="guide"]').click({force:true});
    await page.waitForTimeout(200);
    if (!(await page.locator('#main [data-gfold="field"]').count())) test.skip(true, 'Guider not reachable without Naviger');
    await page.locator('#main [data-gfold="field"]').click();
    await expect(page.locator('#main [data-gfold="field"]')).toHaveAttribute('aria-expanded', 'true');
  });
});

/* ---------- From build 67 (0.16.0): true north and Stjerner og planeter ----------
   The phone gives magnetic north; with a saved position the app adds the WMM2025 declination. Reference values are
   from the WMM2025 coefficient file run through an independent implementation (pygeomag). The star view opens from
   Kompass, shows the sky on the outer ring and in the list (Saturn and the moon at a fixed evening), and Back returns. */
// The sky code from index.html, run in Node (the app keeps everything inside one closure, so a page cannot reach it)
const SKY = (() => {
  const a = HTML.indexOf('/* ---------- true north: declination'), b = HTML.indexOf('/* ---------- Stjerner og planeter (0.16.0)');
  return new Function('RAD', HTML.slice(a, b) + '\nreturn {magDecl, skyObjects};')(Math.PI / 180);
})();
test.describe('kompass', () => {
  test('declination and sky positions match the reference values', () => {
    const at = new Date('2026-11-16T00:00:00Z');
    expect(SKY.magDecl(58.97, 5.73, at)).toBeCloseTo(3.033, 1);   // Stavanger
    expect(SKY.magDecl(69.97, 23.27, at)).toBeCloseTo(13.832, 1); // Alta
    expect(SKY.magDecl(-33.9, 151.2, at)).toBeCloseTo(12.838, 1); // Sydney
    const sky = SKY.skyObjects(new Date('2026-11-16T20:00:00Z'), 58.97, 5.73), o = k => sky.find(x => x.k === k);
    // reference: PyEphem for Stavanger at that time (Saturn 172° / 32°, Venus 335° / −39°); Polaris stands at the latitude in the north
    expect(Math.abs(o('saturn').az - 172)).toBeLessThan(1.5); expect(Math.abs(o('saturn').alt - 32)).toBeLessThan(1.5);
    expect(Math.abs(o('venus').az - 335)).toBeLessThan(1.5); expect(Math.abs(o('venus').alt + 39)).toBeLessThan(1.5);
    expect(Math.abs(((o('polaris').az + 180) % 360) - 180)).toBeLessThan(1.5); expect(Math.abs(o('polaris').alt - 58.97)).toBeLessThan(1.5);
  });
  const ctxFor = (browser, locale) => browser.newContext({locale: locale || 'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
  const start = async (p, st) => {
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
    // newer Chromium has DeviceOrientationEvent.requestPermission() (as on the iPhone) and denies it in a headless test:
    // answer it as a user tapping Allow would, so Start kompasset starts
    await p.addInitScript(() => { try { if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') Object.defineProperty(DeviceOrientationEvent, 'requestPermission', {value: async () => 'granted', configurable: true}); } catch(e){} });
    await p.goto('./');
  };
  const turn = (p, alpha) => p.evaluate(a => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', {alpha:a, beta:0, gamma:0, absolute:true})), alpha);

  test('the dial shows true north with a position, magnetic without', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, {lists:[], introDone:true, lang:'no', pos:{lat:69.97, lon:23.27, t:Date.now()}});
    await p.locator('#tabbar [data-tab="compass"]').click();
    await p.locator('#main [data-act="cStart"]').click();
    await expect(p.locator('#main [data-act="cHold"]'), 'compass started (message: ' + await p.locator('#cMsg').textContent() + ')').toBeVisible();
    await expect(p.locator('#cNorth')).toHaveText(/^Sann nord · misvisning 1[34]° Ø$/);
    await turn(p, 0); // magnetic north straight ahead
    await expect(p.locator('#cDeg')).toHaveText(/^1[34]°$/);
    // without a position: magnetic, and the line says so
    const c2 = await ctxFor(browser), q = await c2.newPage();
    await start(q, {lists:[], introDone:true, lang:'no'});
    await q.locator('#tabbar [data-tab="compass"]').click();
    await q.locator('#main [data-act="cStart"]').click();
    await expect(q.locator('#main [data-act="cHold"]')).toBeVisible();
    await turn(q, 0);
    await expect(q.locator('#cDeg')).toHaveText('0°');
    await expect(q.locator('#cNorth')).toContainText('Magnetisk nord');
    expect(err).toEqual([]);
    await ctx.close(); await c2.close();
  });

  for (const L of LANGS) test(`Stjerner og planeter opens, shows the sky and goes back (${L.lang})`, async ({browser}) => {
    const ctx = await ctxFor(browser, L.locale), p = await ctx.newPage(), err = watchErrors(p);
    await p.clock.setFixedTime(new Date('2026-11-16T20:00:00Z')); // Stavanger, dark: Saturn high in the south, the moon low in the south-west
    await start(p, {lists:[], introDone:true, lang:L.lang, pos:{lat:58.97, lon:5.73, t:Date.now()}});
    await p.locator('#tabbar [data-tab="compass"]').click();
    await p.locator('#main [data-act="cStars"]').click();
    const T = L.lang === 'no' ? {title:'Stjerner og planeter', n:{saturn:'Saturn', moon:'Månen', polaris:'Polarstjernen', vega:'Vega', capella:'Capella', venus:'Venus', sirius:'Sirius'}}
      : {title:'Stars and planets', n:{saturn:'Saturn', moon:'The moon', polaris:'Polaris', vega:'Vega', capella:'Capella', venus:'Venus', sirius:'Sirius'}};
    await expect(p.locator('#listName')).toHaveText(T.title);
    const rows = p.locator('#stList .st-row');
    expect(await rows.count()).toBeGreaterThan(5);
    for (const k of ['saturn', 'moon', 'polaris', 'vega', 'capella']) await expect(p.locator('#stList .st-name', {hasText: new RegExp('^' + T.n[k] + '$')})).toHaveCount(1);
    for (const k of ['venus', 'sirius']) await expect(p.locator('#stList .st-name', {hasText: new RegExp('^' + T.n[k] + '$')})).toHaveCount(0); // below the horizon
    await expect(p.locator('#skyStars text', {hasText: T.n.polaris})).toHaveCount(1);
    await expect(p.locator('#stSay')).toHaveText('');
    await p.locator('#main [data-act="back"]').click();
    await expect(p.locator('#main [data-act="cStars"]')).toBeVisible();
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- From build 69 (0.17.0): the Milky Way band, its centre and the moon in the middle ----------
   Stavanger 17 Nov 22:00: the Milky Way runs from W to E nearly overhead, two horizon marks, its centre only just clears
   the horizon here (2°), the moon sits in the middle of the dial. Sydney 15 Jul 22:00: the centre is up and nearly
   overhead, with its mark on the ring. Tenerife 1 Mar 03:20: the Milky Way lies low along the horizon, so no band.
   Nødmodus points to the real whistle in both languages. */
test.describe('melkeveien', () => {
  const ctxFor = (browser, locale) => browser.newContext({locale, serviceWorkers:'block', viewport:{width:390, height:780}});
  const open = async (p, lang, pos, when) => {
    await p.clock.setFixedTime(new Date(when));
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} },
      [KEY, {lists:[], introDone:true, lang, pos:Object.assign({t:Date.now()}, pos)}]);
    await p.goto('./');
    await p.locator('#tabbar [data-tab="compass"]').click();
    await p.locator('#main [data-act="cStars"]').click();
  };
  const TX = {no:{mw:'Melkeveien', gc:'Melkeveiens sentrum (Skytten)', wE:'fra V til Ø', high:'høyest nesten rett over deg', barely:'kommer bare så vidt over horisonten her (høyest 2°)',
      over:'nesten rett over deg', low:'Melkeveien ligger lavt langs horisonten nå, og er vanskelig å se.', mark:'Sentrum', whistle:'Bruk fløyta i sekken; den høres mye lenger enn mobilen.'},
    en:{mw:'Milky Way', gc:'Centre of the Milky Way (Sagittarius)', wE:'from W to E', high:'highest nearly overhead', barely:'only just clears the horizon here (highest 2°)',
      over:'nearly overhead', low:'The Milky Way lies low along the horizon now, and is hard to see.', mark:'Centre', whistle:'Use the whistle in your pack; it carries much further than the phone.'}};
  for (const L of LANGS) test(`Milky Way band, centre and moon (${L.lang})`, async ({browser}) => {
    const X = TX[L.lang];
    let ctx = await ctxFor(browser, L.locale), p = await ctx.newPage(), err = watchErrors(p);
    await open(p, L.lang, {lat:58.97, lon:5.73}, '2026-11-17T21:00:00Z');
    const rows = p.locator('#stList ul[data-g="mw"] .st-row');  // 0.19.0: the Milky Way rows are their own group, last
    await expect(p.locator('#stList h3[data-g="mw"]')).toHaveText(X.mw);
    await expect(rows.nth(0).locator('.st-name')).toHaveText(X.mw);
    await expect(rows.nth(0).locator('.st-pos')).toContainText(X.wE);
    await expect(rows.nth(0).locator('.st-pos')).toContainText(X.high);
    await expect(rows.nth(1).locator('.st-name')).toHaveText(X.gc);
    await expect(rows.nth(1).locator('.st-pos')).toContainText(X.barely);
    // 0.19.0: the band lies inside the dial (r 150), and two triangles on the outer edge mark the horizon points
    expect(await p.locator('#skyBand .mwseg').count()).toBeGreaterThan(20);
    const far = await p.locator('#skyBand .mwseg').evaluateAll(ls => Math.max(...ls.flatMap(l => [[+l.getAttribute('x1'), +l.getAttribute('y1')], [+l.getAttribute('x2'), +l.getAttribute('y2')]]).map(q => Math.hypot(q[0] - 160, q[1] - 160))));
    expect(far).toBeLessThanOrEqual(150.5);
    const near = await p.locator('#skyBand .mwseg').evaluateAll(ls => Math.min(...ls.map(l => Math.hypot((+l.getAttribute('x1') + +l.getAttribute('x2')) / 2 - 160, (+l.getAttribute('y1') + +l.getAttribute('y2')) / 2 - 160))));
    expect(near).toBeLessThan(30);  // nearly overhead: passes close to the middle
    await expect(p.locator('#skyBand .mwtri')).toHaveCount(2);
    await expect(p.locator('#skyBand path:not(.mwtri)')).toHaveCount(0);
    await expect(p.locator('#stMoon image.mn-big')).toHaveCount(1);  // 0.20.0: the Moon as it stands, as an image
    await expect(p.locator('#skyStars text', {hasText: new RegExp('^' + X.mark + '$')})).toHaveCount(0);
    expect(await p.content()).toContain(X.whistle);
    expect(err).toEqual([]);
    await ctx.close();
    ctx = await ctxFor(browser, L.locale); p = await ctx.newPage(); err = watchErrors(p);
    await open(p, L.lang, {lat:-33.87, lon:151.21}, '2026-07-15T12:00:00Z');
    await expect(p.locator('#stList ul[data-g="mw"] .st-row').nth(1).locator('.st-pos')).toContainText(X.over);
    await expect(p.locator('#skyStars text', {hasText: new RegExp('^' + X.mark + '$')})).toHaveCount(1);
    expect(err).toEqual([]);
    await ctx.close();
    ctx = await ctxFor(browser, L.locale); p = await ctx.newPage(); err = watchErrors(p);
    await open(p, L.lang, {lat:28.3, lon:-16.5}, '2026-03-01T03:20:00Z');
    await expect(p.locator('#stList ul[data-g="mw"] .st-row').nth(0).locator('.st-pos')).toContainText(X.low);
    await expect(p.locator('#skyBand .mwseg')).toHaveCount(0);
    await expect(p.locator('#skyBand .mwtri')).toHaveCount(0);
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- From build 75 (0.19.0): names on the ring, the list in groups with a sort switch, the Milky Way in the dial ----------
   Stavanger 19 Nov 2026 21:00 local (20:00 UTC): Rigel (3° up, 108°) and Aldebaran (104°) are a close pair at the east
   side; Rigel's name goes below its own dot and Aldebaran's above its own, each line starts at its own dot, and no two
   names overlap. The list has three groups in order; Høyest først puts Deneb (55°) before Rigel (3°) in Stjerner, and the
   choice survives a reload. «lavt over horisonten» for Rigel. Help text and guides carry the new texts. */
test.describe('stjerner 0.19', () => {
  const ctxFor = (browser, locale) => browser.newContext({locale, serviceWorkers:'block', viewport:{width:390, height:780}});
  const open = async (p, lang, pos, when) => {
    await p.clock.setFixedTime(new Date(when));
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} },
      [KEY, {lists:[], introDone:true, lang, pos:Object.assign({t:Date.now()}, pos)}]);
    await p.goto('./');
    await p.locator('#tabbar [data-tab="compass"]').click();
    await p.locator('#main [data-act="cStars"]').click();
  };
  const TX = {no:{mp:'Månen og planetene', st:'Stjerner', mw:'Melkeveien', bright:'Lysest først', high:'Høyest først', low:'lavt over horisonten',
      help:'De to trekantene på ytterkanten peker dit Melkeveien møter horisonten', guide:'Hvorfor den går rundt hele himmelen:', comp:'Båndet inne i kompasset er Melkeveien'},
    en:{mp:'The moon and planets', st:'Stars', mw:'Milky Way', bright:'Brightest first', high:'Highest first', low:'low on the horizon',
      help:'The two triangles on the outer edge point to where the Milky Way meets the horizon', guide:'Why it runs all round the sky:', comp:'The band inside the compass is the Milky Way'}};
  const dotOf = (p, name) => p.evaluate(n => {
    const g = [...document.querySelectorAll('#skyStars .stl')].find(e => e.querySelector('text').textContent === n);
    if (!g) return null;
    const svg = g.ownerSVGElement, az = +g.dataset.az, R = Math.PI / 180, x = 160 + 162 * Math.sin(az * R), y = 160 - 162 * Math.cos(az * R);
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = y; const d = pt.matrixTransform(document.getElementById('dial').getScreenCTM());
    const t = g.querySelector('text').getBoundingClientRect(), ln = g.querySelector('line');
    let l = null;
    if (ln.getAttribute('visibility') === 'visible'){ const a = svg.createSVGPoint(); a.x = +ln.getAttribute('x1'); a.y = +ln.getAttribute('y1'); const m = g.getScreenCTM(); const s = a.matrixTransform(m); l = {x: s.x, y: s.y}; }
    return {dot: {x: d.x, y: d.y}, text: {top: t.top, bottom: t.bottom, left: t.left, right: t.right, cy: (t.top + t.bottom) / 2}, line: l, shown: g.getAttribute('visibility') !== 'hidden'};
  }, name);
  for (const L of LANGS) test(`names, groups and the sort switch (${L.lang})`, async ({browser}) => {
    const X = TX[L.lang];
    const ctx = await ctxFor(browser, L.locale), p = await ctx.newPage(), err = watchErrors(p);
    await open(p, L.lang, {lat:58.97, lon:5.73}, '2026-11-19T20:00:00Z');
    // names: Rigel below its own dot, Aldebaran above its own, Rigel's line starts at Rigel's dot
    const rig = await dotOf(p, 'Rigel'), ald = await dotOf(p, 'Aldebaran');
    expect(rig && ald).toBeTruthy();
    expect(rig.shown && ald.shown).toBe(true);
    expect(rig.dot.y).toBeGreaterThan(ald.dot.y);
    expect(rig.text.cy).toBeGreaterThan(rig.dot.y);
    expect(ald.text.cy).toBeLessThan(ald.dot.y);
    expect(rig.line).toBeTruthy();
    expect(Math.hypot(rig.line.x - rig.dot.x, rig.line.y - rig.dot.y)).toBeLessThan(12);
    // every visible line starts at its own dot, and no two shown names overlap
    const chk = await p.evaluate(() => {
      const R = Math.PI / 180, out = {bad: 0, lines: 0, overlap: 0}, boxes = [];
      document.querySelectorAll('#skyStars .stl').forEach(g => {
        if (g.getAttribute('visibility') === 'hidden') return;
        const svg = g.ownerSVGElement, az = +g.dataset.az, pt = svg.createSVGPoint();
        pt.x = 160 + 162 * Math.sin(az * R); pt.y = 160 - 162 * Math.cos(az * R);
        const d = pt.matrixTransform(document.getElementById('dial').getScreenCTM()), ln = g.querySelector('line');
        if (ln.getAttribute('visibility') === 'visible'){
          out.lines++;
          const a = svg.createSVGPoint(); a.x = +ln.getAttribute('x1'); a.y = +ln.getAttribute('y1');
          const s = a.matrixTransform(g.getScreenCTM());
          if (Math.hypot(s.x - d.x, s.y - d.y) > 12) out.bad++;
        }
        const b = g.querySelector('text').getBoundingClientRect();
        boxes.forEach(o => { if (b.left < o.right - 1 && b.right > o.left + 1 && b.top < o.bottom - 1 && b.bottom > o.top + 1) out.overlap++; });
        boxes.push(b);
      });
      return out;
    });
    expect(chk.lines).toBeGreaterThan(1);
    expect(chk.bad).toBe(0);
    expect(chk.overlap).toBe(0);
    // the names sit under the dots: each name group comes before the dots in #skyStars
    expect(await p.evaluate(() => { const k = [...document.getElementById('skyStars').children]; const last = k.map(e => e.classList.contains('stl')).lastIndexOf(true); return k.slice(0, last + 1).every(e => e.classList.contains('stl')); })).toBe(true);
    // three groups in order, and Rigel low
    await expect(p.locator('#stList h3.st-grp')).toHaveText([X.mp, X.st, X.mw]);
    const stars = p.locator('#stList ul[data-g="st"] .st-name');
    await expect(p.locator('#stList ul[data-g="st"] .st-row', {hasText: 'Rigel'}).locator('small')).toHaveText(X.low);
    const order = async () => (await stars.allTextContents());
    let o = await order();
    expect(o.indexOf('Rigel')).toBeLessThan(o.indexOf('Deneb'));  // brightest first: Rigel (0.1) before Deneb (1.3)
    await expect(p.locator('#main [data-act="stSort"][data-v="bright"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(p.locator('#main [data-act="stSort"][data-v="bright"]')).toHaveText(X.bright);
    await p.locator('#main [data-act="stSort"][data-v="high"]').click();
    await expect(p.locator('#main [data-act="stSort"][data-v="high"]')).toHaveText(X.high);
    await expect(p.locator('#main [data-act="stSort"][data-v="high"]')).toHaveAttribute('aria-pressed', 'true');
    o = await order();
    expect(o.indexOf('Deneb')).toBeLessThan(o.indexOf('Rigel'));
    const alts = await p.locator('#stList ul[data-g="st"] .st-row small').allTextContents();
    const num = alts.map(a => /^(\d+)°/.test(a) ? +a.match(/^(\d+)/)[1] : (a === X.low ? 0 : 90));
    expect(num).toEqual(num.slice().sort((a, b) => b - a));
    await expect(p.locator('#stList h3.st-grp')).toHaveText([X.mp, X.st, X.mw]);
    // the choice is kept after a reload
    await p.reload();
    await expect(p.locator('#main [data-act="stSort"][data-v="high"]')).toHaveAttribute('aria-pressed', 'true');
    o = await order();
    expect(o.indexOf('Deneb')).toBeLessThan(o.indexOf('Rigel'));
    // help text, and the two guides
    await expect(p.locator('#main .manual')).toContainText(X.help);
    expect(await p.content()).toContain(X.guide);
    expect(await p.content()).toContain(X.comp);
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- From build 76 (0.20.0): the Moon as it stands ----------
   Reference values from PyEphem with Meeus ch. 14, 48 and 53 (19 Nov 2026). The orientation also matches the owner's
   photo of 27 Dec 2023 05:42 (+01), Stavanger. Tycho from straight down when the full moon stands highest in Stavanger:
   −28° on 25 Oct 2026, +8° on 21 Mar 2027. In Sydney the Moon stands upside down (Tycho above the middle). The large
   Moon in Stjerner og planeter is an image turned as it stands; the guide section Månen has the two animations, a
   Pause button, still rows with reduce motion, and the credit line; Retning om natta links to it. */
const MOON = (() => {
  const a = HTML.indexOf('/* ---------- moon (calculated on the phone'), b = HTML.indexOf('/* ---------- end of the Moon as it stands');
  return new Function(HTML.slice(a, b) + '\nreturn {moonOrient, moonPoint};')();
})();
test.describe('månen 0.20', () => {
  const D = r => r * 180 / Math.PI;
  test('orientation matches the reference values', () => {
    const ph = MOON.moonOrient(new Date('2023-12-27T04:42:09Z'), 58.97, 5.73);
    expect(Math.abs(D(ph.rot) + 31.9)).toBeLessThan(2); expect(Math.abs(D(ph.l) - 4.4)).toBeLessThan(1); expect(Math.abs(D(ph.b) + 6.3)).toBeLessThan(1);
    const now = MOON.moonOrient(new Date('2026-11-19T20:00:00Z'), 58.97, 5.73);
    expect(Math.abs(D(now.rot) + 28.3)).toBeLessThan(2); expect(Math.abs(D(now.limb) + 118.7)).toBeLessThan(3); expect(Math.abs(now.k - 0.73)).toBeLessThan(0.03);
    const tycho = (t, la, lo) => { const o = MOON.moonOrient(new Date(t), la, lo), q = MOON.moonPoint(o, -43.4, -11.1); return {a: D(Math.atan2(q.x, -q.y)), y: q.y}; };
    expect(Math.abs(tycho('2026-10-25T23:03:00Z', 58.97, 5.73).a + 28.2)).toBeLessThan(2);
    expect(Math.abs(tycho('2027-03-21T23:16:00Z', 58.97, 5.73).a - 7.9)).toBeLessThan(2);
    // Sydney, the full moon of 24 Nov 2026 at its highest: Tycho above the middle
    let best = null;
    for (let m = 0; m < 24 * 60; m += 10){ const t = new Date(Date.parse('2026-11-24T00:00:00Z') + m * 60000), o = MOON.moonOrient(t, -33.87, 151.21); const h = Math.abs(Math.atan2(Math.sin(o.H), Math.cos(o.H))); if (o.alt > 0 && (!best || h < best.h)) best = {h, t}; }
    expect(tycho(best.t.toISOString(), -33.87, 151.21).y).toBeGreaterThan(0.3);
  });
  const ctxFor = (browser, locale, extra) => browser.newContext(Object.assign({locale, serviceWorkers:'block', viewport:{width:390, height:780}}, extra || {}));
  const start = async (p, lang) => {
    await p.clock.setFixedTime(new Date('2026-11-19T20:00:00Z'));
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} },
      [KEY, {lists:[], introDone:true, lang, pos:{lat:58.97, lon:5.73, t:Date.now()}}]);
    await p.goto('./');
  };
  const TX = {no:{q:'Fasene', full:'Fullmånen gjennom året', rise:'når den står opp', side:'Ved ekvator går fullmånen nesten rett over hodet', pause:'Pause', play:'Spill av', credit:'Havene er tegnet etter et fullmånebilde tatt fra Stavanger 27. desember 2023.', nn:'Sør-Norge'},
    en:{q:'The phases', full:'The full moon through the year', rise:'as it rises', side:'At the equator the full moon passes almost straight overhead', pause:'Pause', play:'Play', credit:'The seas are drawn from a photo of the full moon taken from Stavanger, 27 December 2023.', nn:'Southern Norway'}};
  for (const L of LANGS) test(`the large Moon, the guide section and its animations (${L.lang})`, async ({browser}) => {
    const X = TX[L.lang];
    let ctx = await ctxFor(browser, L.locale), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, L.lang);
    await p.locator('#tabbar [data-tab="compass"]').click();
    await p.locator('#main [data-act="cStars"]').click();
    const big = p.locator('#stMoon image.mn-big');
    await expect(big).toHaveCount(1);
    expect(Math.abs(+(await big.getAttribute('data-rot')) + 28.3)).toBeLessThan(2);
    expect(Math.abs(+(await big.getAttribute('data-limb')) + 118.7)).toBeLessThan(3);
    expect((await big.getAttribute('href')).startsWith('data:image/png')).toBe(true);
    // the small moon on the ring is turned too
    await expect(p.locator('#skyStars .upr polygon[transform^="rotate("]')).toHaveCount(1);
    // the guide section, found by search
    await p.locator('#tabbar [data-tab="guide"]').click();
    await p.locator('#main .gs-btn').click();
    await p.locator('#gsInput').fill(X.q);
    await p.locator('#main .gs-hit[data-guide="nightsky"]').first().click();
    const sec = p.locator('#main details[data-sec="moon"]');
    await expect(sec).toHaveAttribute('open', '');
    await expect(sec.locator('.ma-title').first()).toHaveText(X.full);
    await expect(sec.locator('.ma-cv')).toHaveCount(6);
    // 0.20.2: the pictures in a row line up, whatever the text above them
    for (const fig of ['full', 'cres']){
      const tops = await sec.locator(`.moon-anim[data-anim="${fig}"] .ma-cv`).evaluateAll(cs => cs.map(c => c.getBoundingClientRect().top));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
    }
    // the evening crescent: Sør-Norge lit from the right, Australia mirrored, lit from the left (lit side as an angle
    // counter-clockwise from up: right = −90, left = +90)
    const cl = await sec.locator('.moon-anim[data-anim="cres"] .ma-cv').evaluateAll(cs => cs.map(c => ((+c.dataset.limb % 360) + 540) % 360 - 180));
    expect(cl[0]).toBeLessThan(-30); expect(cl[2]).toBeGreaterThan(30);
    await expect(sec.locator('.ma-n').first()).toHaveText(X.nn);
    await expect(sec.locator('.ma-credit')).toHaveCount(0);   // from build 80: one line for all the photos, in Om Varde
    // 0.20.1: the equator shows the full moon as it rises in the east, lying on its side; every moon says where it stands
    const eqc = sec.locator('.moon-anim[data-anim="full"] .ma-cell').nth(1);
    await expect(eqc.locator('.ma-w')).toHaveText(X.rise);
    const rot = Math.abs(+(await eqc.locator('canvas').getAttribute('data-rot')));
    expect(rot).toBeGreaterThan(45); expect(rot).toBeLessThan(135);
    await expect(eqc.locator('.ma-s')).toContainText('°');
    await expect(sec).toContainText(X.side);
    // it moves, and Pause stops it
    const cap = sec.locator('.moon-anim[data-anim="full"] .ma-cap');
    const c0 = await cap.textContent();
    await p.clock.runFor(1200);
    await expect(cap).not.toHaveText(c0);
    const btn = sec.locator('.moon-anim[data-anim="full"] .ma-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(btn).toHaveText(X.play);
    const c1 = await cap.textContent();
    await p.clock.runFor(3500);
    await expect(cap).toHaveText(c1);
    await btn.click();
    await expect(btn).toHaveText(X.pause);
    expect(err).toEqual([]);
    await ctx.close();
    // with reduce motion: four still rows each, no Pause button
    ctx = await ctxFor(browser, L.locale, {reducedMotion:'reduce'}); p = await ctx.newPage(); err = watchErrors(p);
    await start(p, L.lang);
    await p.locator('#tabbar [data-tab="guide"]').click();
    await p.locator('#main .gs-btn').click();
    await p.locator('#gsInput').fill(X.q);
    await p.locator('#main .gs-hit[data-guide="nightsky"]').first().click();
    await expect(p.locator('#main details[data-sec="moon"] .ma-cv')).toHaveCount(24);
    await expect(p.locator('#main details[data-sec="moon"] .ma-btn')).toHaveCount(0);
    // 0.20.1: Norway is Sør-Norge, where the full moon is above the horizon at its highest all year
    const no = await p.locator('#main .moon-anim[data-anim="full"] .ma-row .ma-cell:first-child canvas').evaluateAll(cs => cs.map(c => +c.dataset.alt));
    expect(no.length).toBe(4); for (const a of no) expect(a).toBeGreaterThan(0);
    expect(err).toEqual([]);
    await ctx.close();
  });
  test('Retning om natta links to Månen', async () => {
    expect(HTML).toContain('data-guide=\\"nightsky\\" data-sec=\\"moon\\">Nattehimmelen: Månen ›');
    expect(HTML).toContain('data-guide=\\"nightsky\\" data-sec=\\"moon\\">The night sky: The Moon ›');
  });
});

/* (build 78, 0.20.2: Australia in the evening crescent too, mirrored; the pictures in a row line up) */
/* (build 77, 0.20.1: the equator column shows the full moon as it rises, lying on its side; direction under every moon) */
/* ---------- From build 68 (0.16.1): Regnlås extras and accessibility ----------
   A blocked tap flashes the lock bar with a hint and changes nothing; auto-relock (off by default) locks again after
   30 s without a touch, and a touch starts the wait again; the list button is named by what it shows; Nødmodus is a
   dialog; the planners' headings sit right under the page title; and all text meets the contrast minimum in every skin. */
test.describe('regnlås og tilgjengelighet', () => {
  const ctxFor = (browser, extra) => browser.newContext(Object.assign({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}}, extra || {}));
  const start = async (p, st) => {
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
    await p.goto('./');
  };
  const hold = async (p, sel, clockMs) => {
    const b = await p.locator(sel).boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down();
    await p.clock.runFor(clockMs); await p.mouse.up();
  };

  test('a blocked tap shows the hint and changes nothing', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, {lists:[], introDone:true, lang:'no', field:true, rainLocked:true, fieldList:true});
    await expect(p.locator('body')).toHaveClass(/locked/);
    const before = await p.evaluate(k => localStorage.getItem(k), KEY);
    await p.mouse.click(200, 300);
    await expect(p.locator('#rainlock')).toHaveClass(/nudge/);
    await expect(p.locator('#rainlock .lock-note')).toHaveText(/^Låst\. Hold Naviger/);
    expect(await p.evaluate(k => localStorage.getItem(k), KEY)).toBe(before);
    await expect(p.locator('#rainlock .lock-note')).toHaveText(/^Regnlås er på/, {timeout:5000});
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('auto-relock: off by default, on locks again after 30 s without a touch', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await p.clock.install();
    await start(p, {lists:[], introDone:true, lang:'no', field:true, rainLocked:true});
    // off: unlocking stays unlocked
    await hold(p, '#unlockBtn', 1200);
    await expect(p.locator('body')).not.toHaveClass(/locked/);
    await p.clock.runFor(40000);
    await expect(p.locator('body')).not.toHaveClass(/locked/);
    // the setting is in Innstillinger, made with Utemodus off (from build 80): the gear is gone in Utemodus
    await expect(p.locator('#hdrSet')).toBeHidden();
    await p.locator('#main [data-act="fieldToggle"]').click();
    await p.locator('#hdrSet').click();
    const sw = p.locator('#main [data-act="autoRelock"]');
    await expect(sw).toHaveAttribute('aria-pressed', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-pressed', 'true');
    await p.locator('#main [data-act="back"]').click();
    await p.locator('#main [data-act="fieldToggle"]').click();
    await expect(p.locator('#hdrSet')).toBeHidden();
    // on: lock, unlock, then 30 s without a touch locks again; a touch starts the wait again
    await p.locator('#hdrLock').click();
    await expect(p.locator('body')).toHaveClass(/locked/);
    await hold(p, '#unlockBtn', 1200);
    await expect(p.locator('body')).not.toHaveClass(/locked/);
    await p.clock.runFor(20000);
    await p.mouse.click(200, 400);
    await p.clock.runFor(20000);
    await expect(p.locator('body')).not.toHaveClass(/locked/);
    await p.clock.runFor(11000);
    await expect(p.locator('body')).toHaveClass(/locked/);
    expect(await p.evaluate(k => JSON.parse(localStorage.getItem(k)).rainLocked, KEY)).toBe(true);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('names, headings and the Nødmodus dialog', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, {lists:[], introDone:true, lang:'no'});
    const lb = p.locator('#listBtn');
    await expect(lb).toHaveAccessibleName(/Dine lister/);
    const nm = (await p.locator('#listName').textContent()).trim();
    await expect(lb).toHaveAccessibleName(new RegExp(nm));
    await p.locator('#tabbar [data-tab="plan"]').click();
    await expect(lb).toHaveAttribute('role', 'none');
    await expect(p.getByRole('heading', {level:1, name:'Planlegg'})).toBeVisible();
    for (const k of ['food', 'fuel']){
      await p.locator('#tabbar [data-tab="plan"]').click();
      await p.locator(`#main [data-open="${k}"]`).click();
      expect(await p.locator('#main h3.grp').count(), `${k}: no h3 straight under the page title`).toBe(0);
      expect(await p.locator('#main h2.grp').count()).toBeGreaterThan(0);
    }
    await expect(p.locator('#sos')).toHaveAttribute('role', 'dialog');
    await expect(p.locator('#sos')).toHaveAttribute('aria-labelledby', 'sosTitle');
    expect(err).toEqual([]);
    await ctx.close();
  });

  // contrast: every visible text on the main pages, every skin, light and dark (4.5 : 1, large text 3 : 1)
  test('text contrast in every skin', async ({browser}) => {
    test.setTimeout(300000);
    const audit = () => {
      const parse = s => { const m = s && s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const q = m[1].split(',').map(parseFloat); return {r:q[0], g:q[1], b:q[2], a:q.length > 3 ? q[3] : 1}; };
      const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const blend = (t, u) => ({r:t.r * t.a + u.r * (1 - t.a), g:t.g * t.a + u.g * (1 - t.a), b:t.b * t.a + u.b * (1 - t.a), a:1});
      const bgOf = el => { const ls = []; for (let e = el; e; e = e.parentElement){ const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0){ ls.push(c); if (c.a >= 1) break; } } let b = {r:255, g:255, b:255, a:1}; for (let i = ls.length - 1; i >= 0; i--) b = blend(ls[i], b); return b; };
      const bad = [];
      document.querySelectorAll('header *, #main *, #tabbar *').forEach(el => {
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
        const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || !el.offsetParent || el.closest('svg, [disabled], s, del')) return;
        let op = 1; for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
        let fg = parse(cs.color); if (!fg) return; const bg = bgOf(el); fg = blend(Object.assign({}, fg, {a:fg.a * op}), bg);
        const L1 = lum(fg), L2 = lum(bg), cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const px = parseFloat(cs.fontSize), large = px >= 24 || (parseInt(cs.fontWeight) >= 600 && px >= 18.66);
        if (cr < (large ? 3 : 4.5) - 0.02) bad.push(`${cr.toFixed(2)} «${el.textContent.trim().slice(0, 24)}» ${String(el.className || el.tagName).slice(0, 24)}`);
      });
      return [...new Set(bad)].slice(0, 6);
    };
    const found = {};
    for (const skin of SKINS) for (const scheme of ['light', 'dark']){
      const ctx = await browser.newContext({colorScheme:scheme, serviceWorkers:'block', viewport:{width:390, height:780}, locale:'nb-NO'});
      const p = await ctx.newPage();
      await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, {lists:[], introDone:true, lang:'no', skin, pos:{lat:58.97, lon:5.73, t:1760000000000}}]);
      await p.goto('./');
      const check = async name => { const r = await p.evaluate(audit); if (r.length) found[`${skin} ${scheme} ${name}`] = r; };
      await p.locator('#main [data-act="foldAll"]').click(); await check('list');
      await p.locator('#tabbar [data-tab="guide"]').click();
      for (const h of await p.locator('#main [data-gfold]').all()) await h.click();
      await check('guider');
      await p.locator('#tabbar [data-tab="plan"]').click(); await p.locator('#main [data-open="food"]').click(); await check('food');
      await p.locator('#tabbar [data-tab="compass"]').click(); await check('compass');
      await p.locator('#tabbar [data-tab="list"]').click(); await p.locator('#hdrSet').click(); await check('innstillinger');
      await p.locator('#main [data-act="back"]').click();
      await p.locator('#tabbar [data-tab="list"]').click(); await p.locator('#main [data-act="fieldToggle"]').click(); await check('utemodus');
      await ctx.close();
    }
    expect(found).toEqual({});
  });
});

/* ---------- From build 70 (0.18.0): private notes, password links and password backups ---------- */
test.describe('privat', () => {
  test.use({locale:'nb-NO'});
  const PW = 'blåbær-hytte-7';
  const stored = p => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const sheet = p => p.locator('#overlay');
  async function newNote(p, ti, tx){
    await goTab(p, 'notes');
    if (await p.locator('#main [data-act="back"]').count()) await p.locator('#main [data-act="back"]').click();
    await p.locator('#main [data-act="newNote"]').click();
    await p.locator('#noteTitle').fill(ti);
    await p.locator('#noteText').fill(tx);
    await p.locator('#overlay [data-s="ok"]').click();
    await expect(p.locator('#main .note-full h2')).toContainText(ti);
  }
  // after build 80: on GitHub's runner the second field was sometimes empty right after filling (the sheet still settling),
  // so both fields are filled again until they hold the password; what follows still checks the result
  async function pwOk(p, pw, again){
    await expect(async () => {
      await p.locator('#pw1').fill(pw);
      if (again) await p.locator('#pw2').fill(pw);
      await expect(p.locator('#pw1')).toHaveValue(pw, {timeout:1000});
      if (again) await expect(p.locator('#pw2')).toHaveValue(pw, {timeout:1000});
    }).toPass({timeout:10000});
    await p.locator('#overlay [data-s="ok"]').click();
  }
  async function makePrivate(p, pw, first){
    await p.locator('#main [data-act="notePriv"]').click();
    if (first){ await expect(sheet(p)).toContainText('passordbehandleren'); await pwOk(p, pw, true); }
    await expect(p.locator('#toast')).toContainText('privat og kryptert');
  }

  test('make private, lock, wrong and right password, change it, forget it', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await newNote(page, 'Vanlig', 'synlig tekst');
    await newNote(page, 'Hemmelig hytte', 'nøkkelen ligger under steinen');
    // too short, and two passwords that differ
    await page.locator('#main [data-act="notePriv"]').click();
    await page.locator('#pw1').fill('kort'); await page.locator('#pw2').fill('kort');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#pwSt')).toHaveText('Minst 8 tegn.');
    await page.locator('#pw1').fill(PW); await page.locator('#pw2').fill(PW + 'x');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#pwSt')).toHaveText('Passordene er ikke like.');
    await page.locator('#pw2').fill(PW);
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#toast')).toContainText('privat og kryptert');
    // stored data holds no title or text in plain form, and no password or key
    const raw = await page.evaluate(k => localStorage.getItem(k), KEY);
    expect(raw).not.toContain('Hemmelig');
    expect(raw).not.toContain('steinen');
    expect(raw).not.toContain(PW);
    expect(raw).toContain('synlig tekst');
    const st = await stored(page);
    expect(Object.keys(st.priv).sort()).toEqual(['iter', 'iv', 'kdf', 'salt', 'v', 'wrap']);
    expect(st.priv.iter).toBe(600000);
    // open while unlocked: the title shows with the open lock; Lås nå on Dine lister locks it
    await page.locator('#main [data-act="back"]').click();
    await expect(page.locator('#main .notes-ix')).toContainText('Hemmelig hytte');
    await expect(page.locator('#main .notes-ix .lock-open')).toHaveCount(1);
    // build 72: Lås nå next to Nytt notat locks all; then it says Lås opp and opens them again
    await page.locator('#main .row-btns [data-act="privLockNow"]').click();
    await expect(page.locator('#main .notes-ix .priv-locked')).toContainText('Privat notat');
    await page.locator('#main .row-btns [data-act="privOpen"]').click();
    await pwOk(page, PW);
    await expect(page.locator('#main .notes-ix')).toContainText('Hemmelig hytte');
    await page.locator('#listBtn').click().catch(() => {});
    await goTab(page, 'list');
    await page.locator('#hdrSet').click();
    await expect(page.locator('#main .priv-status')).toHaveText('Private notater er åpne.');
    await page.locator('#main [data-act="privLockNow"]').click();
    await expect(page.locator('#main .priv-status')).toHaveText('Private notater er låst.');
    await expect(page.locator('#main .pg-sec [data-act="privOpen"]')).toHaveCount(1);
    await goTab(page, 'notes');
    await expect(page.locator('#main .notes-ix .priv-locked')).toContainText('Privat notat');
    await expect(page.locator('#main .notes-ix')).not.toContainText('Hemmelig');
    // a wrong password opens nothing, the right one opens
    await page.locator('#main .notes-ix .priv-locked').click();
    await expect(page.locator('#main .note-full.priv-locked h2')).toHaveText('Privat notat');
    await page.locator('#main [data-act="privOpen"]').click();
    await pwOk(page, 'feil-passord');
    await expect(page.locator('#pwSt')).toHaveText('Feil passord.');
    await pwOk(page, PW);
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator('#main .note-full h2')).toContainText('Hemmelig hytte');
    // editing seals it again with a fresh IV; plain text never reaches storage
    const ct1 = (await stored(page)).notes.find(n => n.priv).ct;
    await page.locator('#main .note-body').click();
    await page.locator('#neText').fill('flyttet til sekken');
    await page.locator('#main [data-act="noteSave"]').click();
    await expect(page.locator('#main .note-body')).toHaveText('flyttet til sekken');
    const st2 = await stored(page);
    expect(st2.notes.find(n => n.priv).ct).not.toBe(ct1);
    expect(JSON.stringify(st2)).not.toContain('sekken');
    // Bytt passord: the old one fails, the new one opens, the note is unchanged
    await goTab(page, 'list');
    await page.locator('#hdrSet').click();
    const before = await stored(page);
    await page.locator('#main [data-act="privChange"]').click();
    await pwOk(page, 'nytt-passord-9', true);
    await expect(page.locator('#toast')).toContainText('Passordet er byttet');
    const after = await stored(page);
    expect(after.priv.salt).not.toBe(before.priv.salt);
    expect(after.notes.find(n => n.priv).ct).not.toBe(before.notes.find(n => n.priv).ct);   // build 71: a new data key
    await page.locator('#main [data-act="privLockNow"]').click();
    await goTab(page, 'notes');
    await page.locator('#main .notes-ix .priv-locked').click();
    await page.locator('#main [data-act="privOpen"]').click();
    await pwOk(page, PW);
    await expect(page.locator('#pwSt')).toHaveText('Feil passord.');
    await pwOk(page, 'nytt-passord-9');
    await expect(page.locator('#main .note-body')).toHaveText('flyttet til sekken');
    // Fjern privat makes it an ordinary note again; Gjør privat seals it once more (no new password asked)
    await page.locator('#main [data-act="notePubl"]').click();
    expect(JSON.stringify(await stored(page))).toContain('flyttet til sekken');
    await makePrivate(page, null, false);
    // build 72: deleting a private note asks first; Avbryt keeps it, Slett deletes with Angre
    await page.locator('#main [data-act="delNote"]').click();
    await expect(page.locator('#overlay h3')).toHaveText('Slette det private notatet?');
    await page.locator('#overlay [data-s="cancel"]').click();
    await expect(page.locator('#main .note-full h2')).toContainText('Hemmelig hytte');
    await page.locator('#main [data-act="delNote"]').click();
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#toast')).toContainText('slettet');
    await page.locator('#toast button').click();
    await expect(page.locator('#main .notes-ix [data-act="openNote"]')).toHaveCount(2);
    // Glemt passordet: deletes only the private notes, with Angre
    await goTab(page, 'list');
    await page.locator('#hdrSet').click();
    await page.locator('#main [data-act="privLockNow"]').click();
    await goTab(page, 'notes');
    await page.locator('#main .notes-ix .priv-locked').click();
    await page.locator('#main [data-act="privOpen"]').click();
    await page.locator('#overlay [data-s="forgot"]').click();
    await expect(sheet(page)).toContainText('kan ikke hentes fram');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#main .notes-ix [data-act="openNote"]')).toHaveCount(1);
    expect((await stored(page)).priv).toBeUndefined();
    await page.locator('#toast button').click();
    await expect(page.locator('#main .notes-ix [data-act="openNote"]')).toHaveCount(2);
    expect((await stored(page)).priv).toBeTruthy();
    await settle(page, errors);
  });

  test('locks after 5 minutes without a touch and after a minute in the background', async ({page}) => {
    const errors = watchErrors(page);
    await page.clock.install();
    await openApp(page);
    await newNote(page, 'Tidslås', 'tekst');
    await makePrivate(page, PW, true);
    await page.clock.runFor(4 * 60000);
    await expect(page.locator('#main .note-full h2')).toContainText('Tidslås');
    await page.mouse.click(200, 600);   // a touch starts the wait again
    await page.clock.runFor(4 * 60000);
    await expect(page.locator('#main .note-full h2')).toContainText('Tidslås');
    await page.clock.runFor(70000);
    await expect(page.locator('#main .note-full h2')).toHaveText('Privat notat');
    // background: hidden for 60 s locks
    await page.locator('#main [data-act="privOpen"]').click();
    await pwOk(page, PW);
    await expect(page.locator('#main .note-full h2')).toContainText('Tidslås');
    const setHidden = h => page.evaluate(h => {
      Object.defineProperty(document, 'hidden', {configurable:true, get:() => h});
      Object.defineProperty(document, 'visibilityState', {configurable:true, get:() => h ? 'hidden' : 'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    }, h);
    await setHidden(true); await page.clock.runFor(30000); await setHidden(false);
    await expect(page.locator('#main .note-full h2')).toContainText('Tidslås');
    await setHidden(true); await page.clock.runFor(61000); await setHidden(false);
    await expect(page.locator('#main .note-full h2')).toHaveText('Privat notat');
    await settle(page, errors);
  });

  // 0.24.3, from the security review of 22 Nov: Angre puts back the copy taken before a change, but never a milder
  // wrong-password counter. The clock is paused so the 7 s Angre stays on screen through five slow password checks.
  test('Angre never resets the wrong-password wait (0.24.3)', async ({page}) => {
    const errors = watchErrors(page);
    await page.clock.install({time:new Date('2026-11-22T10:00:00')});
    await page.addInitScript(([key]) => {
      try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({v:2, std:{done:{}, modes:{}, light:{}, open:{}}, hidePacked:false, introDone:true,
        lists:[{id:'L1', name:'Tur', notes:'', modes:{}, cats:[{id:'k1', name:'K1', open:true, items:[{id:'a', text:'A', done:false}]}]}]})); } catch(e){}
    }, [KEY]);
    await openApp(page);
    await newNote(page, 'Låst notat', 'tekst');
    await makePrivate(page, PW, true);
    await page.locator('#main [data-act="back"]').click();
    await page.locator('#main .row-btns [data-act="privLockNow"]').click();
    await expect(page.locator('#main .notes-ix .priv-locked')).toHaveCount(1);
    await page.clock.pauseAt(new Date('2026-11-22T11:00:00'));
    const tick = ms => page.clock.runFor(ms || 150);
    const openLock = async () => { await page.locator('#main .row-btns [data-act="privOpen"]').click(); await tick(); await expect(sheet(page)).toBeVisible(); };
    const fiveWrong = async () => {
      await openLock();
      for (let i = 1; i <= 5; i++){
        await pwOk(page, 'galt-passord-' + i);
        await expect(page.locator('#pwSt')).toHaveText(i < 5 ? 'Feil passord.' : /For mange feil forsøk/);
      }
    };
    const waiting = async () => {
      const f = (await stored(page)).privFail;
      expect(f.n).toBeGreaterThanOrEqual(5);
      expect(f.until).toBeGreaterThan(new Date('2026-11-22T11:00:00').getTime());
    };
    // 1. a list renamed and closed with ✕ (Lagret, Angre), then five wrong passwords, then Angre: still waiting
    await goTab(page, 'list');
    await page.locator('#listBtn').click(); await tick();
    if (!(await page.locator('#main [data-la="rename"][data-id="L1"]').isVisible())) await page.locator('#main [data-sel="L1"]').click();
    await page.locator('#main [data-la="rename"][data-id="L1"]').click(); await tick();
    await page.locator('#askInput').fill('Tur til hytta');
    await page.locator('#overlay [data-sheet-close]').click(); await tick(300);
    await expect(page.locator('#toast')).toContainText('Lagret');
    await tick(1300);   // the toast fades and lets taps through; Angre stays
    await goTab(page, 'notes'); await tick();
    await fiveWrong();
    await page.keyboard.press('Escape'); await tick(300);
    await page.locator('#toast button').click(); await tick(300);
    await expect.poll(async () => (await stored(page)).lists[0].name).toBe('Tur');
    await waiting();
    await openLock();
    await pwOk(page, PW);
    await expect(page.locator('#pwSt')).toContainText('For mange feil forsøk');
    // 2. Glemt passordet deletes the notes and the counter; its Angre brings both back
    await page.locator('#overlay [data-s="forgot"]').click(); await tick();
    await expect(sheet(page)).toContainText('kan ikke hentes fram');
    await page.locator('#overlay [data-s="ok"]').click(); await tick(300);
    expect((await stored(page)).privFail).toBeUndefined();
    await tick(1300);
    await page.locator('#toast button').click(); await tick(300);
    await expect(page.locator('#main .notes-ix .priv-locked')).toHaveCount(1);
    await waiting();
    await openLock();
    await pwOk(page, PW);
    await expect(page.locator('#pwSt')).toContainText('For mange feil forsøk');
    // the wait still ends as before, and the right password then opens
    await page.keyboard.press('Escape'); await tick(300);
    await page.clock.runFor(31000);
    await openLock();
    await pwOk(page, PW);
    await expect(page.locator('#main .notes-ix')).toContainText('Låst notat');
    expect((await stored(page)).privFail).toBeUndefined();
    await settle(page, errors);
  });

  test('five wrong passwords give a wait that survives a reload', async ({page}) => {
    const errors = watchErrors(page);
    await page.clock.install();
    await openApp(page);
    await newNote(page, 'Ventetid', 'tekst');
    await makePrivate(page, PW, true);
    await goTab(page, 'list'); await page.locator('#hdrSet').click();
    await page.locator('#main [data-act="privLockNow"]').click();
    await goTab(page, 'notes');
    await page.locator('#main .notes-ix .priv-locked').click();
    await page.locator('#main [data-act="privOpen"]').click();
    for (let i = 1; i <= 5; i++){
      await pwOk(page, 'galt-passord-' + i);
      await expect(page.locator('#pwSt')).toHaveText(i < 5 ? 'Feil passord.' : /^For mange feil forsøk\. Prøv igjen om 30 sekunder\.$/);
    }
    // the right password is refused while waiting, also after a reload
    await pwOk(page, PW);
    await expect(page.locator('#pwSt')).toContainText('For mange feil forsøk');
    await page.reload();
    await page.locator('#main [data-act="privOpen"]').click();
    await pwOk(page, PW);
    await expect(page.locator('#pwSt')).toContainText('For mange feil forsøk');
    await page.clock.runFor(31000);
    await pwOk(page, PW);
    await expect(page.locator('#main .note-full h2')).toContainText('Ventetid');
    expect((await stored(page)).privFail).toBeUndefined();
    await settle(page, errors);
  });

  test('a password with æøå works in both Unicode forms', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await newNote(page, 'Unicode', 'tekst');
    await makePrivate(page, 'Blåbær på ' + 'heia', true);   // å composed (U+00E5)
    await goTab(page, 'list'); await page.locator('#hdrSet').click();
    await page.locator('#main [data-act="privLockNow"]').click();
    await goTab(page, 'notes');
    await page.locator('#main .notes-ix .priv-locked').click();
    await page.locator('#main [data-act="privOpen"]').click();
    await pwOk(page, 'Blåbær på heia');   // å as a + combining ring
    await expect(page.locator('#main .note-full h2')).toContainText('Unicode');
    await settle(page, errors);
  });

  test('a shared note with a password needs it on the other phone', async ({page, browser}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await newNote(page, 'Til Kari', 'møt meg ved varden');
    await page.evaluate(() => { window.__shared = null; navigator.share = async d => { window.__shared = d.url; window.__shareText = d.title + ' ' + d.text; }; });
    await page.locator('#main [data-act="noteShare"]').click();
    await expect(page.locator('#shPw')).toHaveAttribute('type', 'password');
    await page.locator('#shPw').fill('kort');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#shPwSt')).toHaveText('Minst 8 tegn.');
    await page.locator('#shPw').fill('fjelltur-2026');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect.poll(() => page.evaluate(() => window.__shared)).toContain('#note=e');
    const url = await page.evaluate(() => window.__shared);
    expect(url).not.toContain(Buffer.from('varden').toString('base64url').slice(0, 6));
    // build 71: the message beside a password link names nothing from the note
    const shText = await page.evaluate(() => window.__shareText);
    expect(shText).toContain('Et låst notat');
    expect(shText).not.toContain('Til Kari');
    // a private note: the password is required
    await makePrivate(page, PW, true);
    await page.locator('#main [data-act="noteShare"]').click();
    await expect(page.locator('#overlay label[for="shPw"]')).toHaveText('Passord for lenken');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#shPwSt')).toHaveText('Minst 8 tegn.');
    await page.locator('#overlay [data-s="cancel"], #overlay [data-sheet-close]').first().click();
    // the other phone: a wrong password adds nothing, the right one adds the note
    const ctx = await browser.newContext({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
    const p2 = await ctx.newPage(), err2 = watchErrors(p2);
    await p2.addInitScript(([key]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({lists:[], introDone:true})); } catch(e){} }, [KEY]);
    await p2.goto(url);
    await expect(p2.locator('#overlay h3')).toHaveText('Notatet er låst med passord');
    await pwOk(p2, 'feil-feil-feil');
    await expect(p2.locator('#pwSt')).toHaveText('Feil passord.');
    expect((await stored(p2)).notes || []).toEqual([]);
    await pwOk(p2, 'fjelltur-2026');
    await expect(p2.locator('#overlay .sh-prev')).toContainText('møt meg ved varden');
    await p2.locator('#overlay [data-s="ok"]').click();
    await expect(p2.locator('#main .note-full h2')).toHaveText('Til Kari');
    // build 71: the same link again, added as a private note (a password is created on this phone)
    await p2.goto('about:blank'); await p2.goto(url);
    await pwOk(p2, 'fjelltur-2026');
    await p2.locator('#overlay [data-s="priv"]').click();
    await expect(p2.locator('#overlay h3')).toHaveText('Lag passord for private notater');
    await pwOk(p2, 'mitt-eget-pw', true);
    await expect(p2.locator('#toast')).toContainText('privat og kryptert');
    const s2 = await stored(p2);
    expect(s2.notes.filter(n => n.priv).length).toBe(1);
    expect(JSON.stringify(s2.notes.filter(n => n.priv))).not.toContain('varden');
    await p2.waitForTimeout(300);
    expect(err2).toEqual([]);
    await ctx.close();
    await settle(page, errors);
  });

  test('backups: a password backup, private notes on a new phone and on a phone with another password', async ({page, browser}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await newNote(page, 'Privat A', 'innhold A');
    await makePrivate(page, PW, true);
    await newNote(page, 'Vanlig B', 'innhold B');
    await goTab(page, 'list'); await page.locator('#listBtn').click();
    await page.locator('[data-la="backup"]').click();
    const plainCopy = await page.locator('#bkOut').inputValue();
    expect(plainCopy).not.toContain('innhold A');   // private notes are always encrypted in a backup
    expect(plainCopy).toContain('innhold B');
    // the password: the buttons wait for Lås kopien
    await page.locator('#bkPwOn').check();
    await page.evaluate(() => { navigator.clipboard.writeText = async () => {}; });
    await page.locator('#bkCopy').click();
    await expect(page.locator('#bkStatus')).toContainText('Lås kopien først');
    await page.locator('#bkPw1').fill('kopi-passord'); await page.locator('#bkPw2').fill('kopi-passord');
    await page.locator('#bkPwLock').click();
    await expect(page.locator('#bkStatus')).toContainText('låst med passord');
    const locked = await page.locator('#bkOut').inputValue();
    expect(JSON.parse(locked).enc).toBe(1);
    expect(locked).not.toContain('innhold B');
    // a new phone: the locked backup needs its password; private notes come with the old private password
    const ctx = await browser.newContext({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
    const p2 = await ctx.newPage(), err2 = watchErrors(p2);
    await p2.addInitScript(([key]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({lists:[], introDone:true})); } catch(e){} }, [KEY]);
    await p2.goto('./');
    await p2.locator('#listBtn').click();
    await p2.locator('[data-la="backup"]').click();
    await p2.locator('#bkIn').fill(locked);
    await p2.locator('#bkRestore').click();
    await expect(p2.locator('#bkRPwMsg')).toHaveText('Sikkerhetskopien er låst med passord');
    await p2.locator('#bkRPw').fill('galt-galt'); await p2.locator('#bkRPwOk').click();
    await expect(p2.locator('#bkRPwSt')).toHaveText('Feil passord.');
    await p2.locator('#bkRPw').fill('kopi-passord'); await p2.locator('#bkRPwOk').click();
    await expect(p2.locator('#bkRStatus')).toContainText('1 notat');
    // build 71: the private notes wait for their password; the file's key is never taken over
    await expect(p2.locator('#bkRPwMsg')).toHaveText('Kopien har private notater. Skriv passordet deres for å ta dem med.');
    expect((await stored(p2)).priv).toBeUndefined();
    await p2.locator('#bkRPw').fill(PW); await p2.locator('#bkRPwOk').click();
    await expect(p2.locator('#bkRStatus')).toContainText('1 privat notat lagt til');
    const s2 = await stored(p2), file = JSON.parse(plainCopy);
    expect(s2.priv.salt).not.toBe(file.priv.salt);
    expect(s2.priv.wrap).not.toBe(file.priv.wrap);
    await p2.locator('[data-s="cancel"]').last().click();
    await goTab(p2, 'list'); await p2.locator('#hdrSet').click();
    await p2.locator('#main [data-act="privLockNow"]').click();
    await goTab(p2, 'notes');
    await expect(p2.locator('#main .notes-ix .priv-locked')).toHaveCount(1);
    await p2.locator('#main .notes-ix .priv-locked').click();
    await p2.locator('#main [data-act="privOpen"]').click();
    await pwOk(p2, PW);
    await expect(p2.locator('#main .note-full h2')).toContainText('Privat A');
    expect(err2).toEqual([]);
    await ctx.close();
    // a phone with another private password: asks for the backup's, then seals the notes with its own
    const ctx3 = await browser.newContext({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
    const p3 = await ctx3.newPage(), err3 = watchErrors(p3);
    await p3.addInitScript(([key]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({lists:[], introDone:true})); } catch(e){} }, [KEY]);
    await p3.goto('./');
    await newNote(p3, 'Eget', 'mitt eget');
    await makePrivate(p3, 'annet-passord', true);
    await goTab(p3, 'list'); await p3.locator('#hdrSet').click();
    await p3.locator('#main [data-act="privLockNow"]').click();
    await p3.locator('#main [data-act="back"]').click(); await p3.locator('#listBtn').click();   // from build 80: the backup stays on Dine lister
    await p3.locator('[data-la="backup"]').click();
    await p3.locator('#bkIn').fill(plainCopy);
    await p3.locator('#bkRestore').click();
    await expect(p3.locator('#bkRStatus')).toContainText('1 notat');
    await expect(p3.locator('#bkRPwMsg')).toContainText('annet passord');
    await p3.locator('#bkRPw').fill(PW); await p3.locator('#bkRPwOk').click();
    // this phone is locked: its own password is asked for next
    await expect(p3.locator('#overlay h3')).toHaveText('Lås opp private notater');
    await pwOk(p3, 'annet-passord');
    await expect(p3.locator('#toast')).toContainText('1 privat notat lagt til');
    const s3 = await stored(p3);
    expect(s3.notes.filter(n => n.priv).length).toBe(2);
    await goTab(p3, 'notes');
    await expect(p3.locator('#main .notes-ix')).toContainText('Privat A');
    // a second restore of the same notes adds nothing new
    expect(err3).toEqual([]);
    await ctx3.close();
    await settle(page, errors);
  });

  test('Utemodus and Regnlås never ask for the password', async ({browser}) => {
    const ctx = await browser.newContext({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}});
    const p = await ctx.newPage(), err = watchErrors(p);
    await p.addInitScript(([key]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({lists:[], introDone:true})); } catch(e){} }, [KEY]);
    await p.goto('./');
    await newNote(p, 'Felt', 'tekst');
    await makePrivate(p, PW, true);
    await goTab(p, 'list'); await p.locator('#hdrSet').click();
    await p.locator('#main [data-act="privLockNow"]').click();
    // Utemodus on through stored state, then reload
    await goTab(p, 'list');
    await p.locator('#main [data-act="fieldToggle"]').click();
    await goTab(p, 'notes');
    await p.locator('#main .notes-ix .priv-locked').click();
    await expect(p.locator('#main')).toContainText('Private notater åpnes utenfor Utemodus.');
    await expect(p.locator('#main [data-act="privOpen"]')).toHaveCount(0);
    await expect(p.locator('#overlay')).toBeHidden();
    // Regnlås: a tap anywhere changes nothing and opens no sheet
    await p.locator('#hdrLock').click();
    await expect(p.locator('body')).toHaveClass(/locked/);
    await p.mouse.click(200, 300);
    await expect(p.locator('#overlay')).toBeHidden();
    await p.waitForTimeout(200);
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- 0.22.1 (build 81): notes save themselves ---------- */
test.describe('notater lagrer 0.22.1', () => {
  test.use({locale:'nb-NO'});
  const stored = p => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const noteBy = async (p, ti) => (await stored(p)).notes.filter(n => n.title === ti);
  const toast = p => p.locator('#toast');
  const undo = p => p.locator('#toast button');
  // the phone sends the app to the background (or brings it back)
  const hidden = (p, on) => p.evaluate(on => { Object.defineProperty(document, 'hidden', {configurable:true, get:() => on}); Object.defineProperty(document, 'visibilityState', {configurable:true, get:() => on ? 'hidden' : 'visible'}); if (on) document.dispatchEvent(new Event('visibilitychange')); }, on);
  async function newNote(p, ti, tx){
    await p.locator('#main [data-act="newNote"]').click();
    // the sheet moves focus to the title 30 ms after it opens; filling before that can land the text in the title
    await expect(p.locator('#noteTitle')).toBeFocused();
    await p.locator('#noteTitle').fill(ti);
    await p.locator('#noteText').fill(tx);
  }
  async function openNote(p, ti){
    if (await p.locator('#main [data-act="back"]').count()) await p.locator('#main [data-act="back"]').click();
    await p.locator('#main .notes-ix [data-act="openNote"]', {hasText: ti}).click();
    await expect(p.locator('#main .note-full h2')).toContainText(ti);
  }
  async function editText(p, tx){
    await p.locator('#main .note-body').click();
    await p.locator('#neText').fill(tx);
  }

  test('back, a tab and the background save an edit; Avbryt throws it away with Angre', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await goTab(page, 'notes');
    await newNote(page, 'Alpha', 'første');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#main .note-body')).toHaveText('første');
    // the phone's back button saves, with Angre
    await editText(page, 'endret tekst');
    await page.goBack();
    await expect(page.locator('#main .notes-ix')).toBeVisible();
    await expect(toast(page)).toContainText('Lagret');
    await expect.poll(() => noteBy(page, 'Alpha').then(a => a[0] && a[0].text)).toBe('endret tekst');
    await undo(page).click();
    await expect.poll(async () => (await noteBy(page, 'Alpha'))[0].text).toBe('første');
    // another tab saves too
    await openNote(page, 'Alpha');
    await editText(page, 'via fane');
    await goTab(page, 'list');
    await expect.poll(() => noteBy(page, 'Alpha').then(a => a[0] && a[0].text)).toBe('via fane');
    // the page's own back button saves
    await goTab(page, 'notes');
    await openNote(page, 'Alpha');
    await editText(page, 'tilbakeknapp');
    await page.locator('#main [data-act="back"]').click();
    await expect(toast(page)).toContainText('Lagret');
    await expect.poll(() => noteBy(page, 'Alpha').then(a => a[0] && a[0].text)).toBe('tilbakeknapp');
    // Avbryt throws the change away; Angre saves it after all
    await openNote(page, 'Alpha');
    await editText(page, 'kastes');
    await page.locator('#main [data-act="noteCancel"]').click();
    await expect(page.locator('#main .note-body')).toHaveText('tilbakeknapp');
    await expect(toast(page)).toContainText('Endringene er forkastet');
    await undo(page).click();
    await expect(page.locator('#main .note-body')).toHaveText('kastes');
    // Avbryt with nothing changed says nothing
    await page.locator('#main .note-body').click();
    await page.locator('#main [data-act="noteCancel"]').click();
    await expect(toast(page)).toBeHidden();
    // the background saves at once and the edit stays open
    await editText(page, 'bakgrunn');
    await hidden(page, true);
    await expect.poll(() => noteBy(page, 'Alpha').then(a => a[0] && a[0].text)).toBe('bakgrunn');
    await hidden(page, false);
    await expect(page.locator('#neText')).toHaveValue('bakgrunn');
    await page.locator('#main [data-act="noteSave"]').click();
    await expect(page.locator('#main .note-body')).toHaveText('bakgrunn');
    await settle(page, errors);
  });

  test('Nytt notat: back, ✕ and a tap outside save; Avbryt throws away with Angre; the background writes it once', async ({page}) => {
    const errors = watchErrors(page);
    await openApp(page);
    await goTab(page, 'notes');
    // back saves and stays on the overview, Angre removes it
    await newNote(page, 'Beta', 'ny');
    await page.goBack();
    await expect(page.locator('#overlay')).toBeHidden();
    await expect(toast(page)).toContainText('Lagret');
    await expect(page.locator('#main .notes-ix')).toContainText('Beta');
    await expect.poll(() => noteBy(page, 'Beta').then(a => a.length)).toBe(1);
    await undo(page).click();
    await expect(page.locator('#main .notes-ix')).toHaveCount(0);
    await expect.poll(() => noteBy(page, 'Beta').then(a => a.length)).toBe(0);
    // ✕ and a tap outside save
    await newNote(page, 'Gamma', 'kryss');
    await page.locator('#overlay .sheet-x').click();
    await expect.poll(() => noteBy(page, 'Gamma').then(a => a.length)).toBe(1);
    await newNote(page, 'Omega', 'utenfor');
    await page.locator('#overlay').click({position:{x:10, y:10}});
    await expect(page.locator('#overlay')).toBeHidden();
    await expect.poll(() => noteBy(page, 'Omega').then(a => a.length)).toBe(1);
    // an empty sheet closed by back makes nothing
    const before = (await stored(page)).notes.length;
    await page.locator('#main [data-act="newNote"]').click();
    await page.goBack();
    await expect(page.locator('#overlay')).toBeHidden();
    await page.waitForTimeout(200);
    expect((await stored(page)).notes.length).toBe(before);
    // Avbryt throws it away; Angre makes the note and opens it
    await newNote(page, 'Delta', 'angret');
    await page.locator('#overlay [data-s="cancel"]').click();
    await expect.poll(() => noteBy(page, 'Delta').then(a => a.length)).toBe(0);
    await expect(toast(page)).toContainText('Endringene er forkastet');
    await undo(page).click();
    await expect(page.locator('#main .note-full h2')).toContainText('Delta');
    await expect.poll(() => noteBy(page, 'Delta').then(a => a.length)).toBe(1);
    // the background writes the note while the sheet stays open; Lagre then keeps one note
    await page.locator('#main [data-act="back"]').click();
    await newNote(page, 'Epsilon', 'først');
    await hidden(page, true);
    await expect.poll(() => noteBy(page, 'Epsilon').then(a => a.length)).toBe(1);
    await hidden(page, false);
    await expect(page.locator('#overlay')).toBeVisible();
    await page.locator('#noteText').fill('først og sist');
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#main .note-body')).toHaveText('først og sist');
    await expect.poll(() => noteBy(page, 'Epsilon').then(a => a.map(n => n.text))).toEqual(['først og sist']);
    // Avbryt after the background wrote it removes that copy too
    await page.locator('#main [data-act="back"]').click();
    await newNote(page, 'Zeta', 'bort');
    await hidden(page, true);
    await hidden(page, false);
    await expect.poll(() => noteBy(page, 'Zeta').then(a => a.length)).toBe(1);
    await page.locator('#overlay [data-s="cancel"]').click();
    await expect.poll(() => noteBy(page, 'Zeta').then(a => a.length)).toBe(0);
    await settle(page, errors);
  });

  test('a private note saved by back is sealed again, with no plain text in storage', async ({page}) => {
    const errors = watchErrors(page);
    const PW = 'blåbær-hytte-7';
    await openApp(page);
    await goTab(page, 'notes');
    await newNote(page, 'Hemmelig', 'gammel tekst');
    await page.locator('#overlay [data-s="ok"]').click();
    await page.locator('#main [data-act="notePriv"]').click();
    await expect(async () => {
      await page.locator('#pw1').fill(PW); await page.locator('#pw2').fill(PW);
      await expect(page.locator('#pw1')).toHaveValue(PW, {timeout:1000});
      await expect(page.locator('#pw2')).toHaveValue(PW, {timeout:1000});
    }).toPass({timeout:10000});
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(toast(page)).toContainText('privat og kryptert');
    const ct0 = (await stored(page)).notes[0].ct;
    await editText(page, 'ny hemmelig tekst');
    await page.goBack();
    await expect(toast(page)).toContainText('Lagret');
    await expect.poll(async () => (await stored(page)).notes[0].ct).not.toBe(ct0);
    const raw = await page.evaluate(k => localStorage.getItem(k), KEY);
    expect(raw).not.toContain('ny hemmelig');
    expect(raw).not.toContain('Hemmelig');
    await page.locator('#main .notes-ix [data-act="openNote"]').first().click();
    await expect(page.locator('#main .note-body')).toHaveText('ny hemmelig tekst');
    await settle(page, errors);
  });
});

/* ---------- 0.23.0 (build 82): from testing ----------
   The Utemodus sign grows into «Avslutt utemodus» over Regnlås (ends Utemodus on any page, not on a double tap, shrinks
   after 3 s, locked in Regnlås); in Utemodus the list name is a plain heading with a share button for own lists; the note
   overview has cards of one height with date, colour name and «Delt n×» / «Mottatt»; Dine lister in sections with the main
   list first; a colour wave through the list name when the app opens and after the main list changes. */
test.describe('fra testing 0.23', () => {
  const ctxFor = (browser, extra) => browser.newContext(Object.assign({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}}, extra || {}));
  const start = async (p, st) => {
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
    await p.goto('./');
    await expect(p.locator('#tabbar [data-tab]')).toHaveCount(5);
  };
  const stored = p => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const own = (id, name, extra) => Object.assign({id, name, notes:'', modes:{}, cats:[{id:'k' + id, name:'K', open:true, items:[{id:'a' + id, text:'A', done:false}]}]}, extra || {});
  const BASE = {v:2, std:{done:{}, modes:{}, light:{}, open:{}}, introDone:true, lang:'no'};

  test('Avslutt utemodus grows over Regnlås and ends Utemodus on any page', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[], field:true, listLock:true}));
    await p.locator('#tabbar [data-tab="guide"]').click();
    const pill = p.locator('#fieldEndBtn');
    await expect(pill).toBeHidden();
    await p.locator('#hdrField').click();
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('Avslutt utemodus');
    await expect(p.locator('#hdrField')).toHaveAttribute('aria-expanded', 'true');
    // it covers Regnlås and the sign, no further
    const rain = await p.locator('#hdrLock').boundingBox(), sign = await p.locator('#hdrField').boundingBox(), pb = await pill.boundingBox();
    expect(Math.abs(pb.x - rain.x)).toBeLessThan(2);
    expect(pb.x + pb.width).toBeGreaterThanOrEqual(sign.x + sign.width);
    // a double tap does not end it
    expect((await stored(p)).field).toBe(true);
    // it shrinks back after about 3 s
    await expect(pill).toBeHidden({timeout:5000});
    await expect(p.locator('#hdrField')).toHaveAttribute('aria-expanded', 'false');
    // a tap elsewhere closes it too
    await p.locator('#hdrField').click();
    await expect(pill).toBeVisible();
    await p.locator('#main').click({position:{x:20, y:300}});
    await expect(pill).toBeHidden();
    // the second tap ends Utemodus and stays on Guider
    await p.locator('#hdrField').click();
    await p.waitForTimeout(500);
    await pill.click();
    await expect.poll(async () => (await stored(p)).field).toBe(false);
    await expect(p.locator('#tabbar [data-tab="guide"]')).toHaveAttribute('aria-current', 'page');
    await expect(p.locator('#hdrSet')).toBeVisible();
    await expect(p.locator('#hdrField')).toBeHidden();
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('a fast second tap and Regnlås never end Utemodus', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[], field:true, listLock:true}));
    await p.locator('#hdrField').dblclick();
    await p.waitForTimeout(100);
    expect((await stored(p)).field).toBe(true);
    await expect(p.locator('#fieldEndBtn')).toBeVisible();
    await p.keyboard.press('Escape');
    await expect(p.locator('#fieldEndBtn')).toBeHidden();
    // Regnlås: the sign does nothing
    await p.locator('#hdrLock').click();
    await expect(p.locator('body')).toHaveClass(/locked/);
    await p.locator('#hdrField').click({force:true});
    await p.waitForTimeout(300);
    await expect(p.locator('#fieldEndBtn')).toBeHidden();
    expect((await stored(p)).field).toBe(true);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('Utemodus: the list name is a heading with a share button for own lists', async ({browser}) => {
    let ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[own('L1', 'Påsketur')], main:'L1', field:true, listLock:true}));
    await expect(p.locator('#main .field-listhead h2')).toHaveText('Påsketur');
    await expect(p.locator('#main .lists-row')).toHaveCount(0);
    const sh = p.locator('#main .field-listhead .share-btn');
    await expect(sh).toHaveAccessibleName('Del Påsketur');
    const box = await sh.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(48); expect(box.height).toBeGreaterThanOrEqual(48);
    await p.evaluate(() => { window.__shared = null; navigator.share = async d => { window.__shared = d.url || d.text; }; });
    await sh.click();
    await expect.poll(() => p.evaluate(() => window.__shared)).toContain('#share=');
    expect(err).toEqual([]);
    await ctx.close();
    // the standard list cannot be shared: no button
    ctx = await ctxFor(browser); p = await ctx.newPage(); err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[], field:true, listLock:true}));
    await expect(p.locator('#main .field-listhead h2')).toHaveText('Friluftsliv');
    await expect(p.locator('#main .field-listhead .share-btn')).toHaveCount(0);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('note overview: one height, date, colour name, Delt n× and Mottatt; sharing counts', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    const t0 = Date.UTC(2026, 10, 20);
    await start(p, Object.assign({}, BASE, {lists:[], noteColors:['Fiske', '', '', '', ''], notes:[
      {id:'n1', title:'En veldig lang tittel som ikke får plass på én linje i oversikten over notatene', text:'kort', t:t0},
      {id:'n2', title:'Fiskeplasser', text:'Ørret ved utløpet.\nPrøv flue om kvelden.\nHusk fiskekort.', t:t0, c:1, shT:t0, shN:3},
      {id:'n3', title:'Turplan', text:'Dag 1', t:t0, rcv:{n:'Kari', t:t0}},
      {id:'n4', title:'', text:'Kjøp plaster\nog sølvfolie', t:t0},
      {id:'n5', title:'Gammelt delt', text:'x', t:t0, shT:t0}
    ]}));
    await p.locator('#tabbar [data-tab="notes"]').click();
    const cards = p.locator('#main .notes-ix [data-act="openNote"]');
    await expect(cards).toHaveCount(5);
    const hs = await cards.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThanOrEqual(1);
    await expect(p.locator('#main .notes-ix .note-prev')).toHaveCount(0);
    await expect(cards.nth(1).locator('.note-meta')).toContainText('Fiske');
    await expect(cards.nth(1).locator('.note-meta')).toContainText('Delt 3×');
    await expect(cards.nth(2).locator('.note-meta')).toContainText('Mottatt');
    await expect(cards.nth(3).locator('.ix-t')).toHaveText('Kjøp plaster');
    await expect(cards.nth(4).locator('.note-meta')).toContainText('Delt');
    await expect(cards.nth(4).locator('.note-meta')).not.toContainText('×');
    // sharing counts up: Delt 3× becomes 4×
    await p.evaluate(() => { navigator.share = async () => {}; });
    await cards.nth(1).click();
    await p.locator('#main [data-act="noteShare"]').click();
    await p.locator('#overlay [data-s="ok"]').click();
    await expect.poll(async () => (await stored(p)).notes.find(n => n.id === 'n2').shN).toBe(4);
    await p.locator('#main [data-act="back"]').click();
    await expect(cards.nth(1).locator('.note-meta')).toContainText('Delt 4×');
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('Dine lister in sections, the main list first and not repeated', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[own('L1', 'Påsketur'), own('L2', 'Dagstur'), own('L3', 'Fra Kari', {sharedIn:true})], main:'L1'}));
    await p.locator('#listBtn').click();
    expect((await p.locator('#main .sec-lbl').allTextContents()).map(x => x.trim())).toEqual(['Hovedliste', 'Standardliste', 'Dine egne lister', 'Delte lister', 'Sikkerhetskopi']);
    await expect(p.locator('#main .pg-sec').first().locator('.lc-name')).toHaveText('Påsketur');
    await expect(p.locator('#main .lc-name', {hasText:'Påsketur'})).toHaveCount(1);
    await expect(p.locator('#main .pg-sec').nth(2).locator('[data-la="new"]')).toBeVisible();
    await expect(p.locator('#main .pg-sec').last().locator('[data-la="backup"]')).toHaveText('Ta kopi eller gjenopprett');
    await expect(p.locator('#main [data-act="openSettings"]')).toHaveCount(0);
    expect(err).toEqual([]);
    await ctx.close();
  });

  test('the list name breathes each time Pakkliste comes on screen and when the mode changes, not on redraws (0.23.1, 0.23.2)', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    const on = () => expect(p.locator('#listName.breathe')).toHaveCount(1);
    const off = () => expect(p.locator('#listName.breathe')).toHaveCount(0, {timeout:4500});
    await start(p, Object.assign({}, BASE, {lists:[own('L1', 'Påsketur')]}));
    await on(); await off();
    // ticking an item redraws the page: no breath
    await p.locator('#main .cat-head').first().click();
    await p.locator('#main .item .check').first().click();
    await p.waitForTimeout(100);
    await expect(p.locator('#listName.breathe')).toHaveCount(0);
    // the Pakkliste tab from another tab
    await p.locator('#tabbar [data-tab="guide"]').click();
    await expect(p.locator('#listName.breathe')).toHaveCount(0);
    await p.locator('#tabbar [data-tab="list"]').click();
    await on(); await off();
    // a new main list: the breath when Pakkliste shows it
    await p.locator('#listBtn').click();
    await expect(p.locator('#listName.breathe')).toHaveCount(0);
    await p.locator('#main [data-sel="L1"]').click();
    await p.locator('#main [data-role="main"][data-id="L1"]').click();
    await p.locator('#main [data-act="back"]').click();
    await expect(p.locator('#listName')).toHaveText('Påsketur');
    await on(); await off();
    // in Utemodus the header says Pakkliste, and the list name heading on the page breathes instead
    await p.locator('#main [data-act="fieldToggle"]').click();
    await p.waitForTimeout(100);
    await expect(p.locator('#listName.breathe')).toHaveCount(0);
    await expect(p.locator('#main .field-listhead h2.breathe')).toHaveCount(1);   // 0.23.2: switching mode shows the name anew, so it breathes
    await expect(p.locator('#main .field-listhead h2.breathe')).toHaveCount(0, {timeout:4500});
    await p.locator('#tabbar [data-tab="notes"]').click();
    await p.locator('#tabbar [data-tab="list"]').click();
    await expect(p.locator('#main .field-listhead h2.breathe')).toHaveCount(1);
    await expect(p.locator('#listName.breathe')).toHaveCount(0);
    await expect(p.locator('#main .field-listhead h2.breathe')).toHaveCount(0, {timeout:4500});
    // Utemodus off again: the header breathes (0.23.2); then the app back from the background: no breath
    await p.locator('#main [data-act="fieldToggle"]').click();
    await on(); await off();
    await p.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(100);
    await expect(p.locator('#listName.breathe')).toHaveCount(0);
    expect(err).toEqual([]);
    await ctx.close();
  });
});

/* ---------- 0.23.2 (build 84): every note asks before it is deleted ---------- */
test.describe('notater slettes 0.23.2', () => {
  test.use({locale:'nb-NO'});
  test('an ordinary note asks before it is deleted; Avbryt keeps it, Slett deletes with Angre', async ({page}) => {
    const errors = watchErrors(page);
    await page.addInitScript(k => { if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({v:2, introDone:true, lang:'no', lists:[], notes:[{id:'n1', title:'Handleliste', text:'gass', t:Date.UTC(2026, 10, 20)}]})); }, KEY);
    await page.goto('./');
    await page.locator('#tabbar [data-tab="notes"]').click();
    await page.locator('#main .notes-ix [data-act="openNote"]').first().click();
    await page.locator('#main [data-act="delNote"]').click();
    await expect(page.locator('#overlay h3')).toHaveText('Slette notatet?');
    await expect(page.locator('#overlay p')).toHaveText('Du kan angre rett etterpå, men ikke senere.');
    await page.locator('#overlay [data-s="cancel"]').click();
    await expect(page.locator('#main .note-full h2')).toContainText('Handleliste');
    expect((await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY)).notes).toHaveLength(1);
    await page.locator('#main [data-act="delNote"]').click();
    await page.locator('#overlay [data-s="ok"]').click();
    await expect(page.locator('#toast')).toContainText('slettet');
    await expect.poll(async () => (await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY)).notes.length).toBe(0);
    await page.locator('#toast button').click();
    await expect(page.locator('#main .notes-ix [data-act="openNote"]')).toHaveCount(1);
    await settle(page, errors);
  });
});

/* ---------- 0.23.3 (build 85): the app icon ----------
   The icons are built by tools/make-icons.js from a landscape in design/icons; this checks the files are in place. */
test.describe('appikon 0.23.3', () => {
  const ROOT = require('path').join(__dirname, '..');
  const pngSize = f => { const b = require('fs').readFileSync(require('path').join(ROOT, f)); expect(b.slice(1, 4).toString(), f + ' is a PNG').toBe('PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  test('the manifest icons and the Apple icon exist with the right sizes', () => {
    const m = JSON.parse(require('fs').readFileSync(require('path').join(ROOT, 'manifest.webmanifest'), 'utf8'));
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
    for (const ic of m.icons){ const [w, h] = pngSize(ic.src); expect(`${w}x${h}`, ic.src).toBe(ic.sizes); }
    expect(m.icons.some(ic => ic.purpose === 'maskable')).toBe(true);
    expect(pngSize('apple-touch-icon.png')).toEqual([180, 180]);
  });
  test('icon.svg is the tab icon and loads', async ({page}) => {
    const errors = watchErrors(page);
    await page.goto('./');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', 'icon.svg');
    const r = await page.request.get('./icon.svg');
    expect(r.status()).toBe(200);
    expect(await r.text()).toContain('<svg');
    await settle(page, errors);
  });
  test('every icon variant has its landscape file', () => {
    const src = require('fs').readFileSync(require('path').join(ROOT, 'tools', 'make-icons.js'), 'utf8');
    const names = Object.keys(eval('(' + src.match(/const VARIANTS = (\{[^}]*\})/)[1] + ')'));
    expect(names).toContain(src.match(/const ACTIVE = '([a-z]+)'/)[1]);
    for (const n of names) expect(require('fs').existsSync(require('path').join(ROOT, 'design', 'icons', `landscape-${n}.svg`)), n).toBe(true);
  });
});

/* ---------- 0.24.0 (build 87): from testing, 22 Nov ----------
   Typing saves itself everywhere (Rediger sheets, «Legg til en ting», Sekkvekt, links), the note's icon buttons,
   «Lagret» at the top with a fading box, and the position button and its age line on Kompass. */
test.describe('fra testing 0.24', () => {
  const ctxFor = (browser, extra) => browser.newContext(Object.assign({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}}, extra || {}));
  const start = async (p, st) => {
    await p.addInitScript(([key, s]) => { try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(s)); } catch(e){} }, [KEY, st]);
    await p.goto('./');
    await expect(p.locator('#tabbar [data-tab]')).toHaveCount(5);
  };
  const stored = p => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const hidden = (p, on) => p.evaluate(on => { Object.defineProperty(document, 'hidden', {configurable:true, get:() => on}); Object.defineProperty(document, 'visibilityState', {configurable:true, get:() => on ? 'hidden' : 'visible'}); if (on) document.dispatchEvent(new Event('visibilitychange')); }, on);
  const BASE = {v:2, std:{done:{}, modes:{}, light:{}, open:{}}, introDone:true, lang:'no'};
  const LIST = () => Object.assign({}, BASE, {lists:[{id:'L1', name:'Test', notes:'', modes:{}, cats:[{id:'k1', name:'K1', open:true, items:[{id:'a', text:'A', done:false}, {id:'b', text:'B', done:false}]}]}]});
  const items = async p => (await stored(p)).lists[0].cats[0].items.map(i => i.text);
  const toast = p => p.locator('#toast');
  async function rediger(p){
    // from Pakkliste through the header; Ferdig returns to Dine lister, where the header is a plain title
    if (!(await p.locator('#main [data-sel="L1"]').count())) await p.locator('#listBtn').click();
    if (!(await p.locator('#main [data-la="edit"][data-id="L1"]').isVisible())) await p.locator('#main [data-sel="L1"]').click();
    await p.locator('#main [data-la="edit"][data-id="L1"]').click();
    await expect(p.locator('#main .edit-bar')).toBeVisible();
  }

  test('Rediger: a sheet closed with Escape or ✕ saves, Avbryt throws away, both with Angre', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, LIST());
    await rediger(p);
    const rename = async (id, v) => { await p.locator(`#main li.item[data-item="${id}"] [data-act="renameItem"]`).click(); await expect(p.locator('#askInput')).toBeFocused(); await p.locator('#askInput').fill(v); };
    // Escape saves, with «Lagret», the check mark and Angre
    await rename('a', 'Alfa'); await p.keyboard.press('Escape');
    await expect.poll(() => items(p)).toEqual(['Alfa', 'B']);
    await expect(toast(p)).toContainText('Lagret'); await expect(toast(p).locator('.ok-ic')).toHaveCount(1);
    await toast(p).locator('button').click();
    await expect.poll(() => items(p)).toEqual(['A', 'B']);
    // ✕ saves too
    await rename('a', 'Alfa'); await p.locator('#overlay [data-sheet-close]').click();
    await expect.poll(() => items(p)).toEqual(['Alfa', 'B']);
    // Avbryt with a change throws it away; its Angre applies it after all
    await rename('b', 'Beta'); await p.locator('#overlay [data-s="cancel"]').click();
    await expect(toast(p)).toContainText('Endringene er forkastet');
    expect(await items(p)).toEqual(['Alfa', 'B']);
    await toast(p).locator('button').click();
    await expect.poll(() => items(p)).toEqual(['Alfa', 'Beta']);
    // closing without a change makes no message and changes nothing
    await p.waitForTimeout(100); await p.evaluate(() => { document.getElementById('toast').hidden = true; });
    await rename('a', 'Alfa'); await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    await expect(toast(p)).toBeHidden();
    // Ny kategori closed with Escape makes the category
    await p.locator('#main [data-act="addCat"]').click(); await p.locator('#askInput').fill('Kjøkken'); await p.keyboard.press('Escape');
    await expect.poll(async () => (await stored(p)).lists[0].cats.map(c => c.name)).toEqual(['K1', 'Kjøkken']);
    // the background saves an open sheet as if it were closed
    await p.locator('#main [data-act="renameCat"]').first().click(); await p.locator('#askInput').fill('Klær');
    await hidden(p, true);
    await expect.poll(async () => (await stored(p)).lists[0].cats[0].name).toBe('Klær');
    await expect(p.locator('#overlay')).toBeHidden();
    await hidden(p, false);
    await settle(p, err); await ctx.close();
  });

  test('Rediger: text in «Legg til en ting» survives redraws and is added on Ferdig, another tab and the background', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, LIST());
    await rediger(p);
    const add = p.locator('#main [data-add="k1"]');
    await add.fill('Kniv');
    // a redraw (indent another row) keeps the text
    await p.locator('#main li.item[data-item="b"] [data-act="indentItem"]').click();
    await expect(add).toHaveValue('Kniv');
    expect(await items(p)).toEqual(['A', 'B']);
    // Ferdig adds it, with Lagret and Angre
    await p.locator('#main .edit-bar [data-act="back"]').click();
    await expect.poll(() => items(p)).toEqual(['A', 'B', 'Kniv']);
    await expect(toast(p)).toContainText('Lagret');
    await toast(p).locator('button').click();
    await expect.poll(() => items(p)).toEqual(['A', 'B']);
    // another tab adds it
    await rediger(p);
    await add.fill('Sag');
    await p.locator('#tabbar [data-tab="guide"]').click();
    await expect.poll(() => items(p)).toEqual(['A', 'B', 'Sag']);
    // the background adds it and Rediger stays open with an empty field
    await p.locator('#tabbar [data-tab="list"]').click();
    await rediger(p);
    await add.fill('Øks');
    await hidden(p, true);
    await expect.poll(() => items(p)).toEqual(['A', 'B', 'Sag', 'Øks']);
    await hidden(p, false);
    await expect(p.locator('#main .edit-bar')).toBeVisible();
    await expect(add).toHaveValue('');
    await settle(p, err); await ctx.close();
  });

  test('Sekkvekt and links save themselves; a link needs a real address', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[]}));
    await p.locator('#tabbar [data-tab="plan"]').click();
    await p.locator('#main [data-open="weight"]').click();
    // the sheet moves focus to the name field 30 ms after it opens; filling before that can land the text in the name
    await p.locator('#main [data-act="wAddOwn"]').click(); await expect(p.locator('#wName')).toBeFocused();
    await p.locator('#wName').fill('Telt'); await p.locator('#wG').fill('1800');
    await p.keyboard.press('Escape');
    await expect.poll(async () => ((await stored(p)).packW || {items:[]}).items.map(i => i.name + ':' + i.g)).toEqual(['Telt:1800']);
    await expect(toast(p)).toContainText('Lagret');
    // a nameless item is never made
    await p.locator('#main [data-act="wAddOwn"]').click(); await expect(p.locator('#wName')).toBeFocused(); await p.locator('#wG').fill('50'); await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    expect((await stored(p)).packW.items).toHaveLength(1);
    // links: the address step closed with only «https://» saves nothing; with an address it saves
    await p.locator('#tabbar [data-tab="compass"]').click();
    await p.locator('#main [data-act="addLink"]').click(); await p.locator('#askInput').fill('Vær'); await p.locator('#overlay [data-s="ok"]').click();
    await expect(p.locator('#askInput')).toHaveValue('https://'); await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    expect((await stored(p)).links || []).toHaveLength(0);
    await p.locator('#main [data-act="addLink"]').click(); await p.locator('#askInput').fill('Vær'); await p.locator('#overlay [data-s="ok"]').click();
    await p.locator('#askInput').fill('https://www.yr.no'); await p.keyboard.press('Escape');
    await expect.poll(async () => ((await stored(p)).links || []).map(l => l.n + ' ' + l.u)).toEqual(['Vær https://www.yr.no']);
    await settle(p, err); await ctx.close();
  });

  test('a note: icon buttons in one row, no Rediger, a tap edits, an empty note invites writing', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[], notes:[{id:'n1', title:'Fiske', text:'Ørret', t:Date.UTC(2026, 10, 20)}, {id:'n2', title:'Tom', text:'', t:Date.UTC(2026, 10, 21)}]}));
    await p.locator('#tabbar [data-tab="notes"]').click();
    await p.locator('#main .notes-ix [data-act="openNote"]', {hasText:'Fiske'}).click();
    const acts = p.locator('#main .note-acts button');
    await expect(acts).toHaveCount(4);
    await expect(acts.locator('span')).toHaveText(['Fest', 'Del', 'Privat', 'Slett']);
    await expect(p.locator('#main .note-acts [data-act="editNote"], #main .row-btns [data-act="editNote"]')).toHaveCount(0);
    // one row, equal widths, each at least 48 px high
    const boxes = await Promise.all([0, 1, 2, 3].map(i => acts.nth(i).boundingBox()));
    expect(new Set(boxes.map(b => Math.round(b.y))).size).toBe(1);
    expect(Math.max(...boxes.map(b => b.width)) - Math.min(...boxes.map(b => b.width))).toBeLessThan(2);
    boxes.forEach(b => expect(b.height).toBeGreaterThanOrEqual(48));
    await expect(acts.nth(2)).toHaveAttribute('aria-label', 'Gjør privat');
    // Fest: pressed and «Løsne»
    await acts.nth(0).click();
    await expect(acts.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(acts.nth(0).locator('span')).toHaveText('Løsne');
    // a tap on the text edits in place
    await p.locator('#main .note-body').click();
    await expect(p.locator('#neText')).toBeVisible();
    await p.locator('#main [data-act="back"]').click();
    // an empty note says «Trykk for å skrive», and a tap opens the text field
    await p.locator('#main .notes-ix [data-act="openNote"]', {hasText:'Tom'}).click();
    await expect(p.locator('#main .note-body .note-ph')).toHaveText('Trykk for å skrive');
    await p.locator('#main .note-body').click();
    await expect(p.locator('#neText')).toBeFocused();
    await expect(p.locator('#neText')).toHaveValue('');
    await settle(p, err); await ctx.close();
  });

  test('«Lagret» sits under the header; the box fades, the words and Angre stay, and taps reach the page', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[], notes:[{id:'n1', title:'Fiske', text:'Ørret', t:Date.UTC(2026, 10, 20)}]}));
    await p.locator('#tabbar [data-tab="notes"]').click();
    await p.locator('#main .notes-ix [data-act="openNote"]').click();
    await p.locator('#main .note-body').click(); await p.locator('#neText').fill('Ørret og røye');
    await p.locator('#main [data-act="back"]').click();
    await expect(toast(p)).toHaveText(/^\s*Lagret\s*Angre\s*$/);
    const hb = await p.locator('header.top').boundingBox(), tb = await toast(p).boundingBox();
    expect(tb.y).toBeGreaterThanOrEqual(hb.y + hb.height);
    expect(tb.y).toBeLessThan(hb.y + hb.height + 30);
    await expect(toast(p)).not.toHaveClass(/faded/);
    await expect(toast(p)).toHaveClass(/faded/, {timeout:3000});
    // the box is gone: a tap on the page under it reaches the page; Angre still works
    await expect.poll(() => toast(p).evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(\d+, \d+, \d+, 0\)|transparent/);
    const hit = await toast(p).evaluate(el => { const r = el.getBoundingClientRect(); const x = document.elementFromPoint(r.left + 10, r.top + r.height / 2); return !!(x && x.closest('#toast')); });
    expect(hit).toBe(false);
    await toast(p).locator('button').click();
    await expect.poll(async () => (await stored(p)).notes[0].text).toBe('Ørret');
    await settle(p, err); await ctx.close();
  });
  test('in English the message says «Saved»', async ({browser}) => {
    const ctx = await ctxFor(browser, {locale:'en-GB'}), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lang:'en', lists:[], notes:[{id:'n1', title:'Fish', text:'Trout', t:Date.UTC(2026, 10, 20)}]}));
    await p.locator('#tabbar [data-tab="notes"]').click();
    await p.locator('#main .notes-ix [data-act="openNote"]').click();
    await p.locator('#main .note-body').click(); await p.locator('#neText').fill('Trout and char');
    await p.locator('#main [data-act="back"]').click();
    await expect(toast(p)).toContainText('Saved');
    await settle(p, err); await ctx.close();
  });

  test('Kompass: the position button fetches, the line says how old the position is, red after 24 hours', async ({browser}) => {
    const ctx = await ctxFor(browser, {geolocation:{latitude:58.97, longitude:5.73, accuracy:10}, permissions:['geolocation']}), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {lists:[]}));
    await p.locator('#tabbar [data-tab="compass"]').click();
    const btn = p.locator('#main .c-sky .c-pos'), line = p.locator('#cPosLine');
    await expect(line).toContainText('Ingen posisjon. Trykk');
    await expect(line.locator('svg')).toHaveCount(1);
    await expect(btn).toHaveAttribute('aria-label', 'Hent posisjon (GPS)');
    await btn.click();
    await expect(line).toContainText('Posisjon hentet i dag');
    await expect(line).not.toHaveClass(/old/);
    await expect(btn).toHaveAttribute('aria-label', 'Oppdater posisjon');
    await settle(p, err); await ctx.close();
  });
  test('Kompass: a position older than 24 hours turns the line and the button red, and fetching makes it fresh', async ({browser}) => {
    const ctx = await ctxFor(browser, {geolocation:{latitude:58.97, longitude:5.73, accuracy:10}, permissions:['geolocation']}), p = await ctx.newPage(), err = watchErrors(p);
    const old = Date.now() - 4 * 864e5 - 3600e3;
    await start(p, Object.assign({}, BASE, {lists:[], pos:{lat:60.39, lon:5.32, acc:12, t:old}}));
    await p.locator('#tabbar [data-tab="compass"]').click();
    const btn = p.locator('#main .c-sky .c-pos'), line = p.locator('#cPosLine');
    await expect(line).toContainText('4 døgn gammel');
    await expect(line).toHaveClass(/old/);
    await expect(btn).toHaveClass(/old/);
    // fetching makes it fresh again
    await btn.click();
    await expect(line).toContainText('Posisjon hentet i dag');
    await expect(btn).not.toHaveClass(/old/);
    await settle(p, err); await ctx.close();
  });
});

/* ---------- 0.24.1 (build 88): the landscape that closes Innstillinger ---------- */
test.describe('landskap 0.24.1', () => {
  for (const L of [{lang:'no', locale:'nb-NO', txt:'Bakgrunnen nederst viser Rondeslottet sett fra Tron.'}, {lang:'en', locale:'en-GB', txt:'The landscape at the bottom shows Rondeslottet seen from Tron.'}]){
    test(`Innstillinger ends with the ridges, under the version line, with no text over them (${L.locale})`, async ({browser}) => {
      const ctx = await browser.newContext({locale:L.locale, serviceWorkers:'block', viewport:{width:390, height:780}}), p = await ctx.newPage(), err = watchErrors(p);
      await p.addInitScript(([k, lang]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({v:2, introDone:true, lang, lists:[]})); }, [KEY, L.lang]);
      await p.goto('./');
      await p.locator('#hdrSet').click();
      const land = p.locator('#main .land');
      await expect(land).toHaveCount(1);
      await expect(land).toHaveAttribute('aria-hidden', 'true');
      await expect(land.locator('path')).toHaveCount(6);
      await expect(p.locator('#main')).toContainText(L.txt);
      // the last thing on the page, below the version line; the page does not get wider than the screen
      expect(await p.evaluate(() => document.querySelector('#main').lastElementChild.classList.contains('land'))).toBe(true);
      await land.scrollIntoViewIfNeeded();
      const v = await p.locator('#main .app-ver').boundingBox(), b = await land.boundingBox();
      expect(b.y).toBeGreaterThanOrEqual(v.y + v.height);
      expect(b.x).toBeLessThanOrEqual(1);
      expect(b.width).toBeGreaterThanOrEqual(388);
      expect(b.height).toBeGreaterThan(180);
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      // every peak is whole: the top of the drawing is inside the box
      const top = await land.locator('svg').evaluate(svg => { const g = svg.querySelector('g'), bb = g.getBBox(), m = g.transform.baseVal.consolidate().matrix; return [svg.viewBox.baseVal.y, bb.y * m.d + m.f]; });
      expect(top[1]).toBeGreaterThan(top[0]);
      await settle(p, err); await ctx.close();
    });
  }
});

/* ---------- 0.24.2 (build 89): the ridges in the right order, rising one by one, and the landscape under a note ---------- */
test.describe('landskap 0.24.2', () => {
  const ctxFor = (browser, extra) => browser.newContext(Object.assign({locale:'nb-NO', serviceWorkers:'block', viewport:{width:390, height:780}}, extra || {}));
  const start = async (p, st) => {
    await p.addInitScript(([k, s]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(s)); }, [KEY, st]);
    await p.goto('./');
    await expect(p.locator('#tabbar [data-tab]')).toHaveCount(5);
  };
  const BASE = {v:2, introDone:true, lang:'no', lists:[]};
  const lum = c => { const m = c.match(/[\d.]+/g).map(Number); return .2126 * m[0] + .7152 * m[1] + .0722 * m[2]; };
  const fills = land => land.locator('path').evaluateAll(ps => ps.map(x => getComputedStyle(x).fill));

  for (const scheme of ['light', 'dark']){
    test(`the near ridges are the darkest, as in the icon (${scheme})`, async ({browser}) => {
      const ctx = await ctxFor(browser, {colorScheme:scheme, reducedMotion:'reduce'}), p = await ctx.newPage(), err = watchErrors(p);
      await start(p, BASE);
      await p.locator('#hdrSet').click();
      const f = (await fills(p.locator('#main .land'))).map(lum);
      // from Rondeslottet (back) to the foreground the ridges get darker, step by step
      for (let i = 1; i < f.length; i++) expect(f[i], `ridge ${i} darker than ridge ${i - 1}: ${f}`).toBeLessThan(f[i - 1]);
      await settle(p, err); await ctx.close();
    });
  }

  test('Innstillinger: only the two back ridges until the landscape is on screen, then the four in front rise one by one', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, BASE);
    await p.locator('#hdrSet').click();
    const land = p.locator('#main .land.rise'), op = () => land.locator('.lr').evaluateAll(gs => gs.map(g => +getComputedStyle(g).opacity));
    await expect(land).toHaveCount(1);
    expect(await op()).toEqual([1, 1, 0, 0, 0, 0]);
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await expect(land).toHaveClass(/\bup\b/);
    // one after another: soon after, the first in front is on its way while the last has not started
    await p.waitForTimeout(700);
    let o = await op(); expect(o[2]).toBeGreaterThan(.5); expect(o[5]).toBeLessThan(.2);
    await expect.poll(async () => (await op()).every(x => x > .99), {timeout:6000}).toBe(true);
    // out of view, they sink back, so it plays again next time
    await p.evaluate(() => scrollTo(0, 0));
    await expect(land).not.toHaveClass(/\bup\b/);
    await settle(p, err); await ctx.close();
  });

  test('with reduce motion all ridges stand from the start', async ({browser}) => {
    const ctx = await ctxFor(browser, {reducedMotion:'reduce'}), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, BASE);
    await p.locator('#hdrSet').click();
    expect(await p.locator('#main .land .lr').evaluateAll(gs => gs.map(g => +getComputedStyle(g).opacity))).toEqual([1, 1, 1, 1, 1, 1]);
    await settle(p, err); await ctx.close();
  });

  test('a note ends with the landscape, still; the edit has none', async ({browser}) => {
    const ctx = await ctxFor(browser), p = await ctx.newPage(), err = watchErrors(p);
    await start(p, Object.assign({}, BASE, {notes:[{id:'n1', title:'Fiske', text:'Ørret', t:Date.UTC(2026, 10, 20)}]}));
    await p.locator('#tabbar [data-tab="notes"]').click();
    await p.locator('#main .notes-ix [data-act="openNote"]').click();
    const land = p.locator('#main .land');
    await expect(land).toHaveCount(1);
    await expect(land).not.toHaveClass(/rise/);
    expect(await land.locator('.lr').evaluateAll(gs => gs.map(g => +getComputedStyle(g).opacity))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await p.evaluate(() => document.querySelector('#main').lastElementChild.classList.contains('land'))).toBe(true);
    const a = await p.locator('#main .note-acts').boundingBox(), b = await land.boundingBox();
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    await p.locator('#main .note-body').click();
    await expect(p.locator('#neText')).toBeVisible();
    await expect(land).toHaveCount(0);
    await settle(p, err); await ctx.close();
  });
});
