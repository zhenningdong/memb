// memory blue — server
//
// A small Express app that stores uploaded photos on disk, keeps slideshow
// metadata in a JSON file, and serves the two pages in ./public.
//
//   POST   /api/slideshows            multipart: photos[] (3–30), music? (one audio file), title, duration, transition, shuffle, motion, background
//   GET    /api/slideshows            list (newest first)
//   GET    /api/slideshows/:id        one slideshow with its photo URLs, music and settings
//   PATCH  /api/slideshows/:id        json: { title?, settings?: { duration?, transition?, loop?, shuffle?, motion?, background? }, order?: [photo ids] }
//   PUT    /api/slideshows/:id/music  multipart: music — adds or replaces the track
//   DELETE /api/slideshows/:id/music  removes the track
//   DELETE /api/slideshows/:id        removes the record and its files
//
//   GET    /                          create page
//   GET    /s/:id                     player for one slideshow
//   GET    /uploads/:id/:file         the photo and music files
//
// Formats: photos arrive as anything common (JPG, PNG, WebP, GIF, AVIF, iPhone
// HEIC/HEIF, ProRAW DNG, camera RAW, TIFF, BMP, PSD…); what browsers can't show
// is converted to JPEG with macOS's built-in `sips`. Music arrives as anything
// common (MP3, M4A/AAC, FLAC, WAV, AIFF, Apple Lossless, CAF, OGG, Opus, WMA…);
// what isn't MP3 or AAC is converted to AAC with macOS's built-in `afconvert`
// (or ffmpeg, where installed). See normalizePhotos / normalizeMusic.

import express from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SERVER_FILE = fileURLToPath(import.meta.url);
const ROOT = path.dirname(SERVER_FILE);
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "slideshows.json");

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// Node keeps running the code it was started with. If server.js on disk is
// newer than this process, the create page shows a "restart the server"
// notice (see /api/version) instead of failing in confusing ways.
const startedWith = fileStamp();
function fileStamp() {
  try {
    const st = fs.statSync(SERVER_FILE);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "";
  }
}

const PORT = Number(process.env.PORT) || 3000;
// 0.0.0.0 makes the app reachable from other devices on the same Wi-Fi,
// so a slideshow link can be opened on a phone. Set HOST=127.0.0.1 to keep it local.
const HOST = process.env.HOST || "0.0.0.0";

const MIN_PHOTOS = 3;
const MAX_PHOTOS = 300;
const MAX_PHOTO_MB = 100; // a ProRAW or camera RAW file can be 30–80 MB
const MAX_MUSIC_MB = 500; // a lossless track can be 100 MB+; it is converted to AAC after upload
const MUSIC_BITRATE = 256_000; // AAC, for converted tracks
const MIN_DURATION = 2; // seconds per photo
const MAX_DURATION = 15;
const TRANSITIONS = ["fade", "slide", "cut"];
const MOTIONS = ["still", "kenburns"];
const BACKGROUNDS = ["black", "blur"]; // what fills the frame beside a photo that doesn't fill it
const DEFAULT_SETTINGS = { duration: 4, transition: "fade", loop: true, shuffle: false, motion: "still", background: "black" };
const asBool = (v) => v === true || v === "true" || v === "1" || v === "on";

// Photos. Browsers show the first group as they are; everything else — iPhone
// HEIC/HEIF, ProRAW DNG, camera RAW, TIFF, BMP, PSD… — is converted to JPEG
// after upload with macOS's built-in `sips` (see normalizePhotos).
const PHOTO_KEEP = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const PHOTO_CONVERT = new Set([
  ".heic", ".heif", ".hif", ".dng", ".tif", ".tiff", ".bmp", ".jfif", ".jpe", ".jp2", ".psd",
  ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".pef", ".srw", // camera RAW
]);
const PHOTO_EXTS = new Set([...PHOTO_KEEP, ...PHOTO_CONVERT]);
const HEIC_EXTS = new Set([".heic", ".heif", ".hif"]);

// Music. MP3 and AAC (in .m4a) play everywhere and are stored as they are.
// Everything else — FLAC, WAV, AIFF, Apple Lossless, CAF, OGG, Opus, WMA… — is
// converted to AAC after upload (see normalizeMusic). Formats in MUSIC_PLAYABLE
// are kept as they are when no converter is available, since most browsers
// can play them anyway.
const MUSIC_PLAYABLE = new Set([".mp3", ".m4a", ".m4b", ".aac", ".wav", ".flac", ".ogg", ".oga", ".opus", ".weba", ".webm"]);
const MUSIC_EXTS = new Set([
  ...MUSIC_PLAYABLE,
  ".m4r", ".wave", ".aif", ".aiff", ".aifc", ".caf", ".alac", ".amr", ".3gp", ".wma", ".ape",
  ".ac3", ".mp2", ".mpga", ".mka", ".dsf", ".dff", ".wv", ".tta", ".au", ".snd",
]);

// A file extension for what the browser tells us about the file; the original
// file name usually knows best (see extensionFor).
const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/heic-sequence": ".heic",
  "image/heif-sequence": ".heif",
  "image/tiff": ".tif",
  "image/bmp": ".bmp",
  "image/x-ms-bmp": ".bmp",
  "image/x-adobe-dng": ".dng",
  "image/jp2": ".jp2",
  "image/vnd.adobe.photoshop": ".psd",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mpeg3": ".mp3",
  "audio/x-mpeg-3": ".mp3",
  "audio/x-mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mp4a-latm": ".m4a",
  "audio/x-m4b": ".m4b",
  "audio/aac": ".aac",
  "audio/x-aac": ".aac",
  "audio/aacp": ".aac",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/vnd.wave": ".wav",
  "audio/x-pn-wav": ".wav",
  "audio/aiff": ".aiff",
  "audio/x-aiff": ".aiff",
  "audio/x-caf": ".caf",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/webm": ".weba",
  "audio/x-matroska": ".mka",
  "audio/x-ms-wma": ".wma",
  "audio/amr": ".amr",
  "audio/3gpp": ".3gp",
  "audio/ac3": ".ac3",
  "audio/x-ape": ".ape",
  "audio/x-monkeys-audio": ".ape",
  "audio/x-dsf": ".dsf",
  "audio/x-wavpack": ".wv",
  "audio/x-tta": ".tta",
  "audio/basic": ".au",
};

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Tiny JSON store. Everything lives in memory and is written back atomically
// (temp file + rename) after each change, so a crash never leaves half a file.
// ---------------------------------------------------------------------------

const db = { slideshows: {} };
try {
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (parsed && typeof parsed.slideshows === "object") db.slideshows = parsed.slideshows;
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

let saveQueue = Promise.resolve();
function saveDb() {
  saveQueue = saveQueue.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_FILE);
  });
  return saveQueue;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ID_RE = /^[a-f0-9]{10}$/;
const newId = () => randomBytes(5).toString("hex");
const isValidId = (id) => typeof id === "string" && ID_RE.test(id);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getSlideshowOr404(id) {
  const slideshow = isValidId(id) ? db.slideshows[id] : undefined;
  if (!slideshow) throw new HttpError(404, "Slideshow not found");
  return slideshow;
}

function normalizeSettings(input, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  if (!input || typeof input !== "object") return out;

  if (input.duration !== undefined && input.duration !== "") {
    const seconds = Number(input.duration);
    if (!Number.isFinite(seconds)) throw new HttpError(400, "Seconds per photo must be a number");
    // Clamp to the allowed range and snap to half seconds.
    out.duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(seconds * 2) / 2));
  }
  if (input.transition !== undefined) {
    if (!TRANSITIONS.includes(input.transition)) {
      throw new HttpError(400, `Transition must be one of: ${TRANSITIONS.join(", ")}`);
    }
    out.transition = input.transition;
  }
  if (input.loop !== undefined) out.loop = asBool(input.loop);
  if (input.shuffle !== undefined) out.shuffle = asBool(input.shuffle);
  if (input.motion !== undefined) {
    if (!MOTIONS.includes(input.motion)) throw new HttpError(400, `Motion must be one of: ${MOTIONS.join(", ")}`);
    out.motion = input.motion;
  }
  if (input.background !== undefined) {
    if (!BACKGROUNDS.includes(input.background)) throw new HttpError(400, `Background must be one of: ${BACKGROUNDS.join(", ")}`);
    out.background = input.background;
  }
  return out;
}

function cleanTitle(value, fallback) {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return title || fallback;
}

function defaultTitle(date = new Date()) {
  return `Untitled · ${date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
}

async function removeUploadDir(id) {
  if (!isValidId(id)) return;
  await fsp.rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true });
}

function publicView(slideshow) {
  return {
    id: slideshow.id,
    title: slideshow.title,
    createdAt: slideshow.createdAt,
    updatedAt: slideshow.updatedAt,
    settings: { ...DEFAULT_SETTINGS, ...slideshow.settings }, // older records may predate a setting
    photos: slideshow.photos.map((p) => ({ id: p.id, url: `/uploads/${slideshow.id}/${p.file}`, name: p.originalName })),
    music: slideshow.music
      ? { url: `/uploads/${slideshow.id}/${slideshow.music.file}`, name: slideshow.music.originalName, duration: slideshow.music.duration ?? null }
      : null,
  };
}

const nameExt = (file) => path.extname(file.originalname || "").toLowerCase();

// The extension to store the file under: the original name's when it is one
// we know (browsers guess mime types loosely — "audio/mp4" for an .m4b, say),
// else from the mime type, else the name's if it looks like one.
function extensionFor(file) {
  const fromName = nameExt(file);
  if (PHOTO_EXTS.has(fromName) || MUSIC_EXTS.has(fromName)) return fromName;
  const byMime = EXT_BY_MIME[file.mimetype];
  if (byMime) return byMime;
  return /^\.[a-z0-9]{1,5}$/.test(fromName) ? fromName : ".bin";
}
const isPhotoFile = (file) => (file.mimetype.startsWith("image/") && file.mimetype !== "image/svg+xml") || PHOTO_EXTS.has(nameExt(file));
const isAudioFile = (file) => file.mimetype.startsWith("audio/") || MUSIC_EXTS.has(nameExt(file));

function describeFile(file) {
  return { id: path.parse(file.filename).name, file: file.filename, originalName: file.originalname, type: file.mimetype, size: file.size };
}

const formatName = (ext) => ext.replace(/^\./, "").toUpperCase();

// Runs a command-line tool; resolves with its stdout, rejects with the error
// (err.code === "ENOENT" when the tool isn't installed).
async function run(cmd, args, timeout = 60_000) {
  const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

// Anything browsers can't show — HEIC/HEIF from an iPhone, ProRAW DNG, camera
// RAW, TIFF, PSD… — becomes a JPEG with macOS's built-in `sips` (no install
// needed), shrunk to 2048px on the long edge like the browser does for JPEGs.
// Where `sips` is missing (not a Mac), HEIC is kept as it is (Safari can show
// it) and anything else is refused with a clear message.
async function normalizePhotos(dir, photos) {
  // A few conversions at a time: three hundred HEICs must not become three hundred sips processes at once.
  return mapLimited(photos, 4, async (photo) => {
    const ext = path.extname(photo.file).toLowerCase();
    if (PHOTO_KEEP.has(ext)) return photo;
    const src = path.join(dir, photo.file);
    const outName = `${photo.id}.jpg`;
    const out = path.join(dir, outName);
    try {
      await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "88", "--resampleHeightWidthMax", "2048", src, "--out", out], 120_000);
      const { size } = await fsp.stat(out);
      if (!size) throw new Error("empty output");
      await fsp.rm(src, { force: true });
      return { ...photo, file: outName, type: "image/jpeg", size, convertedFrom: ext.slice(1) };
    } catch (err) {
      await fsp.rm(out, { force: true }).catch(() => {});
      const jpegBytes = ext === ".jfif" || ext === ".jpe"; // JPEG under another name — browsers don't mind
      if (err.code === "ENOENT" && (HEIC_EXTS.has(ext) || ext === ".bmp" || jpegBytes)) {
        console.warn(`sips isn't available here; keeping ${photo.originalName} as it is.`);
        return photo;
      }
      console.warn(`Couldn't convert ${photo.originalName} (${err.code || err.message}).`);
      throw new HttpError(
        400,
        err.code === "ENOENT"
          ? `"${photo.originalName}" is a ${formatName(ext)} file, which browsers can't show; on a Mac memory blue converts it automatically — here, please export it as JPEG first`
          : `Couldn't read "${photo.originalName}" — please export it as JPEG and try again`,
      );
    }
  });
}

// Promise.all with at most `limit` jobs in flight; results keep their order.
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// What's inside an audio file: the codec and the length. `afinfo` on a Mac,
// `ffprobe` where that is installed; nothing known otherwise.
async function probeAudio(file) {
  try {
    const out = await run("afinfo", [file], 30_000);
    const codec = /Data format:[^\n]*'([^']{4})'/.exec(out)?.[1]?.trim().toLowerCase() ?? null;
    const duration = Number(/estimated duration:\s*([\d.]+)/.exec(out)?.[1]);
    return { codec, duration: Number.isFinite(duration) && duration > 0 ? duration : null };
  } catch {
    /* no afinfo, or it couldn't read the file */
  }
  try {
    const out = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", file], 30_000);
    const info = JSON.parse(out);
    const duration = Number(info.format?.duration);
    return { codec: info.streams?.[0]?.codec_name?.toLowerCase() ?? null, duration: Number.isFinite(duration) && duration > 0 ? duration : null };
  } catch {
    /* no ffprobe either */
  }
  return { codec: null, duration: null };
}

// AAC in an .m4a: `afconvert` first (built into macOS, reads AIFF, WAV, CAF,
// FLAC, Apple Lossless, AAC, MP3, AMR…), then `ffmpeg` if it is installed
// (which also reads OGG, Opus, WMA, APE…).
async function convertToAac(src, out) {
  const attempts = [
    ["afconvert", ["-f", "m4af", "-d", "aac", "-b", String(MUSIC_BITRATE), "-q", "127", src, out]],
    ["afconvert", ["-f", "m4af", "-d", "aac@48000", "-b", String(MUSIC_BITRATE), "-q", "127", src, out]], // hi-res (88.2/96/192 kHz) sources: Apple's AAC encoder stops at 48 kHz
    ["afconvert", ["-f", "m4af", "-d", "aac@44100", "-q", "127", src, out]], // whatever bit rate the encoder allows (mono, odd rates…)
    ["ffmpeg", ["-y", "-nostdin", "-v", "error", "-i", src, "-vn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", `${MUSIC_BITRATE / 1000}k`, "-movflags", "+faststart", out]],
  ];
  let failure = null; // the most recent failure from a tool that is installed
  for (const [cmd, args] of attempts) {
    try {
      await run(cmd, args, 10 * 60_000);
      const { size } = await fsp.stat(out);
      if (size > 0) return cmd;
      failure = new Error(`${cmd} wrote an empty file`);
    } catch (err) {
      if (err.code !== "ENOENT") failure = err;
    }
    await fsp.rm(out, { force: true }).catch(() => {});
  }
  throw failure || Object.assign(new Error("no converter is installed"), { code: "ENOENT" });
}

// Does the file start like an audio file of some kind? (So a damaged file is
// told apart from a format the converter simply doesn't read.)
async function looksLikeAudio(file) {
  const fh = await fsp.open(file, "r");
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(16), 0, 16, 0);
    if (bytesRead < 4) return false;
    const head = buffer.subarray(0, bytesRead);
    const ascii = head.toString("latin1");
    if (/^(fLaC|OggS|RIFF|FORM|caff|ID3|#!AMR|MAC |DSD |TTA1|wvpk|\.snd|FRM8)/.test(ascii)) return true; // FLAC, OGG/Opus, WAV, AIFF, CAF, MP3 tag, AMR, APE, DSF, TTA, WavPack, AU, DFF
    if (ascii.slice(4, 8) === "ftyp") return true; // MP4 / M4A / 3GP
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true; // MP3 / AAC frame sync
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // WebM / Matroska
    if (head[0] === 0x30 && head[1] === 0x26 && head[2] === 0xb2 && head[3] === 0x75) return true; // WMA (ASF)
    return false;
  } finally {
    await fh.close();
  }
}

// MP3 and AAC are stored as they are; everything else becomes AAC so it plays
// in every browser, on phones, and in the downloaded video — and so a 200 MB
// FLAC turns into a 10 MB track.
async function normalizeMusic(dir, music) {
  if (!music) return null;
  const ext = path.extname(music.file).toLowerCase();
  const src = path.join(dir, music.file);
  const name = music.originalName;
  if (!music.size) throw new HttpError(400, `"${name}" is empty`);

  const probe = await probeAudio(src);
  const aacInside = probe.codec === null || /^aac/.test(probe.codec); // afinfo says 'aac ', ffprobe says aac; unknown → assume so
  const keep = ext === ".mp3" || ((ext === ".m4a" || ext === ".m4b") && aacInside);
  if (keep) return { ...music, duration: probe.duration };

  const outName = `${music.id}-aac.m4a`; // never the source's own name (an Apple Lossless .m4a becomes an AAC .m4a)
  const out = path.join(dir, outName);
  try {
    const tool = await convertToAac(src, out);
    const { size } = await fsp.stat(out);
    await fsp.rm(src, { force: true });
    const converted = await probeAudio(out);
    console.log(`Converted ${name} (${formatName(ext)}) to AAC with ${tool}.`);
    return { ...music, file: outName, type: "audio/mp4", size, convertedFrom: ext.slice(1), duration: converted.duration ?? probe.duration };
  } catch (err) {
    await fsp.rm(out, { force: true }).catch(() => {});
    const noConverter = err.code === "ENOENT";
    // (ffprobe guesses a codec from the name even for junk, so a length is required too.)
    const readable = (probe.codec !== null && probe.duration !== null) || (await looksLikeAudio(src).catch(() => false));
    if (readable && MUSIC_PLAYABLE.has(ext)) {
      // A format this computer can't convert, but most browsers play (OGG in Safari being the exception).
      console.warn(`Couldn't convert ${name} (${noConverter ? "no converter installed" : err.message}); keeping the ${formatName(ext)} as it is.`);
      return { ...music, duration: probe.duration };
    }
    console.warn(`Couldn't convert ${name} (${noConverter ? "no converter installed" : err.message}).`);
    if (!readable) throw new HttpError(400, `Couldn't read "${name}" — the file seems to be damaged, or isn't really a ${formatName(ext)} file`);
    throw new HttpError(
      400,
      noConverter
        ? `"${name}" is a ${formatName(ext)} file, which browsers can't play; on a Mac memory blue converts it automatically — here, please use MP3, M4A, WAV or FLAC`
        : `Couldn't convert "${name}" (${formatName(ext)}) to a format browsers can play — MP3, M4A, WAV, AIFF or FLAC work best`,
    );
  }
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = path.join(UPLOADS_DIR, req.slideshowId);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename(_req, file, cb) {
      cb(null, `${file.fieldname === "music" ? "music-" : ""}${newId()}${extensionFor(file)}`);
    },
  }),
  // One size limit for the stream; photos get their own, smaller check afterwards (checkPhotoSizes).
  limits: { files: MAX_PHOTOS + 1, fileSize: MAX_MUSIC_MB * 1024 * 1024, fields: 10 },
  fileFilter(_req, file, cb) {
    if (file.fieldname === "photos" && !isPhotoFile(file)) {
      return cb(new HttpError(400, `"${file.originalname}" is not a photo (JPG, PNG, HEIC, WebP, TIFF, RAW…)`));
    }
    if (file.fieldname === "music" && !isAudioFile(file)) {
      return cb(new HttpError(400, `"${file.originalname}" is not an audio file (MP3, M4A, FLAC, WAV, AIFF…)`));
    }
    cb(null, true);
  },
});

function checkPhotoSizes(files) {
  const big = files.find((f) => f.size > MAX_PHOTO_MB * 1024 * 1024);
  if (big) throw new HttpError(400, `"${big.originalname}" is ${Math.round(big.size / 1024 / 1024)} MB — photos must be under ${MAX_PHOTO_MB} MB`);
}
const uploadForCreate = upload.fields([
  { name: "photos", maxCount: MAX_PHOTOS },
  { name: "music", maxCount: 1 },
]);
const uploadMusic = upload.single("music");

function friendlyUploadError(err) {
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case "LIMIT_FILE_COUNT":
        return new HttpError(400, `You can upload at most ${MAX_PHOTOS} photos (and one music track)`);
      case "LIMIT_UNEXPECTED_FILE":
        // Either too many files in one field, or a field this server doesn't know —
        // which usually means an older server process is still running.
        return new HttpError(
          400,
          err.field === "photos" || err.field === "music"
            ? `You can upload at most ${MAX_PHOTOS} photos and one music track`
            : `The server didn't expect a "${err.field}" upload — if memory blue was just updated, restart the server (Ctrl+C, then npm start)`,
        );
      case "LIMIT_FILE_SIZE":
        return new HttpError(400, `Files must be under ${MAX_MUSIC_MB} MB (music) and ${MAX_PHOTO_MB} MB (photos)`);
      default:
        return new HttpError(400, err.message);
    }
  }
  return err;
}

// Runs a multer middleware and turns its callback into a promise.
const runUpload = (middleware, req, res) =>
  new Promise((resolve, reject) => middleware(req, res, (err) => (err ? reject(friendlyUploadError(err)) : resolve())));

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");

// Create: photos (+ optional music) + settings in one multipart request.
app.post("/api/slideshows", async (req, res, next) => {
  req.slideshowId = newId();
  try {
    await runUpload(uploadForCreate, req, res);

    const files = req.files?.photos || [];
    const music = req.files?.music?.[0] || null;
    if (files.length < MIN_PHOTOS) {
      throw new HttpError(400, `Add at least ${MIN_PHOTOS} photos (you added ${files.length})`);
    }
    checkPhotoSizes(files);

    const dir = path.join(UPLOADS_DIR, req.slideshowId);
    const now = new Date();
    const [photos, track] = await Promise.all([
      normalizePhotos(dir, files.map(describeFile)),
      normalizeMusic(dir, music ? describeFile(music) : null),
    ]);
    const slideshow = {
      id: req.slideshowId,
      title: cleanTitle(req.body?.title, defaultTitle(now)),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      settings: normalizeSettings(req.body),
      photos,
      music: track,
    };

    db.slideshows[slideshow.id] = slideshow;
    await saveDb();
    res.status(201).json(publicView(slideshow));
  } catch (err) {
    await removeUploadDir(req.slideshowId).catch(() => {});
    next(err);
  }
});

// Music: add / replace / remove the track of an existing slideshow.
app.put("/api/slideshows/:id/music", async (req, res, next) => {
  try {
    const slideshow = getSlideshowOr404(req.params.id);
    req.slideshowId = slideshow.id;
    await runUpload(uploadMusic, req, res);
    if (!req.file) throw new HttpError(400, "Choose an audio file");

    const track = await normalizeMusic(path.join(UPLOADS_DIR, slideshow.id), describeFile(req.file));
    const previous = slideshow.music;
    slideshow.music = track;
    slideshow.updatedAt = new Date().toISOString();
    await saveDb();
    if (previous && previous.file !== track.file) {
      await fsp.rm(path.join(UPLOADS_DIR, slideshow.id, previous.file), { force: true }).catch(() => {});
    }
    res.json(publicView(slideshow));
  } catch (err) {
    if (req.file) await fsp.rm(req.file.path, { force: true }).catch(() => {});
    next(err);
  }
});

app.delete("/api/slideshows/:id/music", async (req, res) => {
  const slideshow = getSlideshowOr404(req.params.id);
  const previous = slideshow.music;
  slideshow.music = null;
  slideshow.updatedAt = new Date().toISOString();
  await saveDb();
  if (previous) await fsp.rm(path.join(UPLOADS_DIR, slideshow.id, previous.file), { force: true }).catch(() => {});
  res.json(publicView(slideshow));
});

app.get("/api/slideshows", (_req, res) => {
  const list = Object.values(db.slideshows)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((s) => {
      const view = publicView(s);
      return { ...view, photoCount: view.photos.length, cover: view.photos[0]?.url ?? null, hasMusic: Boolean(view.music), photos: undefined, music: undefined };
    });
  res.json(list);
});

app.get("/api/slideshows/:id", (req, res) => {
  res.json(publicView(getSlideshowOr404(req.params.id)));
});

app.patch("/api/slideshows/:id", express.json({ limit: "10kb" }), async (req, res) => {
  const slideshow = getSlideshowOr404(req.params.id);
  const body = req.body && typeof req.body === "object" ? req.body : {};

  if (body.title !== undefined) slideshow.title = cleanTitle(body.title, slideshow.title);
  if (body.settings !== undefined) slideshow.settings = normalizeSettings(body.settings, slideshow.settings);
  if (body.order !== undefined) slideshow.photos = reorderPhotos(slideshow.photos, body.order);
  slideshow.updatedAt = new Date().toISOString();

  await saveDb();
  res.json(publicView(slideshow));
});

// A new order for the photos: every photo id of the slideshow, once each.
function reorderPhotos(photos, order) {
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
    throw new HttpError(400, "order must be a list of photo ids");
  }
  const byId = new Map(photos.map((p) => [p.id, p]));
  if (order.length !== photos.length || new Set(order).size !== photos.length || !order.every((id) => byId.has(id))) {
    throw new HttpError(400, "order must list every photo of this slideshow exactly once");
  }
  return order.map((id) => byId.get(id));
}

app.delete("/api/slideshows/:id", async (req, res) => {
  const slideshow = getSlideshowOr404(req.params.id);
  delete db.slideshows[slideshow.id];
  await saveDb();
  await removeUploadDir(slideshow.id);
  res.status(204).end();
});

// The create page asks this on load. An old server (before this route
// existed) answers 404, which the page treats the same as needsRestart.
app.get("/api/version", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    version: VERSION,
    maxPhotos: MAX_PHOTOS,
    maxPhotoMb: MAX_PHOTO_MB,
    maxMusicMb: MAX_MUSIC_MB,
    converters: tools,
    needsRestart: fileStamp() !== startedWith,
  });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Pages and files
app.get("/s/:id", (req, res) => {
  // The player page fetches the slideshow itself and shows a friendly
  // "not found" state, so unknown ids still get the page (with a 404 status).
  const known = isValidId(req.params.id) && Boolean(db.slideshows[req.params.id]);
  res.status(known ? 200 : 404).sendFile(path.join(PUBLIC_DIR, "slideshow.html"));
});

app.use("/uploads", express.static(UPLOADS_DIR, { fallthrough: false, immutable: true, maxAge: "30d" }));
// no-cache = the browser may keep a copy but must check with the server before
// using it, so an updated page or script is picked up on the next reload.
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ["html"],
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  }),
);

// Errors → JSON for the API, plain text elsewhere.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? "Something went wrong on the server" : err.message;
  if (req.path.startsWith("/api/")) return res.status(status).json({ error: message });
  res.status(status).type("text").send(message);
});

// Which converters this computer has (macOS ships sips, afconvert and afinfo;
// ffmpeg is a bonus). Reported by /api/version and printed at startup.
const tools = { sips: false, afconvert: false, afinfo: false, ffmpeg: false };
async function detectTools() {
  const checks = { sips: ["--help"], afconvert: ["-h"], afinfo: ["-h"], ffmpeg: ["-version"] };
  await Promise.all(
    Object.entries(checks).map(async ([name, args]) => {
      try {
        await execFileAsync(name, args, { timeout: 10_000 });
        tools[name] = true;
      } catch (err) {
        tools[name] = err.code !== "ENOENT"; // present but grumpy about the flag still counts
      }
    }),
  );
}

const server = app.listen(PORT, HOST, async () => {
  console.log(`\nmemory blue ${VERSION} is running (up to ${MAX_PHOTOS} photographs)\n\n  Local:    http://localhost:${PORT}`);
  if (HOST === "0.0.0.0") {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal) console.log(`  Network:  http://${a.address}:${PORT}`);
      }
    }
  }
  await detectTools();
  const yes = (ok) => (ok ? "yes" : "no");
  console.log(`\n  Converts photos (HEIC, RAW, TIFF…): ${yes(tools.sips)} (sips)`);
  console.log(`  Converts music (FLAC, AIFF, WAV…):  ${yes(tools.afconvert || tools.ffmpeg)} (afconvert: ${yes(tools.afconvert)}, ffmpeg: ${yes(tools.ffmpeg)})`);
  console.log("\nPress Ctrl+C to stop.\n");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use — memory blue is probably still running in another Terminal window.\n` +
        `Stop that one (Ctrl+C there, or quit Terminal) and start this one again, or run it on another port:\n\n` +
        `  PORT=${PORT + 1} npm start\n`,
    );
    process.exit(1);
  }
  throw err;
});
