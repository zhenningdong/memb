// memory blue — click-to-rename, shared by the album cards and the player.
//
// Turns an element that shows a name into one that can be edited in place, the
// way a file is renamed in the Finder or a document in Google Docs: the name
// itself is the control. Click it (or focus it and press Enter) and the text
// becomes a field of exactly the same size, in the same place, with the name
// selected; the field grows and shrinks with what you type. Enter, Tab or a
// click elsewhere keeps the new name, Escape puts the old one back, and an
// empty name is ignored. `save(name)` sends it to the server and resolves with
// the name the server kept (it may tidy it); if saving fails the old name comes
// back and `onError(err)` is called.

const clean = (value) => value.replace(/\s+/g, " ").trim();
const SAVING_DELAY_MS = 180; // only show the "saving" state when a save takes a moment
const SETTLE_MS = 900; // the quiet highlight after a successful save

export function editableTitle(el, { save, label = "Name", maxLength = 80, onError } = {}) {
  let current = clean(el.textContent);
  let editing = false;
  let settleTimer = 0;

  el.classList.add("editable");
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.title = "Rename";
  const describe = () => el.setAttribute("aria-label", `${label}: ${current}. Press Enter to rename.`);
  describe();

  function show(text) {
    current = text;
    el.textContent = text;
    describe();
  }

  function settle() {
    clearTimeout(settleTimer);
    el.classList.add("is-settled");
    settleTimer = setTimeout(() => el.classList.remove("is-settled"), SETTLE_MS);
  }

  function open() {
    if (editing) return;
    editing = true;
    clearTimeout(settleTimer);
    el.classList.remove("is-settled");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "editable-input";
    input.maxLength = maxLength;
    input.value = current;
    input.setAttribute("aria-label", label);
    input.autocomplete = "off";
    input.spellcheck = false;

    // A hidden twin of the text, so the field can be exactly as wide as the name.
    const measure = document.createElement("span");
    measure.className = "editable-measure";
    measure.setAttribute("aria-hidden", "true");
    const fit = () => {
      measure.textContent = input.value || " ";
      input.style.width = `${measure.offsetWidth + 22}px`; // + padding, border and a little room for the caret
    };

    el.classList.add("is-editing");
    el.replaceChildren(input, measure);
    fit();
    input.focus();
    input.select();
    input.addEventListener("input", fit);

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      editing = false;
      el.classList.remove("is-editing");
      const value = clean(input.value);
      if (!commit || !value || value === current) {
        el.textContent = current; // nothing to save
        return;
      }
      const previous = current;
      show(value);
      const savingTimer = setTimeout(() => el.classList.add("is-saving"), SAVING_DELAY_MS);
      Promise.resolve()
        .then(() => save(value))
        .then((kept) => {
          show(typeof kept === "string" && kept ? kept : value);
          settle();
        })
        .catch((err) => {
          show(previous);
          if (onError) onError(err);
        })
        .finally(() => {
          clearTimeout(savingTimer);
          el.classList.remove("is-saving");
        });
    };

    // Hand focus back to the name without drawing a focus ring around it — the
    // person just pressed Enter, and a ring would look like the field is still
    // there. The ring returns for the next Tab/Shift+Tab.
    const refocus = () => {
      el.classList.add("is-quiet");
      el.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
        refocus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // the player closes its panels on Escape — not while renaming
        finish(false);
        refocus();
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  });
  el.addEventListener("keydown", (e) => {
    if (editing) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
  el.addEventListener("blur", () => el.classList.remove("is-quiet"));

  return { get: () => current, set: show, open };
}
