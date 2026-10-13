# Varde – project notes for Claude Code

Varde (working name, may change) is an offline web app (PWA) for planning and packing outdoor trips: day hikes and shorter multi-day hikes with tent or under the open sky. Owner: Svein Atle. Published with GitHub Pages from the `main` branch, root folder.

## Files
- `index.html` – the whole app (HTML, CSS and JavaScript in one file). No build step, no external dependencies apart from Google Fonts.
- `sw.js` – service worker that makes the app work offline. Contains the cache version `CACHE`.
- `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` – installation on the phone.
- `README.md` – short user guide (Norwegian).

## Structure of index.html
- `UI` – all interface text, in `en` and `no`. Every new string must be added in both.
- `friluftsliv(L)` – the template list, written as `[Norwegian, English]` pairs. Prefixes in item strings: `> ` = sub-item, `* ` = included in the light day-hike view, `@key ` = links to a bag list.
- Main sections, trip modes (`mode:`), and bag lists (`bag:true`: Forberedelser, Førstehjelpssett, Reparasjonssett, Personlig pleie). A non-sub item followed by sub-items is rendered as a subheading and is not counted.
- `MODES` (trip types), `CAT_ICONS` (section icons), `SKINS` (Fjell, Mose, Fjord, Sommereng).
- Tabs: Pakkliste, Planlegg (Mat, Drivstoff, Vannblanding), Guider (Knuter, Solbriller, Mobilen på tur), Kompass.
- Utemodus (outdoor mode): larger targets, editing locked, screen kept on, strict tap filter, Regnlås (rain lock), Nattlys (red night light), Angre (undo).
- Data is stored in `localStorage` under `KEY`.

## Data model (from varde-v7)
- `state.v = 2`. Older stored data is converted once by `migrate()`; lists that match the built-in template become the standard list (ticks, trip types and views kept), anything else is kept as an own list. Never remove the migration.
- **Standard list:** built from `friluftsliv(lang)` on the fly by `stdList()`, always in the app language. Its ticks, trip types, light view and folded sections live in `state.std` (`done`, `modes`, `light`, `open`). Item ids are `std:<section key>:<Norwegian text in lower case>`, so ticks survive a language switch; changing the Norwegian text of a template item resets that item's tick.
- **Own lists:** `state.lists`. `state.main` is `'std'` or the id of the own list shown on the front page (Bruk som hovedliste). `list.tripType` makes it appear under Turtype (Legg til i turtype). The two roles rule each other out: making a list the main list switches its trip type off, and making the main list a trip type, or switching its main role off, falls back to the standard list; switching it on stores `'L:<list id>'` in the main list's `modes`, and its sections are added to the main list.
- Always change ticks, folding and light view through `setDone`, `setOpen` and `setLight`, which handle both kinds of list.
- **Sharing:** `#share=<code>` links carry a packed list (`packList`/`unpackList`), deflate-compressed when the browser supports it (`z` prefix) or plain (`j`). Nothing is stored on a server.
- **Introduction:** shown once (`state.introDone`), and from Guider → Slik bruker du Varde.
- **Fuel planner:** litres boiled per person per day (`USE_KEYS`, defaults in `WATER_DEFAULT`, drinking water is always boiled) times fuel per litre (`FUELS[x].perL`: gas 15 g, petrol 30 ml, spirit 50 ml; own figure in `fuelCalc.perLc`). Water from snow multiplies everything by `SNOW_BOIL` (2.5). Day hike mode (`fuelCalc.mode = 'day'`) hides the table and uses one figure (`dayL`). The summary at the top shows the whole calculation.
- **Food planner:** meals per person per day with their energy side by side; the gauge at the top shows one full day against zones (`KZONES`: summer red below 2000 kcal, yellow below 3000, green above; winter 2500 / 3500).
- **Guide drawings:** own drawings (no licence needed) in `guides/`, loaded inline by `loadSvgs()` and coloured with `--sb-*` variables; precached in `sw.js`. The Brennerplate line in the standard list links to the stove board guide.
- **List lock:** `state.listLock` blocks ticking in both normal and outdoor mode (Lås listen, next to Skjul pakket); other tabs keep working.
- **Sun times:** calculated offline (`sunPos`, `sunDay`) from `state.pos` (GPS) and the date.
- **Knot images:** separate SVG files in `knots/`, listed in `KNOT_FILES` (by knot index) and credited in `KNOT_CREDITS`, shown on the Knuter page. They keep their own licence (see `knots/LICENSE.md`), use `var(--knot-line)` and `var(--knot-fill)` for colours, and are precached in `sw.js`. Only add images that have been checked against the knot tied in real rope, and always add the credit and the licence row.

## Standing rules
1. Every change to `index.html` must also raise the `CACHE` version in `sw.js` and `APP_VERSION` in `index.html` to the same value (shown under Hjelp on the lists page) (e.g. `varde-v1` → `varde-v2`), so installed apps fetch the update.
2. Never change the storage `KEY` (`outdoor-lists-v1`) in `index.html`, not even if the app is renamed. People have their own lists on their phones; changing it would wipe them. Template changes only affect newly created lists.
3. Keep Norwegian and English in step: every text and template line exists in both languages.
4. No brand names or organisation symbols in the app or the lists (except the user's deliberate choices: Jervenduk, DNT key / Hyttetur (DNT), varsom.no, yr.no).
5. Field-friendly design: comfortable tap targets, no gestures that need precision, undo for destructive actions. Must keep working offline.
6. Keep the app a single self-contained `index.html`. Check the JavaScript before committing (e.g. extract the `<script>` and run `node --check`).
7. Commit straight to `main` with a short, clear message describing the change.
8. Keep commit summaries under 50 characters; put details in the extended description.

## Workflow
- Most changes are prepared in a Claude chat and uploaded as whole files through the GitHub web interface.
- Claude Code is used for smaller edits, checks and documentation.
- Whoever changes `index.html` must raise the `CACHE` version in `sw.js` in the same commit.

## Lessons learned
- `body` uses the classes `field`, `night`, `locked` and `notlist`, and the attribute `data-skin`. Never reuse these names for other elements: a clash once made the whole page wider than the screen.
- `main` has the class `wrap`, so its bottom spacing for the tab bar is set on `main.wrap`. After any layout change, check that the last content on every page ends above the tab bar.
- The Android back button is handled with the History API (`go`, `goBack`, `popstate`). New screens and sheets must use `go()` or `openSheet()` so back keeps working.
- The body element carries `data-skin`, so click handlers must never match `closest('[data-skin]')` without a class (use `.skin-btn[data-skin]`); a generic match caught every click in the app once.
- Sheets that close and are followed by navigation must not leave a history entry behind: `go()` reuses a closed sheet's entry.
- All interface text for one language shares a single object in `UI`, so check that a new key is not already in use before adding it (a guide called `winter` once overwrote the season label `winter`).
- Opening or closing the rain lock's navigation window must not redraw the page (`lockUi()` only), or open sections and the scroll position are lost.
- The app remembers the last page (`state.lastNav`) and reopens there; `render()` falls back to the main page if that page no longer exists.
- Regnlås (rain lock, Utemodus only, also from the lock button in the header) blocks every change and all navigation while scrolling still works. Holding Naviger (1 s) opens navigation for 3 seconds (`NAV_MS`), renewed on each page change; holding Lås opp (1 s) switches it off. Both use `holdButton`, which handles touch events directly. The rain lock is saved (`state.rainLocked`), because Chrome on Android lets the back button close the app even while it is locked; on reopening, the app is still locked.

## Name
"Varde" is a working name. If the app is renamed, change the display name (`<title>`, `application-name`, `apple-mobile-web-app-title`, `UI.app` in both languages, `manifest.webmanifest`, README) and the `CACHE` prefix in `sw.js`, but never the storage `KEY`.
