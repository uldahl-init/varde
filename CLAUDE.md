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
- Tabs: Pakkliste, Notater, Planlegg (Mat, Drivstoff, Sekkvekt, Vannblanding), Guider (grouped: Ferdigheter i felt, Vær og sikkerhet, Utstyr og vedlikehold; Fiske under Ferdigheter i felt), Kompass.
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
- **Guide drawings:** own drawings (no licence needed) in `guides/`, loaded inline by `loadSvgs()` and coloured with `--sb-*` variables; precached in `sw.js`.
- **Notater (notepad, from varde-v18):** `state.notes` = `[{id, title, text, t}]`, newest first by `t` (last edited). Pages: `notes` tab, one note at `note:<id>`. Opening a note is navigation (`data-nav`); new, edit and delete are data changes and are hidden in Utemodus. Delete uses `withUndo`. Lists no longer have their own notes: `notesFromList()` moves any list notes into the notepad (once for stored lists, `state.notesMoved`; and for lists received by share link or restored from backup), titled with the list name. The backup carries `notes` beside `lists`.
- **Sekkvekt (pack weight, from varde-v19):** `state.packW` = `{unit:'g'|'kg', items:[{id, name, g, cat, cons, dog}]}`; weights are always stored in grams, `unit` only changes display and input. Items come from the main list (`pickFromList()`, food items marked as consumable) or are typed in (`askWeightItem()`, category from the main list's sections or Annet). The summary shows the total of your pack, base weight and consumables (when anything is marked consumable), a subtotal per category, and the dog pack separately. Always go through `packW()`.
- **Dog in the planners:** food planner shows kcal per meal next to each meal name (`data-mk`, from varde-v22); `foodCalc.dog`, `dogs`, `dogG` (g per dog per day, times days including the reserve day; not part of the kcal gauge). Fuel planner `fuelCalc.dog`, `dogL` (litres per day), only when water comes from snow: added once per day, not per person, times `SNOW_BOIL`.
- **Start på nytt (from varde-v20):** button at the bottom of Dine lister, hidden in Utemodus. Clears all ticks (standard list, own lists, bags), all trip types, open/closed sections (back to default), makes the standard list the main list, and turns off Utemodus, Regnlås, Skjul pakket and Lås listen. Never deletes lists, notes, Sekkvekt, planner figures or settings (language, skin, theme, Nattlys). Runs through `withUndo`.
- **Knot pictures:** an entry in `KNOT_FILES` can be one file or an array of files (several pictures on one card, as for Åttetallsknute). Every picture needs a line in `KNOT_CREDITS` (two lines with the same `k` are fine) and a place in `sw.js`.
- **Fonts (from varde-v22):** Barlow 400/600 and Barlow Condensed 600 are bundled in `fonts/` (latin subset, from Fontsource; SIL Open Font License, `fonts/OFL.txt`) and loaded with `@font-face`, so the app looks the same offline. No Google Fonts or other outside requests. New font files must be added to `sw.js`.
- **Text guides:** plain text guides (Skalltøy, Fjellsko with Skistøvler, Telt, Tarp, Bål, Topptur og skred) live in `GUIDE_TXT` (`no` and `en`, each `{title, short, sub, secs}`; a section can carry a third value as its id) and are drawn by `renderTextGuide()`. Kept in their own object, not in `UI`, so their keys cannot clash with interface text. A new text guide only needs an entry in both languages and a place in `GUIDE_GROUPS`.
- **Guide groups:** `GUIDE_GROUPS` sets the order and group of every guide on the Guider page. Order (from varde-v21): Ferdigheter i felt first (what you look for in a hurry), then Vær og sikkerhet, and Utstyr og vedlikehold last (what you check back home). Each group has a colour (`--gc`: `--lichen`, `--red`, `--gsafe`) shown as a stripe and a group heading, never colour alone.
- **Guide links:** `GUIDE_LINKS` maps standard list item ids to a guide (`'boots#ski'` opens that section). Links appear only on the standard list, as part of the app's basics; own lists get none. Changing the Norwegian text of a linked template line changes its id, so update the map at the same time.
- **List lock:** `state.listLock` blocks ticking, switching trip types and the light day-hike view of bags (from varde-v23), in both normal and outdoor mode (Lås listen, next to Skjul pakket). The Turtype panel still opens (navigation) and shows a locked hint, with the chips dimmed (class `lk`). Other tabs keep working.
- **Header:** on the packing list, the whole header is one button (`#listBtn`) to Dine lister; on other pages it is a plain title (class `plain`). Long names drop the label, use up to two lines, then end with "…". In outdoor mode, a labelled Regnlås button (`#hdrLock`) sits at the right.
- **Dine lister:** all cards start folded. Lists received through a share link get `sharedIn: true` and are shown under Delte lister; Dupliser makes an own list.
- **Sky (Kompass):** sun arc and moon at a glance, then Sol and Måne details, then date and position. Moon phase, rise and set use standard low-precision formulas (`moonEq`, `moonIllum`, `moonDay`), offline.
- **Weather and warnings:** chosen from the saved position (`region()`, `NO_POLY`, `AVALANCHE`), plus the user's own links in `state.links`. Check the addresses now and then.
- **Updates:** `sw.js` fetches pages with `cache:'no-cache'`, registration uses `updateViaCache:'none'`, and the page reloads once when a new version takes over.
- **Sun times:** calculated offline (`sunPos`, `sunDay`) from `state.pos` (GPS) and the date.
- **Sun and moon on the compass rose (from varde-v23):** two chips under Hold retningen switch them, both on by default (`state.skyNow`, `state.skyRiseSet`, read through `skyOn()`). Sol og måne nå: the sun with rays and the moon in its phase (`skyNowMarks`, `moonAzAlt`, `moonGlyph`), faded below the horizon, redrawn every minute. Soloppgang og solnedgang: a half sun on a horizon with an arrow up or down, plus a short line at the rim for the exact direction (`sunMarks`, `riseSetMark`), for the chosen date. Sun symbols use `--sun` (amber; red in Nattlys), never the north red. Symbols carry the class `upr` and are turned back by `uprightMarks()` so they stay upright as the dial turns. The chips are switches, so they stay locked in Regnlås.
- **Fiske guide (from varde-v24):** fishing knots live in their own guide (`fishing`, in Ferdigheter i felt after Knuter), so the Knuter page keeps its own warning and count. Cards in `UI.fishKnots` (both languages, same shape as `knots`), pictures in `FISH_KNOT_FILES`, credits in `FISH_KNOT_CREDITS`; drawn by `renderKnots('fishing')` with the shared `knotCards()` and `knotCredits()`. Linked from the Fiske trip type (Kroker, Svivler / sene). More fishing content goes on this page.
- **Wide knot drawings:** an SVG whose viewBox is wider than 1.6 : 1 gets the class `wide` and fills the card width (max 220 px high) instead of the fixed 220 px height.
- **Knot images:** separate SVG files in `knots/`, listed in `KNOT_FILES` (by knot index) and credited in `KNOT_CREDITS`, shown on the Knuter page. They keep their own licence (see `knots/LICENSE.md`), use `var(--knot-line)` and `var(--knot-fill)` for colours, and are precached in `sw.js`. Only add images that have been checked against the knot tied in real rope, and always add the credit and the licence row.

## Standing rule: rain lock and navigation
Anything that only changes what you see (changing page, back, opening bags and guides, fold-out sections, folding list categories, the Turtype panel, the list button in the header, links that leave the app) carries the attribute `data-nav`; `<summary>` elements count automatically. In the rain lock these work during the navigation window and restart its 3 seconds. Anything that changes data (ticks, switches, typing, editing lists) never gets `data-nav` and stays locked. Every new feature must follow this.

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
- Most changes are prepared in a Claude chat and uploaded as whole files through the GitHub web interface (the default when whole files were built and tested in the chat).
- Claude Code is used only for smaller edits made directly in the repository, checks and documentation, where nothing needs to be handed over from a chat.
- Every update ends with a check: manual upload or Claude Code. If Claude Code, say why it is better this time and give the message to paste; otherwise list the files to upload with the commit summary and description.
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
