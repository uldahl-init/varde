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

## Standing rules
1. Every change to `index.html` must also raise the `CACHE` version in `sw.js` (e.g. `varde-v1` → `varde-v2`), so installed apps fetch the update.
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
- Regnlås (rain lock) blocks taps but allows scrolling, and is unlocked by a one-second hold that handles touch events directly.

## Name
"Varde" is a working name. If the app is renamed, change the display name (`<title>`, `application-name`, `apple-mobile-web-app-title`, `UI.app` in both languages, `manifest.webmanifest`, README) and the `CACHE` prefix in `sw.js`, but never the storage `KEY`.
