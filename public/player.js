// memory blue — slideshow player
//
// Loads one slideshow from the API and plays it inside a framed player window:
// crossfade / slide / cut transitions, a per-photo progress bar, an ambient
// glow behind the window, keyboard shortcuts, fullscreen, and a settings
// panel whose changes apply immediately and can be saved back to the link.

import { kenBurnsPlan, shuffled, TRANSITION_S } from "./motion.js";
import { editableTitle } from "./rename.js";
import { dragToReorder } from "./drag.js";

const TRANSITION_MS = TRANSITION_S * 1000;
const HUD_HIDE_MS = 2600;
const PRELOAD_AHEAD = 2; // photos loaded ahead of the current one
const TRANSITIONS = ["fade", "slide", "cut"];
const TRANSITION_LABELS = { fade: "Dissolve", slide: "Slide", cut: "Cut" };
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel) => document.querySelector(sel);
const els = {
  body: document.body,
  ambient: $("#ambient"),
  player: $("#player"),
  bar: $(".window-bar"),
  title: $("#title"),
  windowActions: $("#window-actions"),
  stage: $("#stage"),
  message: $("#stage-message"),
  controlsBar: $("#window-controls"),
  progress: $("#progress"),
  controlsInfo: $("#controls-info"),
  counter: $("#counter"),
  prevBtn: $("#prev-btn"),
  nextBtn: $("#next-btn"),
  playBtn: $("#play-btn"),
  iconPlay: $("#icon-play"),
  iconPause: $("#icon-pause"),
  iconReplay: $("#icon-replay"),
  shareBtn: $("#share-btn"),
  settingsBtn: $("#settings-btn"),
  fullscreenBtn: $("#fullscreen-btn"),
  iconExpand: $("#icon-expand"),
  iconCompress: $("#icon-compress"),
  panel: $("#settings-panel"),
  pDuration: $("#p-duration"),
  pDurationOut: $("#p-duration-out"),
  pLoop: $("#p-loop"),
  saveBtn: $("#save-btn"),
  saveStatus: $("#save-status"),
  toast: $("#toast"),
  downloadBtn: $("#download-btn"),
  exportPanel: $("#export-panel"),
  exportStatus: $("#export-status"),
  exportBarFill: $("#export-bar-fill"),
  exportNote: $("#export-note"),
  exportFormat: $("#export-format"),
  exportCancel: $("#export-cancel"),
  exportAgain: $("#export-again"),
  exportClose: $("#export-close"),
  muteBtn: $("#mute-btn"),
  iconSoundOn: $("#icon-sound-on"),
  iconSoundOff: $("#icon-sound-off"),
  soundPill: $("#sound-pill"),
  pMusicName: $("#p-music-name"),
  pMusicInput: $("#p-music-input"),
  pMusicChoose: $("#p-music-choose"),
  pMusicRemove: $("#p-music-remove"),
  pShuffle: $("#p-shuffle"),
  pMotion: $("#p-motion"),
  pBlur: $("#p-blur"),
  arrangeBtn: $("#arrange-btn"),
  arrangePanel: $("#arrange-panel"),
  arrangeList: $("#arrange-list"),
  arrangeStatus: $("#arrange-status"),
  arrangeShuffle: $("#arrange-shuffle"),
  arrangeInOrder: $("#arrange-in-order"),
  arrangeClose: $("#arrange-close"),
  arrangeTemplate: $("#arrange-item-template"),
};

const slideshowId = location.pathname.split("/").filter(Boolean)[1] || "";

const state = {
  slideshow: null,
  slides: [],
  segments: [],
  index: -1,
  playing: false,
  ended: false,
  settings: { duration: 4, transition: "fade", loop: true, shuffle: false, motion: "still", background: "black" },
  order: [], // playback position → photo index
  timer: null,
  startedAt: 0,
  elapsedBeforePause: 0,
  finishTransition: null,
  hudTimer: null,
  toastTimer: null,
  ambientLayer: 0,
  exporting: false,
  exportController: null,
  lastExport: null,
  audio: null,
  soundBlocked: false,
  fade: null,
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function showMessage(title, text, withHomeLink = true) {
  els.message.hidden = false;
  els.message.replaceChildren();
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  els.message.append(h, p);
  if (withHomeLink) {
    const a = document.createElement("a");
    a.className = "btn small";
    a.href = "/";
    a.textContent = "Back to the album";
    els.message.append(a);
  }
  els.title.textContent = "Slideshow";
  els.windowActions.hidden = true;
  els.controlsBar.hidden = true;
  els.stage.style.cursor = "default";
}

function whenLoaded(img) {
  return new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve();
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function init() {
  let res;
  try {
    res = await fetch(`/api/slideshows/${encodeURIComponent(slideshowId)}`, { cache: "no-store" });
  } catch {
    showMessage("Couldn't reach the server", "Check that memory blue is still running, then reload this page.", false);
    return;
  }
  if (res.status === 404) {
    showMessage("This slideshow doesn't exist", "It may have been deleted, or the link was copied incompletely.");
    return;
  }
  if (!res.ok) {
    showMessage("Something went wrong", `The server answered with status ${res.status}.`);
    return;
  }

  const slideshow = await res.json();
  state.slideshow = slideshow;
  state.settings = { ...state.settings, ...slideshow.settings };
  els.title.textContent = slideshow.title;
  document.title = `${slideshow.title} · memory blue`;
  // Click the name in the title bar to rename the slideshow.
  editableTitle(els.title, {
    label: "Slideshow name",
    save: async (name) => {
      const res = await fetch(`/api/slideshows/${encodeURIComponent(slideshowId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.slideshow.title = data.title;
      document.title = `${data.title} · memory blue`;
      return data.title;
    },
    onError: (err) => showToast(`Couldn't rename: ${err.message}`),
  });

  // One <figure> per photo: the photo fitted inside the frame on plain black —
  // or, with the "blurred background" setting on, over a blurred cover-fit copy
  // of itself. Sources are set lazily (a few photos around the current one),
  // so thirty photographs don't all load and decode at once.
  state.slides = slideshow.photos.map((photo, i) => {
    const figure = document.createElement("figure");
    figure.className = "slide";
    figure.dataset.index = String(i);
    figure.dataset.id = photo.id;
    figure.dataset.url = photo.url;
    const inner = document.createElement("div");
    inner.className = "slide-inner";
    const bg = document.createElement("img");
    bg.className = "slide-bg";
    bg.alt = "";
    bg.decoding = "async";
    const img = document.createElement("img");
    img.className = "slide-img";
    img.alt = photo.name ? `Photo ${i + 1}: ${photo.name}` : `Photo ${i + 1}`;
    img.decoding = "async";
    img.addEventListener("error", () => {
      bg.remove();
      const note = document.createElement("div");
      note.className = "stage-message";
      note.innerHTML = "<p>This photo can't be displayed in this browser.</p>";
      inner.append(note);
    });
    inner.append(bg, img);
    figure.append(inner);
    return figure;
  });
  els.stage.append(...state.slides);

  state.segments = slideshow.photos.map((_, i) => {
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.append(document.createElement("i"));
    seg.addEventListener("click", () => goTo(i, i >= state.index ? 1 : -1));
    return seg;
  });
  els.progress.replaceChildren(...state.segments);

  resetOrder();
  applyBackground();
  syncPanel();
  updateControlsInfo();
  setupMusic(slideshow.music);

  // Start as soon as the first photo is ready (or after a short grace period).
  ensureLoaded(state.order[0]);
  await Promise.race([whenLoaded(state.slides[state.order[0]].querySelector(".slide-img")), sleep(5000)]);
  els.message.hidden = true;
  state.playing = true;
  goTo(0, 1);
  playMusic();
  scheduleHudHide();
}

// Give a slide its image source (once); the blurred copy behind it only when
// the "blurred background" setting is on (see applyBackground).
function ensureLoaded(photoIndex) {
  const figure = state.slides[photoIndex];
  if (!figure) return;
  if (!figure.dataset.loaded) {
    figure.dataset.loaded = "1";
    figure.querySelector(".slide-img").src = figure.dataset.url;
  }
  if (state.settings.background === "blur" && !figure.dataset.bgLoaded) {
    figure.dataset.bgLoaded = "1";
    const bg = figure.querySelector(".slide-bg");
    if (bg) bg.src = figure.dataset.url;
  }
}

// Black, or a blurred copy of the photo, beside photos that don't fill the frame.
function applyBackground() {
  const blur = state.settings.background === "blur";
  els.stage.classList.toggle("blur-fill", blur);
  if (blur) for (const figure of state.slides) if (figure.dataset.loaded) ensureLoaded(Number(figure.dataset.index));
}

// Load the photos just ahead (and one behind) of a playback position.
function preloadAround(position) {
  const count = state.order.length;
  for (let d = -1; d <= PRELOAD_AHEAD; d++) {
    ensureLoaded(state.order[(position + d + count) % count]);
  }
}

// ---------------------------------------------------------------------------
// Play order (shuffle)
// ---------------------------------------------------------------------------

const photoAt = (position) => state.order[position];

function resetOrder(keepPhoto = -1) {
  const n = state.slides.length;
  if (state.settings.shuffle) {
    state.order = shuffled(n);
    // keep the photo that is on screen where it is: it becomes position 0
    if (keepPhoto >= 0) state.order = [keepPhoto, ...state.order.filter((i) => i !== keepPhoto)];
  } else {
    state.order = Array.from({ length: n }, (_, i) => i);
  }
}

// A fresh deal when a shuffled show starts over, avoiding an immediate repeat.
function redeal(lastPhoto) {
  if (state.settings.shuffle) state.order = shuffled(state.slides.length, lastPhoto);
}

function setShuffle(on) {
  state.settings.shuffle = Boolean(on);
  const current = state.index >= 0 ? photoAt(state.index) : -1;
  resetOrder(current);
  state.index = state.settings.shuffle ? 0 : Math.max(0, current);
  state.ended = false;
  els.counter.textContent = `${state.index + 1} / ${state.order.length}`;
  preloadAround(state.index);
  restartCountdown();
  updateProgress();
  updatePlayButton();
  updateControlsInfo();
  refreshArrangeHint();
  markCurrentPrint();
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function goTo(target, direction) {
  const count = state.order.length;
  if (!count) return;

  // The slide on screen now — worked out before the order can change below.
  const prev = state.index >= 0 ? state.slides[photoAt(state.index)] : null;

  if (target >= count) {
    if (!state.settings.loop) return finish();
    redeal(photoAt(state.index)); // a fresh deal for a shuffled show
    target = 0;
  } else if (target < 0) {
    target = count - 1;
  }

  state.ended = false;
  const next = state.slides[photoAt(target)];
  const dir = direction ?? (target > state.index ? 1 : -1);
  if (next === prev) {
    // Same photograph again (e.g. its own segment was clicked): just restart its time.
    state.index = target;
    restartCountdown();
    restartMotion();
    updateProgress();
    updatePlayButton();
    return;
  }
  state.index = target;

  ensureLoaded(photoAt(target));
  if (state.finishTransition) state.finishTransition();
  runTransition(prev, next, dir);
  startMotion(next);
  setAmbient(state.slideshow.photos[photoAt(target)].url);
  preloadAround(target);

  els.counter.textContent = `${target + 1} / ${count}`;
  restartCountdown();
  updateProgress();
  updatePlayButton();
  markCurrentPrint();
}

// ---------------------------------------------------------------------------
// Ken Burns: a slow drift and zoom on the photograph while it is on screen.
// ---------------------------------------------------------------------------

function motionActive() {
  return state.settings.motion === "kenburns" && !reduceMotion;
}

function stopMotion(figure) {
  const anim = figure && figure._motion;
  if (anim) {
    anim.cancel();
    figure._motion = null;
  }
}

function startMotion(figure) {
  stopMotion(figure);
  if (!motionActive()) return;
  const plan = kenBurnsPlan(Number(figure.dataset.index));
  const inner = figure.querySelector(".slide-inner");
  const ms = (state.settings.duration + TRANSITION_S) * 1000;
  const frame = (k) => `translate(${k.x}%, ${k.y}%) scale(${k.scale})`;
  const anim = inner.animate([{ transform: frame(plan.from) }, { transform: frame(plan.to) }], {
    duration: ms,
    easing: "ease-in-out",
    fill: "both",
  });
  if (!state.playing) anim.pause();
  figure._motion = anim;
}

function restartMotion() {
  if (state.index < 0) return;
  const figure = state.slides[photoAt(state.index)];
  if (motionActive()) startMotion(figure);
  else stopMotion(figure);
}

function setMotionPlaying(playing) {
  const figure = state.index >= 0 ? state.slides[photoAt(state.index)] : null;
  const anim = figure && figure._motion;
  if (!anim) return;
  if (playing) anim.play();
  else anim.pause();
}

function runTransition(prev, next, dir) {
  const type = !prev || reduceMotion ? "cut" : state.settings.transition;
  const ms = type === "cut" ? 0 : TRANSITION_MS;
  const easing = "cubic-bezier(0.22, 0.61, 0.36, 1)";
  const animations = [];

  next.classList.add("is-active");
  next.style.zIndex = "2";
  if (prev) prev.style.zIndex = "1";

  if (type === "fade") {
    animations.push(next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "ease-in-out", fill: "both" }));
  } else if (type === "slide") {
    const from = dir >= 0 ? "100%" : "-100%";
    const to = dir >= 0 ? "-100%" : "100%";
    animations.push(next.animate([{ transform: `translateX(${from})` }, { transform: "translateX(0)" }], { duration: ms, easing, fill: "both" }));
    animations.push(prev.animate([{ transform: "translateX(0)" }, { transform: `translateX(${to})` }], { duration: ms, easing, fill: "both" }));
  }

  const finish = () => {
    clearTimeout(timer);
    state.finishTransition = null;
    for (const a of animations) a.cancel();
    if (prev && prev !== next) {
      prev.classList.remove("is-active");
      prev.style.zIndex = "";
      stopMotion(prev);
    }
    next.style.zIndex = "";
  };
  const timer = setTimeout(finish, ms + 30);
  state.finishTransition = finish;
}

// Two stacked layers behind the window; the new photo fades in over the old one.
function setAmbient(url) {
  const layers = els.ambient.children;
  const current = layers[state.ambientLayer];
  const nextLayer = layers[1 - state.ambientLayer];
  nextLayer.style.backgroundImage = `url("${url}")`;
  nextLayer.classList.add("on");
  current.classList.remove("on");
  state.ambientLayer = 1 - state.ambientLayer;
}

function restartCountdown() {
  clearTimeout(state.timer);
  state.elapsedBeforePause = 0;
  state.startedAt = performance.now();
  if (state.playing) state.timer = setTimeout(() => goTo(state.index + 1, 1), state.settings.duration * 1000);
  els.body.classList.toggle("paused", !state.playing);
}

function play() {
  if (state.ended) {
    state.playing = true;
    if (state.audio) state.audio.currentTime = 0;
    redeal(photoAt(state.index));
    goTo(0, 1);
  } else {
    state.playing = true;
    state.startedAt = performance.now();
    const remaining = Math.max(0, state.settings.duration * 1000 - state.elapsedBeforePause);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => goTo(state.index + 1, 1), remaining);
    els.body.classList.remove("paused");
    setMotionPlaying(true);
  }
  playMusic();
  updatePlayButton();
  scheduleHudHide();
}

function pause() {
  if (!state.playing) return;
  state.playing = false;
  clearTimeout(state.timer);
  state.elapsedBeforePause += performance.now() - state.startedAt;
  els.body.classList.add("paused");
  setMotionPlaying(false);
  pauseMusic();
  updatePlayButton();
  scheduleHudHide();
}

function finish() {
  state.playing = false;
  state.ended = true;
  clearTimeout(state.timer);
  els.body.classList.add("paused");
  setMotionPlaying(false);
  fadeOutMusic(1600);
  updateProgress();
  updatePlayButton();
  scheduleHudHide();
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

const MUTED_KEY = "memoryblue:muted";

function setupMusic(music) {
  if (state.audio) {
    state.audio.pause();
    state.audio.removeAttribute("src");
    state.audio.load();
    state.audio.remove();
    state.audio = null;
  }
  cancelFade();
  els.soundPill.hidden = true;
  state.soundBlocked = false;

  if (music) {
    const audio = new Audio(music.url);
    audio.preload = "auto";
    audio.loop = true; // a short track keeps going for a long slideshow
    audio.volume = 0.9;
    let muted = false;
    try {
      muted = localStorage.getItem(MUTED_KEY) === "1";
    } catch {
      /* private mode etc. */
    }
    audio.muted = muted;
    audio.id = "music";
    audio.setAttribute("aria-hidden", "true");
    // Tracks are converted to AAC on upload, so this should be rare (an old
    // slideshow with an OGG in Safari, say).
    audio.addEventListener("error", () => showToast(`This browser can't play ${music.name}`), { once: true });
    els.player.append(audio); // in the DOM so it is part of the fullscreen element
    state.audio = audio;
    if (state.playing) playMusic();
  }
  els.muteBtn.hidden = !music;
  updateMuteButton();
  els.pMusicName.textContent = music ? music.name : "No music";
  els.pMusicChoose.textContent = music ? "Change" : "Add a track";
  els.pMusicRemove.hidden = !music;
}

function playMusic() {
  const audio = state.audio;
  if (!audio) return;
  cancelFade();
  audio.volume = 0.9;
  const attempt = audio.play();
  if (!attempt || typeof attempt.then !== "function") return;
  attempt
    .then(() => {
      state.soundBlocked = false;
      els.soundPill.hidden = true;
    })
    .catch((err) => {
      // Browsers only allow sound after the person has interacted with the page.
      if (err && err.name === "NotAllowedError") {
        state.soundBlocked = true;
        els.soundPill.hidden = false;
      }
    });
}

function pauseMusic() {
  cancelFade();
  state.audio?.pause();
}

function cancelFade() {
  if (state.fade) cancelAnimationFrame(state.fade);
  state.fade = null;
}

function fadeOutMusic(ms) {
  const audio = state.audio;
  if (!audio || audio.paused) return;
  cancelFade();
  const start = performance.now();
  const from = audio.volume;
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    audio.volume = from * (1 - p);
    if (p < 1) {
      state.fade = requestAnimationFrame(step);
    } else {
      audio.pause();
      audio.currentTime = 0;
      audio.volume = from;
      state.fade = null;
    }
  };
  state.fade = requestAnimationFrame(step);
}

function updateMuteButton() {
  const muted = Boolean(state.audio?.muted);
  els.iconSoundOn.toggleAttribute("hidden", muted);
  els.iconSoundOff.toggleAttribute("hidden", !muted);
  const label = muted ? "Unmute the music" : "Mute the music";
  els.muteBtn.title = label;
  els.muteBtn.setAttribute("aria-label", label);
  els.muteBtn.setAttribute("aria-pressed", String(muted));
}

els.muteBtn.addEventListener("click", () => {
  if (!state.audio) return;
  state.audio.muted = !state.audio.muted;
  try {
    localStorage.setItem(MUTED_KEY, state.audio.muted ? "1" : "0");
  } catch {
    /* ignore */
  }
  updateMuteButton();
  if (!state.audio.muted && state.playing) playMusic();
});

els.soundPill.addEventListener("click", (e) => {
  e.stopPropagation(); // don't also toggle play/pause
  e.currentTarget.blur(); // so Space keeps meaning play/pause
  if (state.audio && state.audio.muted) {
    state.audio.muted = false;
    updateMuteButton();
  }
  playMusic();
});

async function uploadMusic(file) {
  // MP3 and M4A are kept as they are; anything else is converted to AAC on the server.
  const converting = !/\.(mp3|m4a|m4b)$/i.test(file.name);
  els.pMusicName.textContent = converting ? `Uploading and converting ${file.name}…` : `Uploading ${file.name}…`;
  els.pMusicChoose.disabled = els.pMusicRemove.disabled = true;
  try {
    const data = new FormData();
    data.append("music", file, file.name);
    const res = await fetch(`/api/slideshows/${encodeURIComponent(slideshowId)}/music`, { method: "PUT", body: data });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.slideshow.music = body.music;
    setupMusic(body.music);
    showToast(`Music added — ${body.music.name}`);
  } catch (err) {
    els.pMusicName.textContent = `Couldn't add music: ${err.message}`;
  } finally {
    els.pMusicChoose.disabled = els.pMusicRemove.disabled = false;
  }
}

async function removeMusic() {
  els.pMusicChoose.disabled = els.pMusicRemove.disabled = true;
  try {
    const res = await fetch(`/api/slideshows/${encodeURIComponent(slideshowId)}/music`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.slideshow.music = null;
    setupMusic(null);
    showToast("Music removed");
  } catch (err) {
    els.pMusicName.textContent = `Couldn't remove music: ${err.message}`;
  } finally {
    els.pMusicChoose.disabled = els.pMusicRemove.disabled = false;
  }
}

els.pMusicChoose.addEventListener("click", () => els.pMusicInput.click());
els.pMusicRemove.addEventListener("click", removeMusic);
els.pMusicInput.addEventListener("change", () => {
  const file = els.pMusicInput.files[0];
  els.pMusicInput.value = "";
  if (file) uploadMusic(file);
});

function togglePlay() {
  if (state.playing) pause();
  else play();
}

function updateProgress() {
  state.segments.forEach((seg, i) => {
    const isCurrent = i === state.index && !state.ended;
    seg.classList.toggle("done", i < state.index || (state.ended && i <= state.index));
    seg.classList.toggle("current", isCurrent);
    if (isCurrent) {
      // Replace the bar so its CSS animation starts from zero.
      seg.style.setProperty("--duration", `${state.settings.duration}s`);
      seg.firstElementChild.replaceWith(document.createElement("i"));
    }
  });
}

function updatePlayButton() {
  // SVG elements don't have the .hidden property, so toggle the attribute.
  els.iconPause.toggleAttribute("hidden", !state.playing);
  els.iconPlay.toggleAttribute("hidden", state.playing || state.ended);
  els.iconReplay.toggleAttribute("hidden", !state.ended);
  const label = state.ended ? "Replay" : state.playing ? "Pause (Space)" : "Play (Space)";
  els.playBtn.title = label;
  els.playBtn.setAttribute("aria-label", label);
}

function updateControlsInfo() {
  const s = state.settings;
  const seconds = Number.isInteger(s.duration) ? s.duration : s.duration.toFixed(1);
  const parts = [`${seconds}s per photograph`, TRANSITION_LABELS[s.transition] || s.transition];
  if (s.motion === "kenburns") parts.push("Ken Burns");
  if (s.shuffle) parts.push("Shuffled");
  if (s.background === "blur") parts.push("Blur fill");
  els.controlsInfo.textContent = parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Fullscreen, auto-hiding controls, sharing
// ---------------------------------------------------------------------------

const fullscreenSupported = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const isFullscreen = () => (document.fullscreenElement || document.webkitFullscreenElement) === els.player;

function toggleFullscreen() {
  if (!fullscreenSupported) return;
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    exit.call(document);
  } else {
    const request = els.player.requestFullscreen || els.player.webkitRequestFullscreen;
    const result = request.call(els.player);
    if (result && typeof result.catch === "function") result.catch(() => {});
  }
}

function onFullscreenChange() {
  const on = isFullscreen();
  els.player.classList.toggle("is-fullscreen", on);
  els.iconExpand.toggleAttribute("hidden", on);
  els.iconCompress.toggleAttribute("hidden", !on);
  const label = on ? "Exit fullscreen (F)" : "Fullscreen (F)";
  els.fullscreenBtn.title = label;
  els.fullscreenBtn.setAttribute("aria-label", label);
  scheduleHudHide();
}
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);

// In the window, the controls always stay. In fullscreen they fade out after a
// few seconds of playback and come back on any movement.
function scheduleHudHide() {
  clearTimeout(state.hudTimer);
  els.player.classList.remove("hud-hidden");
  if (!isFullscreen() || !state.playing || !els.panel.hidden || !els.arrangePanel.hidden || !els.exportPanel.hidden) return;
  state.hudTimer = setTimeout(() => {
    // Keep the controls up while the pointer rests on them, or while the name is being edited.
    if (els.bar.matches(":hover") || els.controlsBar.matches(":hover") || els.title.classList.contains("is-editing")) return scheduleHudHide();
    els.player.classList.add("hud-hidden");
  }, HUD_HIDE_MS);
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (els.toast.hidden = true), 2400);
}

async function copyLink() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied — it opens on any device on the same Wi-Fi");
  } catch {
    showToast(url);
  }
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function syncPanel() {
  const s = state.settings;
  els.pDuration.value = String(s.duration);
  els.pDurationOut.textContent = String(s.duration);
  const radio = els.panel.querySelector(`input[name="p-transition"][value="${s.transition}"]`);
  if (radio) radio.checked = true;
  els.pLoop.checked = Boolean(s.loop);
  els.pShuffle.checked = Boolean(s.shuffle);
  els.pMotion.checked = s.motion === "kenburns";
  els.pBlur.checked = s.background === "blur";
}

function setPanelOpen(open) {
  if (open && !els.arrangePanel.hidden) setArrangeOpen(false);
  els.panel.hidden = !open;
  els.settingsBtn.setAttribute("aria-expanded", String(open));
  scheduleHudHide();
}

els.pDuration.addEventListener("input", () => {
  state.settings.duration = Number(els.pDuration.value);
  els.pDurationOut.textContent = els.pDuration.value;
  els.saveStatus.textContent = "Unsaved changes";
  updateControlsInfo();
  if (!state.ended) {
    restartCountdown();
    restartMotion();
    updateProgress();
  }
});

els.panel.addEventListener("change", (e) => {
  if (e.target.name === "p-transition" && TRANSITIONS.includes(e.target.value)) {
    state.settings.transition = e.target.value;
    els.saveStatus.textContent = "Unsaved changes";
    updateControlsInfo();
  }
  if (e.target === els.pLoop) {
    state.settings.loop = els.pLoop.checked;
    els.saveStatus.textContent = "Unsaved changes";
  }
  if (e.target === els.pShuffle) {
    setShuffle(els.pShuffle.checked);
    els.saveStatus.textContent = "Unsaved changes";
  }
  if (e.target === els.pMotion) {
    state.settings.motion = els.pMotion.checked ? "kenburns" : "still";
    restartMotion();
    updateControlsInfo();
    els.saveStatus.textContent = "Unsaved changes";
  }
  if (e.target === els.pBlur) {
    state.settings.background = els.pBlur.checked ? "blur" : "black";
    applyBackground();
    updateControlsInfo();
    els.saveStatus.textContent = "Unsaved changes";
  }
});

els.saveBtn.addEventListener("click", async () => {
  els.saveBtn.disabled = true;
  els.saveStatus.textContent = "Saving…";
  try {
    const res = await fetch(`/api/slideshows/${encodeURIComponent(slideshowId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: state.settings }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.settings = { ...state.settings, ...data.settings };
    syncPanel();
    updateControlsInfo();
    els.saveStatus.textContent = "Saved";
    showToast("Kept — this link now plays this way for everyone");
  } catch (err) {
    els.saveStatus.textContent = `Couldn't save: ${err.message}`;
  } finally {
    els.saveBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Photographs & music: the prints in order (drag one to move it, or use the
// arrows), a Shuffle that deals the stored order anew, and the music track.
// A new order applies at once and is kept on the server right away.
// ---------------------------------------------------------------------------

const ARRANGE_HINT = "Drag a print to move it — the new order is kept right away.";
const ARRANGE_SHUFFLED_HINT = "Shuffle is on, so the show plays these at random. Move a print (or press Play in this order) and Shuffle turns off.";
let arrangeStatusTimer = null;

function setArrangeOpen(open) {
  if (open && !els.panel.hidden) setPanelOpen(false);
  els.arrangePanel.hidden = !open;
  els.arrangeBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    renderArrange();
    refreshArrangeHint();
  }
  scheduleHudHide();
}

// The hint under "Order" says what the order means right now: with Shuffle on
// the stored order is ignored, so say so and offer the way out.
function refreshArrangeHint() {
  if (els.arrangePanel.hidden) return;
  clearTimeout(arrangeStatusTimer);
  els.arrangeStatus.classList.remove("is-error");
  els.arrangeStatus.textContent = state.settings.shuffle ? ARRANGE_SHUFFLED_HINT : ARRANGE_HINT;
  els.arrangeStatus.classList.toggle("is-warning", Boolean(state.settings.shuffle));
  els.arrangeInOrder.hidden = !state.settings.shuffle;
}

function setArrangeStatus(text, revertAfterMs = 0) {
  clearTimeout(arrangeStatusTimer);
  els.arrangeStatus.textContent = text;
  els.arrangeStatus.classList.remove("is-warning");
  els.arrangeStatus.classList.toggle("is-error", /couldn't/i.test(text));
  if (revertAfterMs) arrangeStatusTimer = setTimeout(refreshArrangeHint, revertAfterMs);
}

function renderArrange() {
  const photos = state.slideshow?.photos || [];
  els.arrangeList.replaceChildren(
    ...photos.map((photo, i) => {
      const node = els.arrangeTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = photo.id;
      const img = node.querySelector(".arrange-thumb");
      img.src = photo.url;
      img.alt = photo.name || `Photo ${i + 1}`;
      node.title = photo.name ? `${i + 1} · ${photo.name}` : `Photo ${i + 1}`;
      node.querySelector(".arrange-index").textContent = String(i + 1);
      node.querySelector('[data-action="left"]').disabled = i === 0;
      node.querySelector('[data-action="right"]').disabled = i === photos.length - 1;
      return node;
    }),
  );
  markCurrentPrint();
}

// Outline the print that is on screen.
function markCurrentPrint() {
  if (els.arrangePanel.hidden || state.index < 0) return;
  const current = state.slides[photoAt(state.index)];
  for (const li of els.arrangeList.children) li.classList.toggle("is-current", li.dataset.id === current?.dataset.id);
}

// A new hand-made order of the photographs. The photo on screen stays on
// screen; the slideshow simply continues from its new position.
function applyPhotoOrder(ids) {
  const current = state.index >= 0 ? state.slides[photoAt(state.index)] : null;
  const figuresById = new Map(state.slides.map((f) => [f.dataset.id, f]));
  const photosById = new Map(state.slideshow.photos.map((p) => [p.id, p]));
  state.slides = ids.map((id) => figuresById.get(id));
  state.slideshow.photos = ids.map((id) => photosById.get(id));
  state.slides.forEach((figure, i) => (figure.dataset.index = String(i)));
  const currentIndex = current ? state.slides.indexOf(current) : -1;
  resetOrder(currentIndex);
  state.index = state.settings.shuffle ? 0 : Math.max(0, currentIndex);
  els.counter.textContent = `${state.index + 1} / ${state.order.length}`;
  preloadAround(state.index);
  if (!state.ended) restartCountdown();
  updateProgress();
}

// Keep a change to the show on the server: a new order, and/or Shuffle off.
async function patchShow(body) {
  const res = await fetch(`/api/slideshows/${encodeURIComponent(slideshowId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Arranging the prints by hand means "play them like this" — so if Shuffle is
// on it is turned off (and kept off), otherwise the new order would never show.
async function commitOrder(ids, previous) {
  const wasShuffled = Boolean(state.settings.shuffle);
  if (wasShuffled) {
    state.settings.shuffle = false;
    syncPanel();
    updateControlsInfo();
  }
  applyPhotoOrder(ids);
  renderArrange();
  refreshArrangeHint();
  setArrangeStatus("Saving…");
  try {
    await patchShow(wasShuffled ? { order: ids, settings: { shuffle: false } } : { order: ids });
    setArrangeStatus(wasShuffled ? "Kept — and Shuffle is off, so the show follows this order." : "Kept — this is the order for everyone with the link.", wasShuffled ? 4200 : 2600);
  } catch (err) {
    if (wasShuffled) {
      state.settings.shuffle = true;
      syncPanel();
      updateControlsInfo();
    }
    applyPhotoOrder(previous);
    renderArrange();
    setArrangeStatus(`Couldn't keep the new order: ${err.message}`, 5000);
    showToast(`Couldn't keep the new order: ${err.message}`);
  }
}

// "Play in this order": Shuffle off, kept on the server, no change to the order.
async function playInThisOrder() {
  if (!state.settings.shuffle) return;
  setShuffle(false);
  setArrangeStatus("Saving…");
  try {
    await patchShow({ settings: { shuffle: false } });
    setArrangeStatus("Kept — Shuffle is off, so the show follows this order.", 4200);
  } catch (err) {
    setShuffle(true);
    setArrangeStatus(`Couldn't turn Shuffle off: ${err.message}`, 5000);
  }
}
els.arrangeInOrder.addEventListener("click", playInThisOrder);

dragToReorder(els.arrangeList, {
  itemSelector: ".arrange-item",
  canStart: () => !state.exporting,
  onReorder: (ids, before) => commitOrder(ids, before),
});

els.arrangeList.addEventListener("click", (e) => {
  const item = e.target.closest(".arrange-item");
  if (!item) return;
  const ids = [...els.arrangeList.children].map((li) => li.dataset.id);
  const from = ids.indexOf(item.dataset.id);
  const button = e.target.closest("button[data-action]");
  if (button) {
    const to = button.dataset.action === "left" ? from - 1 : from + 1;
    if (to < 0 || to >= ids.length) return;
    const next = ids.slice();
    [next[from], next[to]] = [next[to], next[from]];
    commitOrder(next, ids);
    return;
  }
  // A plain click on a print shows it.
  const position = state.order.indexOf(from);
  if (position >= 0 && position !== state.index) goTo(position, position > state.index ? 1 : -1);
});

els.arrangeShuffle.addEventListener("click", () => {
  const ids = (state.slideshow?.photos || []).map((p) => p.id);
  if (ids.length < 2) return;
  let next;
  do {
    next = ids.slice();
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
  } while (next.join() === ids.join());
  commitOrder(next, ids);
});

// ---------------------------------------------------------------------------
// Download (video export) — the heavy lifting lives in export.js, loaded on
// first use so the player itself stays light.
// ---------------------------------------------------------------------------

function showExportPanel() {
  els.exportPanel.hidden = false;
  els.exportStatus.textContent = "One moment…";
  els.exportBarFill.style.width = "0%";
  els.exportNote.textContent = "";
  els.exportFormat.textContent = "";
  els.exportCancel.hidden = false;
  els.exportAgain.hidden = true;
  els.exportClose.hidden = true;
  scheduleHudHide();
}

function updateExportProgress(fraction, stage) {
  const pct = Math.round(fraction * 100);
  els.exportStatus.textContent = stage === "Loading photos" ? "Gathering the photographs…" : `Rendering the video… ${pct}%`;
  els.exportBarFill.style.width = `${pct}%`;
}

function formatBytes(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

async function startExport() {
  if (!state.slideshow || state.exporting) return;
  if (!els.panel.hidden) setPanelOpen(false);
  if (!els.arrangePanel.hidden) setArrangeOpen(false);
  pause();

  state.exporting = true;
  els.downloadBtn.disabled = true;
  const controller = new AbortController();
  state.exportController = controller;
  showExportPanel();

  try {
    const { exportSlideshow, downloadBlob, safeFilename } = await import("./export.js");
    const result = await exportSlideshow(
      { photos: state.slideshow.photos, settings: state.settings, music: state.slideshow.music },
      { signal: controller.signal, onProgress: updateExportProgress },
    );
    const filename = safeFilename(state.slideshow.title, result.extension);
    state.lastExport = { blob: result.blob, filename };
    downloadBlob(result.blob, filename);

    els.exportStatus.textContent = `Saved as ${filename}`;
    els.exportBarFill.style.width = "100%";
    const musicNote = result.audioNote ? ` · ${result.audioNote}` : "";
    els.exportNote.textContent = `${formatBytes(result.blob.size)} · ${Math.round(result.seconds)} seconds${musicNote} · it's in your Downloads folder`;
    els.exportFormat.textContent = result.format;
    els.exportCancel.hidden = true;
    els.exportAgain.hidden = false;
    els.exportClose.hidden = false;
    showToast(`Downloaded ${filename}`);
  } catch (err) {
    if (err && err.name === "AbortError") {
      els.exportPanel.hidden = true;
    } else {
      console.error(err);
      els.exportStatus.textContent = "Couldn't create the video";
      els.exportNote.textContent = err && err.message ? err.message : "Something went wrong.";
      els.exportCancel.hidden = true;
      els.exportClose.hidden = false;
    }
  } finally {
    state.exporting = false;
    state.exportController = null;
    els.downloadBtn.disabled = false;
    scheduleHudHide();
  }
}

els.downloadBtn.addEventListener("click", startExport);
els.exportCancel.addEventListener("click", () => state.exportController?.abort());
els.exportClose.addEventListener("click", () => {
  els.exportPanel.hidden = true;
  scheduleHudHide();
});
els.exportAgain.addEventListener("click", async () => {
  if (!state.lastExport) return;
  const { downloadBlob } = await import("./export.js");
  downloadBlob(state.lastExport.blob, state.lastExport.filename);
  showToast(`Downloaded ${state.lastExport.filename}`);
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

// After a mouse click on any control, drop focus from the button so Space keeps
// meaning play/pause instead of re-pressing that button. Keyboard users (who
// reach buttons with Tab, where click.detail is 0) keep their focus.
els.player.addEventListener("click", (e) => {
  const button = e.detail > 0 && e.target.closest("button");
  if (button) button.blur();
});

els.playBtn.addEventListener("click", togglePlay);
els.prevBtn.addEventListener("click", () => goTo(state.index - 1, -1));
els.nextBtn.addEventListener("click", () => goTo(state.index + 1, 1));
els.shareBtn.addEventListener("click", copyLink);
els.settingsBtn.addEventListener("click", () => setPanelOpen(els.panel.hidden));
els.arrangeBtn.addEventListener("click", () => setArrangeOpen(els.arrangePanel.hidden));
els.arrangeClose.addEventListener("click", () => setArrangeOpen(false));
els.fullscreenBtn.addEventListener("click", toggleFullscreen);
if (!fullscreenSupported) els.fullscreenBtn.hidden = true;

// Clicking the photo: close the panel if it's open, otherwise play/pause.
// Double-clicking toggles fullscreen.
els.stage.addEventListener("click", () => {
  if (!state.slides.length) return;
  if (!els.panel.hidden) return setPanelOpen(false);
  if (!els.arrangePanel.hidden) return setArrangeOpen(false);
  togglePlay();
});
els.stage.addEventListener("dblclick", () => {
  if (state.slides.length) toggleFullscreen();
});

for (const type of ["pointermove", "pointerdown", "keydown"]) {
  document.addEventListener(type, scheduleHudHide, { passive: true });
}

document.addEventListener("keydown", (e) => {
  if (!state.slides.length) return;
  if (e.key === "Escape") {
    // Works even while a slider or checkbox in a panel has focus.
    if (!els.panel.hidden) setPanelOpen(false);
    if (!els.arrangePanel.hidden) setArrangeOpen(false);
    if (!els.exportPanel.hidden && !state.exporting) els.exportPanel.hidden = true;
    return;
  }
  if (e.target.closest("input, textarea, select")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // A focused button already handles Space itself; don't toggle twice.
  if (e.key === " " && e.target.closest("button, a")) return;
  switch (e.key) {
    case " ":
    case "k":
      e.preventDefault();
      togglePlay();
      break;
    case "ArrowRight":
    case "l":
      e.preventDefault();
      goTo(state.index + 1, 1);
      break;
    case "ArrowLeft":
    case "j":
      e.preventDefault();
      goTo(state.index - 1, -1);
      break;
    case "Home":
      goTo(0, -1);
      break;
    case "End":
      goTo(state.slides.length - 1, 1);
      break;
    case "f":
      toggleFullscreen();
      break;
    default:
  }
});

init();
