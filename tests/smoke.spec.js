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
        await page.locator(`#main [data-open="${k}"]`).click();
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
        await page.locator(`#main [data-open="${k}"]`).click();
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
      await expect(page.locator('#main [data-open]').first()).toBeVisible();
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
          await page.locator(`#main [data-open="${k}"]`).click();
          const heads = (await page.locator('#main details > summary').allInnerTexts()).map(x => x.split('\n').map(y => y.trim()).filter(Boolean)[0]);
          out[k] = {first:heads[0], n:heads.length};
          await page.locator('#main .back').click();
        }
        return out;
      };
      const before = await readGuides();
      // switch to the other language on Dine lister
      const other = L.lang === 'no' ? 'en' : 'no';
      await goTab(page, 'list');
      await page.locator('#listBtn').click();
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
        await page.locator(`#main [data-open="${k}"]`).click();
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
      await page.locator('#listBtn').click();
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

    test('tapping the current tab scrolls to the top', async ({page}) => {
      const all = page.locator('#main [data-act="foldAll"]');
      if (await all.getAttribute('aria-expanded') !== 'true') await all.click();
      for (const k of ['list', 'guide']){
        await goTab(page, k);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(() => page.evaluate(() => window.scrollY), `${k} page is long enough to scroll`).toBeGreaterThan(100);
        await page.locator(`#tabbar [data-tab="${k}"]`).click();
        await expect.poll(() => page.evaluate(() => window.scrollY), `${k} scrolls to the top`).toBe(0);
      }
      await settle(page, errors);
    });
  });
}
