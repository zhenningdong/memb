# memory blue

Upload three to three hundred photos (and a piece of music, if you like) and get a slideshow you can play in the browser, share by link, or download as a video.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer (`node --version` to check). The code lives at <https://github.com/zhenningdong/memb>.

```bash
git clone https://github.com/zhenningdong/memb.git "memory blue"   # or use the folder you already have
cd memory\ blue
npm install        # first time only
npm start
```

Then open <http://localhost:3000>. The terminal also prints a `Network:` address — open that on a phone or another computer on the same Wi-Fi to watch a slideshow there. Stop the server with `Ctrl+C`.

On a Mac you can also double-click `start.command` (if macOS refuses, run `chmod +x start.command` once). That is the easiest way to run it: it stops an older copy of memory blue that is still running on the port, then starts the server with auto-restart, so later updates take effect on their own.

**After an update, restart the server.** Node keeps running the code it was started with, so an updated `server.js` on disk changes nothing until the server is started again — the pages, which are read from disk, would be new while the server still followed the old rules (an old limit on photos, no music…). The create page checks for this and shows a note at the top when the server is older than the page or isn't running, and reloads itself once a fresh server answers.

## The look

似水年华 — memories, like water. The design is meant to feel like a faded cyanotype kept in a drawer: pale water-blue paper, deep blue ink, and light drifting slowly across the surface (three soft patches of light move behind every page, and the brand mark sends out a slow ripple). Everything is set in a literary serif (Iowan Old Style / Baskerville on a Mac, Songti for Chinese titles), photographs sit on the page like small prints, and a faint paper grain and vignette lie over the whole page. All of it lives in `public/styles.css`: the palette and type are the custom properties at the top of the file, so a different mood is a matter of changing those values.

## How it works

```
server.js            Express server: API + static files
public/index.html    create page: pick photos, order them, set pace + transition
public/app.js
public/slideshow.html  player: /s/<id>
public/player.js
public/export.js       renders + encodes the video for the Download button
public/motion.js       Ken Burns plans + shuffling, shared by player and exporter
public/rename.js       click-to-rename, shared by the album cards and the player
public/drag.js         drag-to-reorder, shared by the create page and the player
public/vendor/         mp4-muxer (MIT) — writes the MP4 container
public/styles.css
uploads/<id>/        the photo files and the music track (created on first upload)
data/slideshows.json all slideshow records (title, settings, photo order)
```

- **Music.** Choose a track on the create page or add / change / remove one later from the player's *Photographs & music* panel. Any common format works — MP3, M4A/AAC, FLAC, WAV, AIFF, Apple Lossless, CAF, OGG, Opus, WMA, and more — up to 500 MB. MP3 and AAC are stored as they are; everything else is converted to AAC (256 kbps, in an .m4a) right after upload with macOS's built-in `afconvert`, so it plays in every browser, on phones, and in the downloaded video, and a 200 MB FLAC becomes a 10 MB track. (If `ffmpeg` is installed it is used for the few formats Core Audio can't read, such as OGG and WMA; without it, OGG/Opus are kept as they are — most browsers play them — and WMA is refused with a clear message.) It plays with the slideshow (pauses and resumes with it, repeats if it is shorter than the show, fades out at the end when the show doesn't loop), there is a mute button in the title bar, and the downloaded video carries it as an AAC track. Browsers only allow sound after you've interacted with a page, so a slideshow opened straight from a link starts quietly with a *Play with music* button on the photo — one click and it sounds.
- **Renaming.** A slideshow's name is edited in place, the way a file is renamed in the Finder: click the name on its card in the album, or in the player's title bar, and it becomes a text field with the name selected. Enter or clicking elsewhere keeps the new name, Escape puts the old one back, and an empty name is ignored (names are tidied and kept to 80 characters). Works with the keyboard too — Tab to the name and press Enter. `public/rename.js` is the shared piece; it talks to `PATCH /api/slideshows/:id`.
- **Choosing photographs.** Drop them on the page, or click the drop zone and pick them in the file window — select several there (click the first, ⇧-click the last, or ⌘A) and press *Open*; a double-click in that window opens only the one photograph you clicked. A whole folder can be dropped too: every photograph inside it is added, in name order. Whatever couldn't be added is explained right under the drop zone — a file that isn't a photograph, a camera RAW too big to send (JPG and PNG are never too big: the browser shrinks them to 2048px before uploading), a page that is full — and a single photograph from the file window, on a page that needs more, comes with a note on how to choose several at once.
- **Removing several at once.** Click a print (or the circle in its corner) to select it, ⇧-click another to select the run between them, ⌘-click to add or drop one; a bar appears with the count, *Select all* (which becomes *Deselect all*) and *Remove*. `⌫` removes the selection, `Esc` clears it, `⌘A` selects every print. Removing — one print with its × or a selection — is undone with the *Undo* that follows for a few seconds, rather than asked about first.
- **Big photographs stay quick.** A camera export can be 24 megapixels and 40 MB; the page never shows such a file as it is (the browser would decode it again at every repaint and the page would drag). As soon as a photograph is added it is decoded once, in the background, into a small print for the page and the 2048px copy that will be uploaded — so the prints respond instantly and *Make the slideshow* has nothing left to prepare.
- **Ordering.** Drag a print to move it (press and hold on a phone); the arrows under each print still work too. **Shuffle** deals the prints out in a random order on the page; the *Shuffle* setting goes further — the slideshow plays in a fresh random order every time it starts (each loop, each replay, and each downloaded video gets its own deal).
- **Photographs & music, in the player.** The grid button in the player's title bar opens a panel with the prints in order and the music track. Drag a print (or use the arrows that appear on it) to move it; the new order applies at once — the photo on screen stays on screen — and is kept on the server right away, so the link, the album cover and the downloaded video all follow it. *Shuffle* there deals the stored order anew; a click on a print shows it. Music is added, changed or removed from the same panel. (`public/drag.js` is the drag-to-reorder shared with the create page.)
- **Blurred background.** Off by default: a photo that doesn't fill the frame sits on plain black. Switch it on (create page, or the player's settings) and the space beside the photo is filled with a soft, blurred, darkened copy of it — the "blur fill" video editors use for vertical clips. Applies live in the player, is kept with *Keep for this link*, and the downloaded video is rendered the same way.
- **Ken Burns motion.** On by default for new slideshows: each photograph slowly drifts and zooms while it is on screen (`public/motion.js` holds the plan per photograph, so the player and the video move the same way). Switch it off on the create page or in the player's settings.
- **Three hundred photographs** are fine: the create page shows small prints and prepares the uploads in the background, the player only decodes a few photos around the current one, and the video exporter loads and releases them as it goes, so memory stays flat however long the show is. Dragging a print near the top or bottom edge scrolls the page, so a print can travel the length of a long page. A long show's video (over about six minutes) is written straight to a file you choose instead of being built in memory — in Chrome and Edge; elsewhere it is built in memory as before.
- **Photo formats.** JPG, PNG, WebP, GIF and AVIF are stored as they are (shrunk to 2048px on the long edge in the browser when they are big). Everything else — iPhone HEIC/HEIF, ProRAW DNG, camera RAW (CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW), TIFF, BMP, PSD, JPEG 2000 — is turned into a JPEG: by the browser when it can read the format (Safari reads HEIC and TIFF), otherwise by the server with macOS's built-in `sips` (resized to 2048px, orientation kept). Photos can be up to 100 MB each. The create page shows a striped placeholder for a print it can't preview. On a computer that isn't a Mac, HEIC is kept as it is (only Safari can display it) and the other formats are refused with a message asking for a JPEG.
- The player is a framed window on the page (the current photo glows softly behind the window, on the page itself). Inside the frame a photo sits on plain black unless *Blurred background* is on. The fullscreen button, `F`, or a double-click on the photo expands it to fill the screen; in fullscreen the controls fade out while playing and come back when you move the mouse.
- **Download** (in the player's title bar) renders the slideshow to a video file and saves it to your Downloads folder — 1080p, 30 fps, with the pace and transition currently set in the player. The video is built in the browser: WebCodecs encodes H.264 into an MP4 (`public/export.js` + the vendored `public/vendor/mp4-muxer.mjs`), so it plays in QuickTime, on phones and in WeChat. Browsers without WebCodecs fall back to MediaRecorder, which records in real time (MP4 or WebM, whichever the browser can write). Chrome, Edge and Safari 17+ all take the fast path.
- Photos are stored on disk under `uploads/`, one folder per slideshow. Deleting a slideshow removes its folder.
- Large photos are shrunk in the browser before upload (longest edge 2048px, saved as JPEG — as PNG only when the picture is transparent) so slideshows load fast: a 40 MB camera PNG arrives as a 1 MB JPEG. Originals are not kept — neither the full-size photos nor the music file before conversion.
- Settings changed in the player's *Playback* panel (pace, transition, Ken Burns, Shuffle, Blurred background, Repeat) apply immediately; **Keep for this link** writes them back so the link plays the same way for everyone.
- Everything is in memory plus one JSON file — no database to set up.

## API

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/slideshows` | multipart: `photos` ×3–300, `music` (optional), `title`, `duration`, `transition`, `motion`, `shuffle`, `background` | returns the new slideshow (201) |
| `PUT` | `/api/slideshows/:id/music` | multipart: `music` | adds or replaces the track |
| `DELETE` | `/api/slideshows/:id/music` | — | removes the track |
| `GET` | `/api/slideshows` | — | newest first, with `cover` and `photoCount` |
| `GET` | `/api/slideshows/:id` | — | photos + settings |
| `PATCH` | `/api/slideshows/:id` | JSON `{ title?, settings?: { duration?, transition?, loop?, shuffle?, motion?, background? }, order?: [photo ids] }` | `order` must list every photo once |
| `DELETE` | `/api/slideshows/:id` | — | removes the record and its files |

`duration` is seconds per photo (2–15, half-second steps). `transition` is `fade`, `slide` or `cut`. `motion` is `still` or `kenburns`; `shuffle` is `true` / `false`; `background` is `black` (default) or `blur`. A slideshow's `music` in responses has `url`, `name` (the original file name) and `duration` in seconds when known. `GET /api/version` also lists the size limits (`maxPhotoMb`, `maxMusicMb`) and which converters this computer has (`sips`, `afconvert`, `afinfo`, `ffmpeg`).

## Player shortcuts

`Space` play / pause · `←` `→` previous / next · `Home` `End` first / last · `F` fullscreen · `Esc` close settings

## Config

`PORT=4000 npm start` to use another port. `HOST=127.0.0.1 npm start` to make it reachable only from this computer.

`npm run dev` (what `start.command` runs) starts the server with auto-restart, so it picks up changes to `server.js` on its own — handy while the app is still being worked on. With plain `npm start`, restart it (`Ctrl+C`, then `npm start`) after `server.js` changes; the pages in `public/` only need a browser reload. If the port is already taken by an older copy, the server says so and exits instead of failing quietly. `GET /api/version` reports the running version, the photo limit, and whether `server.js` has changed since the server started.

## Ideas for later

Captions per photo were left out on purpose. The server keeps each slideshow as one JSON record, so they can be added as an extra field without changing the storage; the video export draws every frame itself (`export.js`), so anything added to the player can be mirrored there.
