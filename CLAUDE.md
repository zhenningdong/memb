# memory blue — project brief

A photo-slideshow web app by Zhenning Dong (Shanghai). Upload three to three hundred photographs and a piece of music, arrange them, set the pace and transition, then watch in the browser, share by link, or download an MP4. It is the first piece of a larger "memory agent" idea (看山 / Kanshan), so the feeling matters as much as the function: 追忆似水年华 — memories, like water.

This file is the brief for anyone (or any assistant) picking the project up. The README covers usage; this covers intent, decisions and conventions.

## Where things are

- Working copy: `~/Desktop/memory blue` on Zhenning's Mac. Run with `start.command` (double-click) or `npm run dev`; needs Node 18+.
- Repository: <https://github.com/zhenningdong/memb>.
- Photos and slideshow records live in `uploads/` and `data/` — personal, ignored by git.
- Version: 1.9.0 (`package.json`; the server prints it and serves it at `GET /api/version`).

## Shape of the code

No build step, no framework: an Express 5 server (`server.js`) and vanilla ES modules in `public/`.

| File | Role |
| --- | --- |
| `server.js` | API + static files; multer uploads; converts photos (sips) and music (afconvert / ffmpeg); JSON store `data/slideshows.json` |
| `public/index.html` + `app.js` | create page: pick photos (drop, dialog, folders), thumbnails, select / reorder / remove, settings, upload, album |
| `public/slideshow.html` + `player.js` | player at `/s/<id>`: framed window, transitions, Ken Burns, settings panel, "Photographs & music" panel |
| `public/export.js` | renders the slideshow to MP4 in the browser (WebCodecs; MediaRecorder fallback) |
| `public/motion.js` | Ken Burns plans + shuffle, shared by player and exporter so the video moves like the screen |
| `public/rename.js` | click-to-rename (Finder style), shared by album cards and the player title |
| `public/drag.js` | drag-to-reorder, shared by create page and player panel |
| `public/styles.css` | everything visual; palette and type are the custom properties at the top |
| `public/vendor/` | mp4-muxer (MIT) |
| `start.command` | Mac launcher: stops an older copy on the port, then `npm run dev` (auto-restart on server changes) |

## Decisions that should stay

- **Design language.** Pale water-blue paper, deep blue ink, slow light drifting across the page, a literary serif (Iowan Old Style / Baskerville, Songti for Chinese). Prints sit on the page like small photographs, slightly askew. Quiet, tender, unhurried. Don't add loud colour, sans-serif UI chrome, or emoji.
- **Voice.** English UI in full sentences; numbers as words ("Twenty-nine photographs selected"); hints in italics; field labels in small caps. Notes explain what happened right where it happened (under the drop zone, on the print), never only at the bottom of a form.
- **Follow the platform's standards.** When unsure how a control should behave, do what Apple does (Photos, Finder): click-to-rename in place, click / ⇧-click / ⌘-click selection, *Select all* ↔ *Deselect all* in one slot, a plain *Remove*, Esc / ⌫ / ⌘A. Destructive actions are undoable (an *Undo* toast for a few seconds), not confirmed with dialogs.
- **Photos.** 3–300 per slideshow (raised from 30 in 1.9.0). Any common format is accepted; JPG/PNG/WebP/GIF/AVIF are shrunk in the browser to 2048px and uploaded as JPEG (PNG only if transparent); HEIC, RAW, TIFF, BMP, PSD go to the server and are converted with `sips` (Mac). Thumbnails (320px) and the upload copy come from one background decode when a photo is added — never show a 40 MB original on the page, the browser re-decodes it on every repaint.
- **Music.** Any common format; MP3 and AAC kept, everything else converted to AAC 256 kbps (`afconvert`, `ffmpeg` for OGG/WMA). Plays with the show, fades at the end, goes into the video.
- **Settings.** `duration` 2–15 s, `transition` fade|slide|cut, `loop`, `shuffle` (a new random order each start), `motion` still|kenburns (on by default), `background` black|blur (black by default — the blurred "blur fill" is opt-in). The player applies changes live; *Keep for this link* saves them.
- **Server truth.** Photo order, title and settings are saved through `PATCH /api/slideshows/:id`; the player's panel and the album cards follow the server. Old server processes are detected by the page (`needsRestart` / missing `/api/version`) and explained at the top of the page.
- **Keep it single-user and local.** One JSON file, files on disk, no accounts, no database. Reachable on the LAN (the server prints a Network address) so a phone can watch.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/slideshows` | multipart: `photos` ×3–300, `music`?, `title`, `duration`, `transition`, `motion`, `shuffle`, `background` |
| `GET` | `/api/slideshows` · `/api/slideshows/:id` | list (newest first, with cover and count) · one, with photos and settings |
| `PATCH` | `/api/slideshows/:id` | `{ title?, settings?, order? }` — `order` must list every photo id once |
| `PUT` / `DELETE` | `/api/slideshows/:id/music` | add or replace / remove the track |
| `DELETE` | `/api/slideshows/:id` | removes record and files |
| `GET` | `/api/version` | version, limits, which converters exist, `needsRestart` |

## Working on it

- Change `public/` files and reload the page; change `server.js` and the dev server restarts itself (plain `npm start` needs Ctrl+C and start again).
- Test in a real browser with real-size photos (the owner's Leica exports are 24 MP PNGs of 30–45 MB) — most of the hard bugs came from size, not logic.
- There is a Playwright test suite (Python, ~350 checks across the create page, player, export, rename, arrange, formats, selection) kept outside the repo so far; ask before relying on it, or add it under `tests/`.
- Deliver updates to `~/Desktop/memory blue` and bump `package.json` when the server changes, so the page's version check stays meaningful.

## Ideas not done yet

Captions per photo (the record can take an extra field); adding photos to an existing slideshow from the player's panel; a Chinese interface; trying the candidate names (the 朦胧回忆 / "hazy memory" list) in the UI; a real deployment beyond the local server.
