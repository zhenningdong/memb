// memory blue — create page
//
// Lets you pick 3–300 photos (and a piece of music), order them, choose the pace,
// transition and motion, then uploads everything to the server and opens the
// new slideshow.

import { dragToReorder } from "./drag.js";
import { editableTitle } from "./rename.js";

const MIN_PHOTOS = 3;
let MAX_PHOTOS = 300; // the server says what it accepts (see checkServer); this is the fallback
const MAX_EDGE = 2048; // photos larger than this are downscaled before upload
let MAX_PHOTO_MB = 100; // a ProRAW or camera RAW can be big; the server confirms these limits
let MAX_MUSIC_MB = 500; // a lossless track can be 100 MB+ — the server converts it to AAC

// What can be chosen. Browsers show JPG, PNG, WebP, GIF and AVIF as they are;
// the page re-encodes anything else it can decode, and the server converts the
// rest (iPhone HEIC in Chrome, ProRAW DNG, camera RAW, TIFF…) with macOS tools.
const PHOTO_EXT_RE = /\.(jpe?g|jfif|jpe|png|gif|webp|avif|heic|heif|hif|tiff?|bmp|dng|jp2|psd|cr2|cr3|nef|arw|raf|orf|rw2|pef|srw)$/i;
const RAW_EXT_RE = /\.(dng|cr2|cr3|nef|arw|raf|orf|rw2|pef|srw)$/i;
// Formats every browser decodes: these are shrunk here, before upload (see prepareForUpload).
const BROWSER_SAFE_RE = /^image\/(jpeg|png|webp|gif|avif)$/;
const SAFE_EXT_RE = /\.(jpe?g|jfif|jpe|png|webp|gif|avif)$/i;
const UNDO_MS = 8000; // how long "Undo" stays after prints are removed
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || "") || /Mac OS/.test(navigator.userAgent);
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl+";
// Any common music format: MP3 and AAC are stored as they are, everything else
// (FLAC, WAV, AIFF, Apple Lossless, CAF, OGG, Opus, WMA…) is converted to AAC after upload.
const AUDIO_EXT_RE = /\.(mp3|m4a|m4b|m4r|aac|wav|wave|aiff?|aifc|caf|flac|ogg|oga|opus|weba|webm|mka|wma|amr|3gp|ape|alac|ac3|mp2|mpga|dsf|dff|wv|tta|au|snd)$/i;
const AUDIO_KEEP_RE = /\.(mp3|m4a|m4b)$/i;
const TRANSITION_LABELS = { fade: "Dissolve", slide: "Slide", cut: "Cut" };
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
// Numbers in words, the way the page speaks: "twenty-four", "three hundred", "two hundred and eighty-eight".
function words(n) {
  if (n < 0 || n > 999 || !Number.isInteger(n)) return String(n);
  if (n < 20) return WORDS[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${WORDS[n % 10]}` : "");
  return `${WORDS[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${words(n % 100)}` : ""}`;
}
const Words = (n) => words(n).replace(/^./, (c) => c.toUpperCase());

const $ = (sel) => document.querySelector(sel);
const els = {
  form: $("#create-form"),
  dropzone: $("#dropzone"),
  fileInput: $("#file-input"),
  photoNotice: $("#photo-notice"),
  photoList: $("#photo-list"),
  photoActions: $("#photo-actions"),
  photoHint: $("#photo-hint"),
  selectionBar: $("#selection-bar"),
  selectionCount: $("#selection-count"),
  selectNone: $("#select-none"),
  selectAll: $("#select-all"),
  removeSelected: $("#remove-selected"),
  toast: $("#page-toast"),
  toastText: $("#page-toast-text"),
  toastUndo: $("#page-toast-undo"),
  title: $("#title"),
  duration: $("#duration"),
  durationOut: $("#duration-out"),
  error: $("#form-error"),
  createBtn: $("#create-btn"),
  libraryList: $("#library-list"),
  libraryEmpty: $("#library-empty"),
  libraryCount: $("#library-count"),
  shuffleBtn: $("#shuffle-btn"),
  motionToggle: $("#motion"),
  shuffleToggle: $("#shuffle"),
  blurToggle: $("#blurfill"),
  musicInput: $("#music-input"),
  musicChoose: $("#music-choose"),
  musicName: $("#music-name"),
  musicRemove: $("#music-remove"),
  photoTemplate: $("#photo-item-template"),
  libraryTemplate: $("#library-item-template"),
  serverNotice: $("#server-notice"),
  serverNoticeTitle: $("#server-notice-title"),
  serverNoticeText: $("#server-notice-text"),
};

/** @type {{ id: string, file: File, url: string }[]} */
let photos = [];
/** @type {{ file: File, duration: number | null } | null} */
let music = null;
let busy = false;

// ---------------------------------------------------------------------------
// Picking photos
// ---------------------------------------------------------------------------

const isHeic = (file) => /\.(heic|heif|hif)$/i.test(file.name) || /^image\/hei[cf]/.test(file.type);
const isRaw = (file) => RAW_EXT_RE.test(file.name) || file.type === "image/x-adobe-dng";

function isImage(file) {
  return (file.type.startsWith("image/") && file.type !== "image/svg+xml") || PHOTO_EXT_RE.test(file.name);
}

// A JPG or PNG is shrunk to 2048px in this browser before it is uploaded, so
// its size on disk doesn't matter (a 100 MB PNG becomes a 2 MB upload). The
// formats the browser can't decode go to the server as they are — those have
// to fit the server's limit.
const shrinksHere = (file) => BROWSER_SAFE_RE.test(file.type) && SAFE_EXT_RE.test(file.name);
const tooBigToSend = (file) => !shrinksHere(file) && file.size > MAX_PHOTO_MB * 1024 * 1024;

/**
 * Adds the chosen or dropped files to the page and says, right under the
 * drop zone, what happened to anything that wasn't added.
 * @param {Iterable<File>} fileList
 * @param {"dialog" | "drop"} source
 */
function addFiles(fileList, source = "drop") {
  const all = Array.from(fileList || []);
  const images = all.filter(isImage);
  const sendable = images.filter((f) => !tooBigToSend(f));
  const room = Math.max(0, MAX_PHOTOS - photos.length);
  const accepted = sendable.slice(0, room);

  if (accepted.length) settleUndo(); // the page has moved on; an earlier removal stays removed
  for (const file of accepted) {
    const photo = { id: Math.random().toString(36).slice(2), file, url: URL.createObjectURL(file), thumbUrl: null, prepared: null, ready: null };
    photo.ready = enqueue(() => makeVersions(photo));
    photos.push(photo);
  }

  const notes = [];
  const others = all.length - images.length;
  if (others > 0) {
    notes.push(`${Words(others)} ${others === 1 ? "file wasn't" : "files weren't"} added — only photographs go on the page (JPG, PNG, HEIC, WebP, TIFF, RAW…).`);
  }
  const big = images.find(tooBigToSend);
  if (big) {
    const more = images.length - sendable.length - 1;
    notes.push(
      `${big.name} is ${Math.round(big.size / 1024 / 1024)} MB${more > 0 ? ` (and ${words(more)} more like it)` : ""} — a photograph in this format is sent as it is, and the server takes up to ${MAX_PHOTO_MB} MB. Exported as a JPEG it will be fine.`,
    );
  }
  if (sendable.length > room) {
    notes.push(
      room === 0
        ? `The page is full — a slideshow holds ${words(MAX_PHOTOS)} photographs. Take one away to add another.`
        : `A slideshow holds ${words(MAX_PHOTOS)} photographs — the first ${words(room)} were added.`,
    );
  }
  // One photograph from the file window, on a page that needs more: most likely
  // several were meant. (A double-click in the file window opens only that one.)
  if (source === "dialog" && all.length === 1 && accepted.length === 1 && photos.length < MIN_PHOTOS) {
    notes.push(
      `One photograph added. To add several at once, select them all in the file window — click the first, ⇧-click the last, or ${MOD_KEY}A for the whole folder — and press Open; a double-click opens just the one you clicked.`,
    );
  }
  setPhotoNotice(notes.join(" "));
  showError("");
  renderPhotos();
}

function setPhotoNotice(text) {
  els.photoNotice.textContent = text;
  els.photoNotice.hidden = !text;
}

// Dropped folders: every photograph inside (subfolders too), in name order,
// the way the camera numbered them.
async function filesFromEntries(entries) {
  const out = [];
  const readAll = (dir) =>
    new Promise((resolve, reject) => {
      const reader = dir.createReader();
      const found = [];
      const step = () => reader.readEntries((batch) => (batch.length ? (found.push(...batch), step()) : resolve(found)), reject);
      step();
    });
  const walk = async (entry, depth) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject)).catch(() => null);
      if (file) out.push(file);
    } else if (entry.isDirectory && depth < 6) {
      const children = (await readAll(entry).catch(() => [])).filter((child) => !child.name.startsWith("."));
      children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const child of children) await walk(child, depth + 1);
    }
  };
  for (const entry of entries) if (entry) await walk(entry, 0);
  return out;
}

// ---------------------------------------------------------------------------
// One decode per photograph, in the background, as soon as it is added: a
// small print for the page and the 2048px copy that gets uploaded. A camera
// PNG can be 24 megapixels and 40 MB; shown as it is, the browser would decode
// it again on every repaint (a hover, a selection ring), and the page would
// drag. Two at a time, so the page stays responsive while they are made.
// ---------------------------------------------------------------------------

const THUMB_EDGE = 320; // the print is 134px wide, twice that on a Retina screen
const AT_ONCE = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2))); // decodes in flight
const queue = { running: 0, waiting: [] };

function enqueue(job) {
  return new Promise((resolve) => {
    queue.waiting.push(() => job().catch(() => {}).then(resolve));
    pump();
  });
}

function pump() {
  while (queue.running < AT_ONCE && queue.waiting.length) {
    const job = queue.waiting.shift();
    queue.running++;
    job().finally(() => {
      queue.running--;
      pump();
    });
  }
}

async function makeVersions(photo) {
  if (!shrinksHere(photo.file)) return; // HEIC, RAW…: the page shows what it can, the server converts
  let bitmap;
  try {
    bitmap = await createImageBitmap(photo.file, { imageOrientation: "from-image" });
  } catch {
    showThumb(photo); // let the <img> try, and say so if it can't
    return;
  }
  try {
    const alpha = photo.file.type === "image/png" && hasAlpha(bitmap);
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
    const thumb = await encode(bitmap, scale, alpha ? "image/png" : "image/jpeg", 0.84);
    const live = photos.includes(photo) || Boolean(undo?.removed.some((r) => r.photo === photo));
    if (!live) return; // removed for good while this was being made
    if (thumb) photo.thumbUrl = URL.createObjectURL(thumb);
    showThumb(photo);
    photo.prepared = await uploadCopy(bitmap, photo.file, alpha);
  } finally {
    bitmap.close();
  }
}

// Does the picture use its alpha channel? (A 32px sample is enough to tell.)
function hasAlpha(source) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

const sizeOf = (source) => ({ width: source.naturalWidth || source.width, height: source.naturalHeight || source.height });

function encode(source, scale, type, quality) {
  const { width, height } = sizeOf(source);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// The copy that is uploaded: at most 2048px on the long edge, as a JPEG unless
// the picture is transparent (then PNG). Small originals are sent as they are.
async function uploadCopy(source, file, alpha) {
  const safe = shrinksHere(file); // a format every browser shows: small originals can go as they are
  const { width, height } = sizeOf(source);
  const longEdge = Math.max(width, height);
  if (safe && longEdge <= MAX_EDGE && file.size < 2.5 * 1024 * 1024) return file;
  const type = alpha ? "image/png" : "image/jpeg";
  const blob = await encode(source, Math.min(1, MAX_EDGE / longEdge), type, 0.9);
  if (!blob) return file;
  if (safe && blob.size >= file.size) return file; // already compact — keep the original bytes
  const name = file.name.replace(/\.[^.]+$/, "") + (type === "image/png" ? ".png" : ".jpg");
  return new File([blob], name, { type, lastModified: file.lastModified });
}

function showThumb(photo) {
  const node = els.photoList.querySelector(`.photo-item[data-id="${photo.id}"]`);
  if (!node) return;
  const img = node.querySelector(".photo-thumb");
  if (img.getAttribute("src") !== (photo.thumbUrl || photo.url)) img.src = photo.thumbUrl || photo.url;
  node.classList.remove("is-loading");
}

// ---------------------------------------------------------------------------
// Removing prints — one with its ×, or several at once: click prints to select
// them (⇧-click selects a run), then "Remove". Removing is undoable for a few
// seconds rather than asking "are you sure?".
// ---------------------------------------------------------------------------

const selected = new Set(); // ids of the selected prints
let anchorId = null; // the print a ⇧-click run starts from
let undo = null; // { removed: [{ index, photo }], timer } while "Undo" is on offer

function removePhotos(ids) {
  const going = new Set(ids);
  const removed = photos.map((photo, index) => ({ index, photo })).filter(({ photo }) => going.has(photo.id));
  if (!removed.length) return;
  photos = photos.filter((photo) => !going.has(photo.id));
  for (const id of going) selected.delete(id);
  if (going.has(anchorId)) anchorId = null;
  setPhotoNotice("");
  showError("");
  renderPhotos();
  offerUndo(removed);
}

function offerUndo(removed) {
  settleUndo();
  undo = { removed, timer: setTimeout(settleUndo, UNDO_MS) };
  const n = removed.length;
  els.toastText.textContent = n === 1 ? "Photograph removed." : `${Words(n)} photographs removed.`;
  els.toast.hidden = false;
}

// The offer lapses: the removed prints' previews can go.
function settleUndo() {
  if (!undo) return;
  clearTimeout(undo.timer);
  for (const { photo } of undo.removed) {
    URL.revokeObjectURL(photo.url);
    if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);
  }
  undo = null;
  els.toast.hidden = true;
}

function undoRemove() {
  if (!undo) return;
  clearTimeout(undo.timer);
  // Back into their old slots, lowest first, so each slot exists when its print returns.
  for (const { index, photo } of [...undo.removed].sort((a, b) => a.index - b.index)) {
    photos.splice(Math.min(index, photos.length), 0, photo);
  }
  undo = null;
  els.toast.hidden = true;
  renderPhotos();
}

function toggleSelect(id, { range = false } = {}) {
  const at = photos.findIndex((p) => p.id === id);
  const from = photos.findIndex((p) => p.id === anchorId);
  if (at === -1) return;
  if (range && from !== -1) {
    for (let i = Math.min(from, at); i <= Math.max(from, at); i++) selected.add(photos[i].id);
  } else if (selected.has(id)) {
    selected.delete(id);
    anchorId = null;
  } else {
    selected.add(id);
    anchorId = id;
  }
  refreshSelection();
}

function selectAllPhotos() {
  for (const photo of photos) selected.add(photo.id);
  refreshSelection();
}

function clearSelection() {
  selected.clear();
  anchorId = null;
  refreshSelection();
}

// Paints the selection: rings on the prints, and the selection bar (count,
// Select all, Remove) in place of the hint and Shuffle while anything is selected.
function refreshSelection() {
  for (const id of selected) if (!photos.some((p) => p.id === id)) selected.delete(id);
  const n = selected.size;
  for (const node of els.photoList.children) {
    const on = selected.has(node.dataset.id);
    node.classList.toggle("is-selected", on);
    const box = node.querySelector(".photo-select");
    box.setAttribute("aria-checked", String(on));
    box.title = on ? "Deselect" : "Select";
  }
  els.photoList.classList.toggle("is-selecting", n > 0);
  els.photoActions.classList.toggle("is-selecting", n > 0);
  els.selectionBar.hidden = n === 0;
  els.photoHint.hidden = n > 0;
  els.shuffleBtn.hidden = n > 0 || photos.length < 2;
  if (n > 0) {
    // Same bar whatever is selected: the count, one button that flips between
    // Select all and Deselect all, and Remove. ("Four photographs selected"; on a phone "Four selected".)
    const all = n === photos.length;
    els.selectionCount.innerHTML = `${Words(n)}<span class="wide-only"> photograph${n === 1 ? "" : "s"}</span> selected`;
    els.selectAll.textContent = all ? "Deselect all" : "Select all";
    els.selectAll.title = all ? "Keep everything (Esc)" : `Select every print (${MOD_KEY}A)`;
  }
}

function movePhoto(id, delta) {
  const index = photos.findIndex((p) => p.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= photos.length) return;
  [photos[index], photos[target]] = [photos[target], photos[index]];
  renderPhotos();
}

function renderPhotos() {
  els.photoList.replaceChildren(
    ...photos.map((photo, i) => {
      const node = els.photoTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = photo.id;
      const img = node.querySelector(".photo-thumb");
      img.alt = photo.file.name;
      // A small print once it is made (see makeVersions); until then a blank
      // print, not the 40 MB original. Formats the page doesn't shrink are shown as they are.
      if (photo.thumbUrl || !shrinksHere(photo.file)) img.src = photo.thumbUrl || photo.url;
      else node.classList.add("is-loading");
      // Chrome can't show HEIC, RAW or TIFF previews; the server converts them after upload.
      img.addEventListener("error", () => {
        node.classList.add("is-undecodable");
        const note = node.querySelector(".photo-note");
        note.textContent = isHeic(photo.file)
          ? "iPhone photo — converted when you make the slideshow"
          : isRaw(photo.file)
            ? "RAW photo — converted when you make the slideshow"
            : "Converted when you make the slideshow";
        note.hidden = false;
      });
      node.querySelector(".photo-index").textContent = String(i + 1);
      node.querySelector('[data-action="left"]').disabled = i === 0;
      node.querySelector('[data-action="right"]').disabled = i === photos.length - 1;
      return node;
    }),
  );

  const n = photos.length;
  els.dropzone.classList.toggle("is-full", n >= MAX_PHOTOS);
  els.shuffleBtn.hidden = n < 2;
  els.photoHint.classList.toggle("ok", n >= MIN_PHOTOS);
  if (n === 0) {
    els.photoHint.textContent = "No photographs yet.";
  } else if (n < MIN_PHOTOS) {
    const more = MIN_PHOTOS - n;
    els.photoHint.textContent = `${Words(n)} photograph${n === 1 ? "" : "s"} — add ${words(more)} more and it becomes a slideshow.`;
  } else if (n < MAX_PHOTOS) {
    const room = MAX_PHOTOS - n;
    els.photoHint.textContent = `${Words(n)} photographs, in this order. Room for ${words(room)} more, if you like.`;
  } else {
    els.photoHint.textContent = `${Words(n)} photographs, in this order — the page is full.`;
  }
  refreshSelection();
  updateButton();
}

function refreshPhotoMeta() {
  [...els.photoList.children].forEach((node, i) => {
    node.querySelector(".photo-index").textContent = String(i + 1);
    node.querySelector('[data-action="left"]').disabled = i === 0;
    node.querySelector('[data-action="right"]').disabled = i === photos.length - 1;
  });
}

function updateButton() {
  els.createBtn.disabled = busy || photos.length < MIN_PHOTOS || photos.length > MAX_PHOTOS;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

function setBusy(isBusy, label) {
  busy = isBusy;
  els.createBtn.textContent = isBusy ? label : "Make the slideshow";
  els.form.querySelectorAll("input, button").forEach((el) => {
    if (el !== els.createBtn) el.disabled = isBusy;
  });
  if (!isBusy) renderPhotos(); // restores per-photo button states
  updateButton();
}

// Dropzone
els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files, "dialog");
  els.fileInput.value = ""; // so the same file can be chosen again after removing it
});

els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});

for (const type of ["dragenter", "dragover"]) {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    if (!busy) els.dropzone.classList.add("is-dragging");
  });
}
for (const type of ["dragleave", "dragend", "drop"]) {
  els.dropzone.addEventListener(type, () => els.dropzone.classList.remove("is-dragging"));
}
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  if (busy) return;
  const dt = e.dataTransfer;
  // A dropped folder arrives as a directory entry; those have to be taken while
  // the event is live, and are read afterwards.
  const entries = [...(dt.items || [])].map((item) => (item.kind === "file" && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null));
  if (entries.some((entry) => entry?.isDirectory)) {
    filesFromEntries(entries).then((files) => addFiles(files, "drop"));
  } else {
    addFiles(dt.files, "drop");
  }
});
// Dropping a file outside the zone shouldn't navigate away from the page.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

els.photoList.addEventListener("click", (e) => {
  if (busy) return;
  const item = e.target.closest(".photo-item");
  if (!item || item.parentElement !== els.photoList) return;
  const id = item.dataset.id;
  const button = e.target.closest("button[data-action]");
  if (button) {
    if (button.dataset.action === "remove") removePhotos([id]);
    if (button.dataset.action === "left") movePhoto(id, -1);
    if (button.dataset.action === "right") movePhoto(id, +1);
    return;
  }
  // The print itself, or its circle: select it (⇧-click: every print between the last one clicked and this one).
  toggleSelect(id, { range: e.shiftKey });
});

els.selectNone.addEventListener("click", clearSelection);
els.selectAll.addEventListener("click", () => (selected.size === photos.length ? clearSelection() : selectAllPhotos()));
els.removeSelected.addEventListener("click", () => {
  if (!busy) removePhotos([...selected]);
});
els.toastUndo.addEventListener("click", undoRemove);

// Keys: Esc clears the selection, Delete / Backspace removes it, ⌘A selects
// every print (while a selection is on, or the prints have the focus).
document.addEventListener("keydown", (e) => {
  if (busy) return;
  const target = e.target instanceof Element ? e.target : null;
  const typing = Boolean(target?.closest("textarea, [contenteditable], input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file])"));
  if (e.key === "Escape" && selected.size) {
    clearSelection();
  } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size && !typing) {
    e.preventDefault();
    removePhotos([...selected]);
  } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "a" && !typing && photos.length && (selected.size || els.photoList.contains(target))) {
    e.preventDefault();
    selectAllPhotos();
  }
});

els.duration.addEventListener("input", () => {
  els.durationOut.textContent = els.duration.value;
});

// Deal the prints out again in a random order (Fisher–Yates).
els.shuffleBtn.addEventListener("click", () => {
  if (busy || photos.length < 2) return;
  const before = photos.map((p) => p.id).join();
  do {
    for (let i = photos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [photos[i], photos[j]] = [photos[j], photos[i]];
    }
  } while (photos.map((p) => p.id).join() === before);
  showError("");
  renderPhotos();
});

// ---------------------------------------------------------------------------
// Drag a print to move it (shared with the player — see drag.js).
// ---------------------------------------------------------------------------

dragToReorder(els.photoList, {
  itemSelector: ".photo-item",
  canStart: () => !busy,
  onReorder: (order) => {
    photos.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    refreshPhotoMeta();
  },
});

// ---------------------------------------------------------------------------
// Music (optional)
// ---------------------------------------------------------------------------

function isAudio(file) {
  return file.type.startsWith("audio/") || AUDIO_EXT_RE.test(file.name);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderMusic() {
  const has = Boolean(music);
  els.musicName.hidden = !has;
  els.musicRemove.hidden = !has;
  els.musicChoose.querySelector("span").textContent = has ? "Change" : "Choose a track";
  if (has) {
    const size = music.file.size >= 1024 * 1024 ? ` · ${Math.round(music.file.size / 1024 / 1024)} MB` : "";
    const length = music.duration ? ` · ${formatDuration(music.duration)}` : "";
    // Whatever the format, it becomes AAC on the server (MP3 and M4A are kept as they are).
    const note = !AUDIO_KEEP_RE.test(music.file.name) && music.checked ? " · converted for the slideshow" : "";
    els.musicName.textContent = `${music.file.name}${length}${size}${note}`;
  }
}

function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.addEventListener("loadedmetadata", () => done(Number.isFinite(audio.duration) ? audio.duration : null), { once: true });
    audio.addEventListener("error", () => done(null), { once: true });
    audio.src = url;
  });
}

els.musicChoose.addEventListener("click", () => els.musicInput.click());
els.musicRemove.addEventListener("click", () => {
  music = null;
  showError("");
  renderMusic();
});
els.musicInput.addEventListener("change", async () => {
  const file = els.musicInput.files[0];
  els.musicInput.value = "";
  if (!file) return;
  if (!isAudio(file)) return showError(`${file.name} doesn't look like an audio file (MP3, M4A, FLAC, WAV, AIFF, OGG…).`);
  if (file.size > MAX_MUSIC_MB * 1024 * 1024) {
    return showError(`${file.name} is ${Math.round(file.size / 1024 / 1024)} MB — music must be under ${MAX_MUSIC_MB} MB.`);
  }
  showError("");
  music = { file, duration: null, checked: false };
  renderMusic();
  // The length, when this browser can read the format (it may not — the server converts it anyway).
  const duration = await readDuration(file);
  if (music && music.file === file) {
    music.duration = duration;
    music.checked = true;
    renderMusic();
  }
});

// ---------------------------------------------------------------------------
// Preparing + uploading
// ---------------------------------------------------------------------------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read ${file.name}`));
    };
    img.src = url;
  });
}

// Phone photos are often 4000px+ and 5–10 MB. The slideshow never shows more
// than the screen can display, so big images are shrunk before uploading —
// JPG and PNG in the background as soon as they are added (makeVersions), the
// rest here, at upload time: formats browsers can't show (HEIC, TIFF, RAW…)
// are re-encoded whenever this browser can decode them (Safari reads HEIC and
// TIFF, for instance); anything it can't decode is sent untouched for the
// server to convert.
async function prepareForUpload(photo) {
  await photo.ready;
  if (photo.prepared) return photo.prepared;
  const { file } = photo;
  let img;
  try {
    img = await loadImage(file);
  } catch {
    return file; // e.g. HEIC or RAW in Chrome — the server converts it instead
  }
  return uploadCopy(img, file, file.type === "image/png" && hasAlpha(img));
}

function uploadWithProgress(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const data = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Couldn't reach the server. Is it still running?"));
    xhr.send(body);
  });
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy || photos.length < MIN_PHOTOS || photos.length > MAX_PHOTOS) return;

  showError("");
  setBusy(true, "Preparing photographs…");
  try {
    const prepared = [];
    for (const [i, photo] of photos.entries()) {
      setBusy(true, `Preparing photograph ${i + 1} of ${photos.length}…`);
      prepared.push(await prepareForUpload(photo));
    }

    const data = new FormData();
    data.append("title", els.title.value);
    data.append("duration", els.duration.value);
    data.append("transition", els.form.elements.transition.value);
    data.append("motion", els.motionToggle.checked ? "kenburns" : "still");
    data.append("shuffle", els.shuffleToggle.checked ? "true" : "false");
    data.append("background", els.blurToggle.checked ? "blur" : "black");
    for (const file of prepared) data.append("photos", file, file.name);
    if (music) data.append("music", music.file, music.file.name);

    const converting = music && !AUDIO_KEEP_RE.test(music.file.name);
    const slideshow = await uploadWithProgress("/api/slideshows", data, (pct) =>
      setBusy(true, pct < 100 ? `Uploading… ${pct}%` : converting ? "Converting the music — a long track takes a moment…" : "Making the slideshow…"),
    );
    setBusy(true, "Opening your slideshow…");
    location.href = `/s/${slideshow.id}`;
  } catch (err) {
    let message = err.message || "Something went wrong.";
    // An old server refuses what this page allows ("at most 5 photos", an
    // unexpected "music" field…). Say why, rather than leaving a riddle.
    if (serverState === "old" || serverState === "restart") {
      message += " — the server is still running an older version of memory blue; restart it (see the note at the top of the page).";
    }
    showError(message);
    setBusy(false);
  }
});

// ---------------------------------------------------------------------------
// Is the server as new as this page? Node keeps running the code it was
// started with, so after an update the pages (read from disk) are new while
// the server program is still old, and uploads fail in puzzling ways. The
// server tells us its version and limit; an old server has no such route.
// ---------------------------------------------------------------------------

let serverState = "ok"; // "ok" | "old" | "restart" | "offline"

const SERVER_NOTICES = {
  old: {
    title: "The server is running an older version of memory blue",
    text: "This page is up to date, but the server program was started before the update and still follows the old rules — for instance a limit of five photographs and no music. Nothing is lost; it just needs to be started again.",
  },
  restart: {
    title: "memory blue was updated — the server needs a restart",
    text: "The server program changed after it was started, so it is still running the old code.",
  },
  offline: {
    title: "The server isn't answering",
    text: "memory blue's server doesn't seem to be running, so photographs can't be uploaded and the album can't be opened.",
  },
};

function showServerNotice(state) {
  const notice = SERVER_NOTICES[state];
  els.serverNotice.hidden = !notice;
  if (!notice) return;
  els.serverNoticeTitle.textContent = notice.title;
  els.serverNoticeText.textContent = notice.text;
}

async function checkServer() {
  let state = "ok";
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (res.status === 404) {
      state = "old";
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      const info = await res.json();
      if (info.needsRestart) state = "restart";
      if (Number.isInteger(info.maxPhotos) && info.maxPhotos >= MIN_PHOTOS && info.maxPhotos !== MAX_PHOTOS) {
        MAX_PHOTOS = info.maxPhotos;
        renderPhotos();
      }
      if (Number.isInteger(info.maxPhotoMb) && info.maxPhotoMb > 0) MAX_PHOTO_MB = info.maxPhotoMb;
      if (Number.isInteger(info.maxMusicMb) && info.maxMusicMb > 0) MAX_MUSIC_MB = info.maxMusicMb;
    }
  } catch {
    state = "offline";
  }
  return state;
}

async function watchServer() {
  serverState = await checkServer();
  showServerNotice(serverState);
  if (serverState === "ok") return;
  // Keep asking; the moment a fresh server answers, reload so the page and
  // the album come back in step with it.
  const timer = setInterval(async () => {
    const state = await checkServer();
    if (state === "ok") {
      clearInterval(timer);
      location.reload();
      return;
    }
    if (state !== serverState) {
      serverState = state;
      showServerNotice(state);
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Library of existing slideshows
// ---------------------------------------------------------------------------

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderLibrary(items) {
  els.libraryList.replaceChildren(
    ...items.map((item) => {
      const node = els.libraryTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.id = item.id;
      const href = `/s/${item.id}`;
      node.querySelectorAll("a").forEach((a) => (a.href = href));
      const cover = node.querySelector(".library-cover");
      cover.src = item.cover || "";
      cover.alt = "";
      const title = node.querySelector(".library-title");
      title.textContent = item.title;
      const meta = node.querySelector(".library-meta");
      // Click the name to rename it, right there on the card.
      editableTitle(title, {
        label: "Slideshow name",
        save: (name) => renameSlideshow(item.id, name),
        onError: (err) => {
          renderMeta(meta, item, `Couldn't rename — ${err.message}`);
          setTimeout(() => renderMeta(meta, item), 4000);
        },
      });
      renderMeta(meta, item);
      return node;
    }),
  );
  els.libraryEmpty.textContent = "Nothing kept yet — the first slideshow you make will live here.";
  els.libraryEmpty.hidden = items.length > 0;
  els.libraryCount.textContent = items.length ? `${items.length} kept` : "";
}

// Two lines, always — so every card in a row is the same height and the
// Watch / Delete row sits on one line across the album. The first line is
// what the slideshow is; the second, how it plays (cut short with an ellipsis
// if it runs long; the full text is in the tooltip).
function renderMeta(meta, item, notice = "") {
  const first = `${item.photoCount} photographs · ${formatDate(item.createdAt)}`;
  const traits = [
    `${item.settings.duration}s each`,
    TRANSITION_LABELS[item.settings.transition] || item.settings.transition,
    item.settings.motion === "kenburns" ? "Ken Burns" : null,
    item.settings.shuffle ? "shuffled" : null,
    item.settings.background === "blur" ? "blur fill" : null,
    item.hasMusic ? "with music" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = notice ? [first, notice] : [first, traits];
  meta.replaceChildren(
    ...lines.map((text, i) => {
      const line = document.createElement("span");
      line.className = "library-meta-line" + (notice && i === 1 ? " is-error" : "");
      line.textContent = text;
      return line;
    }),
  );
  meta.title = `${first} · ${traits}`;
}

async function renameSlideshow(id, title) {
  const res = await fetch(`/api/slideshows/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (res.status === 404 ? "this slideshow no longer exists" : `HTTP ${res.status}`));
  return data.title;
}

async function loadLibrary() {
  try {
    const res = await fetch("/api/slideshows", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderLibrary(await res.json());
  } catch {
    els.libraryList.replaceChildren();
    els.libraryEmpty.textContent = "Couldn't open the album — is the server running?";
    els.libraryEmpty.hidden = false;
    els.libraryCount.textContent = "";
  }
}

// Delete is a two-step button (click, then confirm) instead of a browser dialog.
els.libraryList.addEventListener("click", async (e) => {
  const button = e.target.closest('button[data-action="delete"]');
  if (!button) return;
  const item = button.closest(".library-item");

  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.textContent = "Delete? Click again";
    clearTimeout(button._disarm);
    button._disarm = setTimeout(() => {
      button.dataset.armed = "";
      button.textContent = "Delete";
    }, 3500);
    return;
  }

  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    const res = await fetch(`/api/slideshows/${item.dataset.id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    item.remove();
    const left = els.libraryList.children.length;
    els.libraryEmpty.hidden = left > 0;
    els.libraryCount.textContent = left ? `${left} kept` : "";
  } catch {
    button.disabled = false;
    button.dataset.armed = "";
    button.textContent = "Couldn't delete — try again";
  }
});

// ---------------------------------------------------------------------------

renderPhotos();
renderMusic();
loadLibrary();
watchServer();
window.addEventListener("pageshow", (e) => {
  if (e.persisted) loadLibrary(); // coming back via the back button
});
