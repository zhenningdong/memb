// memory blue — video export
//
// Re-renders a slideshow frame by frame on a canvas (same pace, transitions
// and black or blurred frame around a photo as the player) and encodes it to a video file in the
// browser, mixing in the slideshow's music when it has one.
// Preferred path: WebCodecs (H.264 + AAC → .mp4 via the vendored mp4-muxer).
// Fallback for browsers without WebCodecs: MediaRecorder (real-time capture).

import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer.mjs";
import { kenBurnsAt, kenBurnsPlan, shuffled, TRANSITION_S } from "./motion.js";

const FPS = 30;
const KEEP_BEHIND = 1; // photos kept decoded behind the current one
const KEEP_AHEAD = 3; // ...and ahead of it
const SIZES = [
  { width: 1920, height: 1080, label: "1080p" },
  { width: 1280, height: 720, label: "720p" },
];
// Codec candidates in order of preference. H.264 plays everywhere (QuickTime,
// phones, WeChat); AV1 / VP9 in MP4 are only tried where H.264 encoding is missing.
const CODECS = [
  { id: "avc1.640028", mux: "avc", label: "H.264" },
  { id: "avc1.4d0028", mux: "avc", label: "H.264" },
  { id: "avc1.42e028", mux: "avc", label: "H.264" },
  { id: "avc1.640029", mux: "avc", label: "H.264" },
  { id: "avc1.42e01f", mux: "avc", label: "H.264" },
  { id: "av01.0.08M.08", mux: "av1", label: "AV1" },
  { id: "vp09.00.40.08", mux: "vp9", label: "VP9" },
];

const AUDIO_RATE = 48000;
const AUDIO_GAIN = 0.9;
const AUDIO_CODECS = [
  { id: "mp4a.40.2", mux: "aac", label: "AAC" },
  { id: "opus", mux: "opus", label: "Opus" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);

function abortError() {
  return new DOMException("Export cancelled", "AbortError");
}

// ---------------------------------------------------------------------------
// Timeline: holds and transitions laid out on one time axis (seconds).
// ---------------------------------------------------------------------------

export function buildTimeline(count, duration, transition) {
  const gap = transition === "cut" ? 0 : TRANSITION_S;
  const segments = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    segments.push({ type: "hold", index: i, start: t, end: t + duration });
    t += duration;
    if (i < count - 1 && gap > 0) {
      segments.push({ type: "transition", from: i, to: i + 1, start: t, end: t + gap });
      t += gap;
    }
  }
  return { segments, total: t };
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

async function loadBitmap(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${label} (HTTP ${res.status})`);
  const blob = await res.blob();
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    // Older browsers, or a format createImageBitmap can't decode: go through <img>.
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    try {
      await img.decode();
    } catch {
      throw new Error(`${label} can't be decoded by this browser`);
    } finally {
      URL.revokeObjectURL(img.src);
    }
    return img;
  }
}

const sizeOf = (image) => ({
  w: image.naturalWidth || image.width,
  h: image.naturalHeight || image.height,
});

// ---------------------------------------------------------------------------
// Music: decode the track to 48 kHz stereo PCM, cut it to the length of the
// slideshow (repeating it if it is shorter), and ease it in and out.
// ---------------------------------------------------------------------------

async function loadMusic(url, seconds) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the music (HTTP ${res.status})`);
  const bytes = await res.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error("This browser can't decode audio");
  const decoder = new Offline(2, AUDIO_RATE, AUDIO_RATE);
  const decoded = await decoder.decodeAudioData(bytes);

  const total = Math.max(1, Math.round(seconds * AUDIO_RATE));
  const srcL = decoded.getChannelData(0);
  const srcR = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : srcL;
  const srcLength = decoded.length;
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const j = i % srcLength;
    left[i] = srcL[j];
    right[i] = srcR[j];
  }

  const fadeIn = Math.min(total, Math.round(0.6 * AUDIO_RATE));
  const fadeOut = Math.min(Math.round(total / 3), Math.round(2.5 * AUDIO_RATE));
  for (let i = 0; i < total; i++) {
    let g = AUDIO_GAIN;
    if (i < fadeIn) g *= i / fadeIn;
    if (i >= total - fadeOut) g *= (total - i) / fadeOut;
    left[i] *= g;
    right[i] *= g;
  }
  return { left, right, frames: total };
}

// ---------------------------------------------------------------------------
// Photos are decoded a few at a time: thirty full-size photographs at once
// would be several hundred megabytes.
// ---------------------------------------------------------------------------

class PhotoPool {
  constructor(photos) {
    this.photos = photos;
    this.images = new Map();
    this.pending = new Map();
  }

  load(i) {
    if (this.images.has(i)) return Promise.resolve(this.images.get(i));
    if (!this.pending.has(i)) {
      const p = loadBitmap(this.photos[i].url, `photo ${i + 1}`).then((img) => {
        this.images.set(i, img);
        this.pending.delete(i);
        return img;
      });
      this.pending.set(i, p);
    }
    return this.pending.get(i);
  }

  get(i) {
    return this.images.get(i) || null;
  }

  release(i) {
    const img = this.images.get(i);
    if (!img) return;
    if (typeof img.close === "function") img.close();
    this.images.delete(i);
  }

  releaseAll() {
    for (const i of [...this.images.keys()]) this.release(i);
  }
}

// ---------------------------------------------------------------------------
// Renderer: draws any moment of the slideshow onto a canvas.
// ---------------------------------------------------------------------------

class Renderer {
  constructor(pool, width, height, settings, timeline) {
    this.pool = pool;
    this.width = width;
    this.height = height;
    this.transition = settings.transition;
    this.motion = settings.motion === "kenburns";
    this.blurFill = settings.background === "blur"; // a blurred copy behind each photo, else black
    this.backdrops = new Map();
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.fits = new Map();
    // A translucent photo (mid-dissolve) is drawn as a whole layer — black
    // frame plus photo — and then composed with one alpha, exactly as the
    // player's opaque slides fade over each other.
    this.layer = document.createElement("canvas");
    this.layer.width = width;
    this.layer.height = height;
    this.layerCtx = this.layer.getContext("2d", { alpha: false });

    // How long each photograph is on screen (its hold plus the transitions on
    // either side): the span of its Ken Burns drift.
    const gap = settings.transition === "cut" ? 0 : TRANSITION_S;
    this.spans = [];
    for (const s of timeline.segments) {
      if (s.type === "hold") this.spans[s.index] = { start: Math.max(0, s.start - gap), end: Math.min(timeline.total, s.end + gap) };
    }
    this.plans = pool.photos.map((p, i) => kenBurnsPlan(p.planIndex ?? i));
  }

  // Make sure these photos are decoded; let the rest go, apart from a small
  // window around them.
  async prepare(indices) {
    await Promise.all(indices.map((i) => this.pool.load(i)));
    for (const i of indices) {
      if (!this.fits.has(i)) {
        const img = this.pool.get(i);
        this.fits.set(i, this.fitFor(img));
        if (this.blurFill) this.backdrops.set(i, this.makeBackdrop(img));
      }
    }
    const lo = Math.min(...indices) - KEEP_BEHIND;
    const hi = Math.max(...indices) + KEEP_AHEAD;
    for (const i of [...this.fits.keys()]) {
      if (i < lo || i > hi) {
        this.fits.delete(i);
        this.backdrops.delete(i);
        this.pool.release(i);
      }
    }
  }

  // Blurred, darkened, cover-fit copy of the photo — what the player shows
  // behind a photo when the "blurred background" setting is on. Uses the
  // canvas blur filter where available and a tiny-then-upscaled copy
  // elsewhere, which looks nearly the same.
  makeBackdrop(img) {
    const { width, height } = this;
    const { w, h } = sizeOf(img);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    const scale = Math.max(width / w, height / h) * 1.12;
    const dw = w * scale;
    const dh = h * scale;
    const dx = (width - dw) / 2;
    const dy = (height - dh) / 2;
    if (typeof ctx.filter === "string") {
      ctx.filter = "blur(40px) saturate(1.1) brightness(0.5)";
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.filter = "none";
    } else {
      const tiny = document.createElement("canvas");
      tiny.width = 48;
      tiny.height = 27;
      const tctx = tiny.getContext("2d", { alpha: false });
      tctx.drawImage(img, (dx / width) * 48, (dy / height) * 27, (dw / width) * 48, (dh / height) * 27);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(tiny, 0, 0, width, height);
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fillRect(0, 0, width, height);
    }
    return canvas;
  }

  fitFor(img) {
    const { width, height } = this;
    const { w, h } = sizeOf(img);
    const scale = Math.min(width / w, height / h);
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    return { dx: Math.round((width - dw) / 2), dy: Math.round((height - dh) / 2), dw, dh };
  }

  // One photograph, fitted inside the frame on black, with its Ken Burns
  // drift at time t. A translucent one (alpha < 1) is drawn on the layer
  // canvas first and composed whole, so the previous photo fades out
  // everywhere, not only where the new one covers it.
  drawPhoto(index, t, offsetX = 0, alpha = 1) {
    const { width, height } = this;
    const img = this.pool.get(index);
    const fit = this.fits.get(index);
    if (!img || !fit) return; // not decoded yet: leave black rather than stall

    let kb = { scale: 1, x: 0, y: 0 };
    if (this.motion) {
      const span = this.spans[index];
      kb = kenBurnsAt(this.plans[index], (t - span.start) / Math.max(0.001, span.end - span.start));
    }
    const whole = alpha < 1;
    const ctx = whole ? this.layerCtx : this.ctx;
    if (whole) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.save();
    ctx.translate(offsetX + width / 2 + (kb.x / 100) * width, height / 2 + (kb.y / 100) * height);
    ctx.scale(kb.scale, kb.scale);
    ctx.translate(-width / 2, -height / 2);
    const backdrop = this.blurFill ? this.backdrops.get(index) : null;
    // (drawn a little oversize so the Ken Burns drift never shows an edge)
    if (backdrop) ctx.drawImage(backdrop, -width * 0.03, -height * 0.03, width * 1.06, height * 1.06);
    ctx.drawImage(img, fit.dx, fit.dy, fit.dw, fit.dh);
    ctx.restore();
    if (whole) {
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.drawImage(this.layer, 0, 0);
      this.ctx.restore();
    }
  }

  drawFrame(segment, t) {
    const { ctx, width, height } = this;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);

    if (segment.type === "hold") {
      this.drawPhoto(segment.index, t);
      return;
    }
    const p = Math.min(1, Math.max(0, (t - segment.start) / (segment.end - segment.start)));
    if (this.transition === "slide") {
      const e = easeOut(p);
      this.drawPhoto(segment.from, t, Math.round(-e * width));
      this.drawPhoto(segment.to, t, Math.round((1 - e) * width));
    } else {
      // crossfade: the new photo fades in over the old one, like the player
      this.drawPhoto(segment.from, t);
      this.drawPhoto(segment.to, t, 0, easeInOut(p));
    }
  }
}

// The photos a segment needs on screen, plus the next one so it's ready in time.
function photosFor(segment, count) {
  const wanted = segment.type === "hold" ? [segment.index, segment.index + 1] : [segment.from, segment.to, segment.to + 1];
  return [...new Set(wanted.filter((i) => i >= 0 && i < count))];
}

function segmentAt(timeline, t) {
  const { segments } = timeline;
  for (const s of segments) if (t < s.end) return s;
  return segments[segments.length - 1];
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

async function pickWebCodecsConfig() {
  if (typeof window.VideoEncoder !== "function") return null;
  for (const size of SIZES) {
    for (const codec of CODECS) {
      const config = {
        codec: codec.id,
        width: size.width,
        height: size.height,
        bitrate: size.width >= 1920 ? 8_000_000 : 4_500_000,
        framerate: FPS,
        latencyMode: "quality",
        ...(codec.mux === "avc" ? { avc: { format: "avc" } } : {}),
      };
      try {
        const { supported } = await VideoEncoder.isConfigSupported(config);
        if (supported) return { config, codec, size };
      } catch {
        // try the next one
      }
    }
  }
  return null;
}

async function pickAudioConfig() {
  if (typeof window.AudioEncoder !== "function") return null;
  for (const codec of AUDIO_CODECS) {
    const config = { codec: codec.id, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 160_000 };
    try {
      const { supported } = await AudioEncoder.isConfigSupported(config);
      if (supported) return { config, codec };
    } catch {
      // try the next one
    }
  }
  return null;
}

async function encodeAudioWithWebCodecs(muxer, pcm, audioChoice, signal) {
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (err) => {
      failure = err;
    },
  });
  encoder.configure(audioChoice.config);

  const CHUNK = 4096;
  try {
    for (let offset = 0; offset < pcm.frames; offset += CHUNK) {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;
      const n = Math.min(CHUNK, pcm.frames - offset);
      const data = new Float32Array(n * 2);
      data.set(pcm.left.subarray(offset, offset + n), 0);
      data.set(pcm.right.subarray(offset, offset + n), n);
      const frame = new AudioData({
        format: "f32-planar",
        sampleRate: AUDIO_RATE,
        numberOfFrames: n,
        numberOfChannels: 2,
        timestamp: Math.round((offset / AUDIO_RATE) * 1e6),
        data,
      });
      encoder.encode(frame);
      frame.close();
      while (encoder.encodeQueueSize > 8) {
        if (failure) throw failure;
        await sleep(5);
      }
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

async function encodeWithWebCodecs(renderer, timeline, choice, pcm, onProgress, signal) {
  const { config, codec, size } = choice;
  const audioChoice = pcm ? await pickAudioConfig() : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: codec.mux, width: size.width, height: size.height, frameRate: FPS },
    audio: audioChoice ? { codec: audioChoice.codec.mux, sampleRate: AUDIO_RATE, numberOfChannels: 2 } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let audioLabel = null;
  if (audioChoice) {
    try {
      await encodeAudioWithWebCodecs(muxer, pcm, audioChoice, signal);
      audioLabel = audioChoice.codec.label;
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      // Without the audio chunks the muxer would still expect a track; start over video-only.
      return encodeWithWebCodecs(renderer, timeline, choice, null, onProgress, signal).then((r) => ({
        ...r,
        audioNote: "the music couldn't be encoded in this browser, so the video has no sound",
      }));
    }
  }

  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      failure = err;
    },
  });
  encoder.configure(config);

  const frameCount = Math.max(1, Math.round(timeline.total * FPS));
  const frameDuration = Math.round(1e6 / FPS);
  const photoCount = renderer.pool.photos.length;
  let currentSegment = null;
  try {
    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;

      const t = i / FPS;
      const segment = segmentAt(timeline, t);
      if (segment !== currentSegment) {
        currentSegment = segment;
        await renderer.prepare(photosFor(segment, photoCount));
      }
      renderer.drawFrame(segment, t);
      const frame = new VideoFrame(renderer.canvas, { timestamp: i * frameDuration, duration: frameDuration, alpha: "discard" });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();

      // Don't let frames pile up faster than the encoder can take them.
      while (encoder.encodeQueueSize > 4) {
        if (failure) throw failure;
        await new Promise((resolve) => {
          const done = () => {
            encoder.removeEventListener("dequeue", done);
            resolve();
          };
          encoder.addEventListener("dequeue", done);
          setTimeout(done, 40);
        });
      }
      if (i % 3 === 0) {
        onProgress(i / frameCount);
        await sleep(0); // let the progress bar paint
      }
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }

  muxer.finalize();
  onProgress(1);
  return {
    blob: new Blob([muxer.target.buffer], { type: "video/mp4" }),
    extension: "mp4",
    format: `${size.label} MP4 · ${codec.label}${audioLabel ? ` · ${audioLabel}` : ""}`,
    audioNote: pcm && !audioLabel ? "the music couldn't be included in this browser" : null,
  };
}

function pickRecorderMime() {
  if (typeof MediaRecorder !== "function") return null;
  const candidates = [
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

async function encodeWithMediaRecorder(renderer, timeline, mime, pcm, onProgress, signal) {
  const stream = renderer.canvas.captureStream(FPS);

  // Music: play the shaped PCM through an AudioContext into the recorded stream.
  let audioCtx = null;
  let source = null;
  if (pcm) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx({ sampleRate: AUDIO_RATE });
      const buffer = audioCtx.createBuffer(2, pcm.frames, AUDIO_RATE);
      buffer.copyToChannel(pcm.left, 0);
      buffer.copyToChannel(pcm.right, 1);
      source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const sink = audioCtx.createMediaStreamDestination();
      source.connect(sink);
      for (const track of sink.stream.getAudioTracks()) stream.addTrack(track);
      await audioCtx.resume();
    } catch {
      audioCtx = null;
      source = null;
    }
  }

  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = (e) => reject(e.error || new Error("Recording failed"));
  });

  const photoCount = renderer.pool.photos.length;
  await renderer.prepare(photosFor(timeline.segments[0], photoCount));
  let preparedSegment = timeline.segments[0];
  renderer.drawFrame(timeline.segments[0], 0);
  recorder.start(500);
  const started = performance.now() + 150; // a beat for the recorder to spin up
  if (source) source.start(audioCtx.currentTime + 0.15);

  try {
    await new Promise((resolve, reject) => {
      const tick = () => {
        if (signal?.aborted) return reject(abortError());
        const t = (performance.now() - started) / 1000;
        if (t >= timeline.total) return resolve();
        if (t >= 0) {
          const segment = segmentAt(timeline, t);
          if (segment !== preparedSegment) {
            preparedSegment = segment;
            renderer.prepare(photosFor(segment, photoCount)).catch(() => {}); // real time: don't wait
          }
          renderer.drawFrame(segment, t);
          onProgress(t / timeline.total);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await sleep(250);
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    stream.getTracks().forEach((track) => track.stop());
    try {
      source?.stop();
    } catch {
      /* already stopped */
    }
    audioCtx?.close().catch(() => {});
  }
  await stopped;
  if (signal?.aborted) throw abortError();

  const isMp4 = mime.includes("mp4");
  onProgress(1);
  return {
    blob: new Blob(chunks, { type: mime }),
    extension: isMp4 ? "mp4" : "webm",
    format: `${renderer.height}p ${isMp4 ? "MP4" : "WebM"}${source ? " · with music" : ""}`,
    audioNote: pcm && !source ? "the music couldn't be included in this browser" : null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function safeFilename(title, extension) {
  const base = String(title || "")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "slideshow"}.${extension}`;
}

/**
 * Render and encode a slideshow.
 * @param {{ photos: {url: string}[], settings: {duration: number, transition: string} }} slideshow
 * @param {{ onProgress?: (fraction: number, stage: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ blob: Blob, extension: string, format: string, seconds: number }>}
 */
export async function exportSlideshow(slideshow, { onProgress = () => {}, signal } = {}) {
  const { photos, settings, music } = slideshow;
  if (!photos?.length) throw new Error("There are no photos to export");

  // A shuffled show gets a fresh random order for the video, like in the player.
  const order = settings.shuffle ? shuffled(photos.length) : photos.map((_, i) => i);
  const ordered = order.map((i) => ({ ...photos[i], planIndex: i }));

  onProgress(0, "Loading photos");
  const pool = new PhotoPool(ordered);
  await pool.load(0); // fail early if photos can't be read at all
  if (signal?.aborted) throw abortError();

  const timeline = buildTimeline(ordered.length, settings.duration, settings.transition);

  let pcm = null;
  let musicNote = null;
  if (music?.url) {
    try {
      pcm = await loadMusic(music.url, timeline.total);
    } catch (err) {
      musicNote = `the music couldn't be read (${err.message}), so the video has no sound`;
    }
    if (signal?.aborted) throw abortError();
  }

  const choice = await pickWebCodecsConfig();
  const recorderMime = choice ? null : pickRecorderMime();
  if (!choice && !recorderMime) throw new Error("This browser can't encode video. Try Chrome, Edge or Safari.");

  const size = choice ? choice.size : { width: 1280, height: 720 };
  const renderer = new Renderer(pool, size.width, size.height, settings, timeline);
  const progress = (fraction) => onProgress(fraction, "Rendering");

  try {
    const result = choice
      ? await encodeWithWebCodecs(renderer, timeline, choice, pcm, progress, signal)
      : await encodeWithMediaRecorder(renderer, timeline, recorderMime, pcm, progress, signal);
    return { ...result, seconds: timeline.total, audioNote: result.audioNote || musicNote };
  } finally {
    pool.releaseAll();
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser a while to start the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}
