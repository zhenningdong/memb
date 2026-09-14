// memory blue — drag a print to move it, shared by the create page and the
// player's "Photographs & music" panel.
//
// Mouse: the drag starts after a small movement. Touch: after a short press (a
// quick swipe still scrolls the page). While dragging, a ghost of the print
// follows the pointer and the real print slides into its new slot; when the
// pointer is released `onReorder(ids)` gets the new order (the items' data-id,
// in DOM order) — only if it actually changed. Holding a print near the top or
// bottom edge scrolls the page (or the panel) so a print can travel the length
// of a long list.

const EDGE = 64; // px from the edge where scrolling starts
const MAX_STEP = 22; // px per frame at the very edge

export function dragToReorder(list, { itemSelector, onReorder, canStart = () => true }) {
  let drag = null;

  const items = () => [...list.children].filter((el) => el.matches(itemSelector));
  const ids = () => items().map((el) => el.dataset.id);

  // The nearest ancestor that scrolls (the panel), or the window.
  function scrollerOf(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  }

  function activate(e) {
    const rect = drag.item.getBoundingClientRect();
    drag.active = true;
    drag.offsetX = e.clientX - rect.left;
    drag.offsetY = e.clientY - rect.top;
    const ghost = drag.item.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.item.classList.add("is-dragging");
    document.body.classList.add("is-reordering");
    drag.scroller = scrollerOf(list);
    drag.raf = requestAnimationFrame(tick);
    try {
      drag.item.setPointerCapture(e.pointerId);
    } catch {
      /* not critical */
    }
  }

  function end() {
    if (!drag) return;
    clearTimeout(drag.timer);
    cancelAnimationFrame(drag.raf);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    const wasActive = drag.active;
    if (wasActive) {
      drag.ghost.remove();
      drag.item.classList.remove("is-dragging");
      document.body.classList.remove("is-reordering");
    }
    const before = drag.before;
    drag = null;
    if (wasActive) {
      // The click the browser fires after a drag is not a click on the print.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      list.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => list.removeEventListener("click", swallow, { capture: true }), 0);
      const after = ids();
      if (after.join("\n") !== before.join("\n")) onReorder(after, before);
    }
  }

  // Slides the print into the slot under the pointer.
  function place(x, y) {
    const over = document
      .elementsFromPoint(x, y)
      .find((el) => el !== drag.item && !el.classList.contains("drag-ghost") && el.matches?.(itemSelector) && el.parentElement === list);
    if (!over) return;
    const r = over.getBoundingClientRect();
    // Prints sit in rows: decide by the horizontal middle when they share a row,
    // by the vertical middle otherwise.
    const sameRow = Math.abs(r.top - drag.item.getBoundingClientRect().top) < r.height / 2;
    const wantBefore = sameRow ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    if (wantBefore && over.previousElementSibling !== drag.item) over.before(drag.item);
    else if (!wantBefore && over.nextElementSibling !== drag.item) over.after(drag.item);
  }

  // Every frame while dragging: scroll when the pointer is held near an edge,
  // then re-place the print, since what lies under a still pointer has moved.
  function tick() {
    if (!drag?.active) return;
    drag.raf = requestAnimationFrame(tick);
    const { x, y, scroller } = drag;
    if (x === undefined) return;
    const top = scroller ? scroller.getBoundingClientRect().top : 0;
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    let step = 0;
    if (y < top + EDGE) step = -Math.ceil(((top + EDGE - y) / EDGE) * MAX_STEP);
    else if (y > bottom - EDGE) step = Math.ceil(((y - (bottom - EDGE)) / EDGE) * MAX_STEP);
    if (!step) return;
    const before = scroller ? scroller.scrollTop : window.scrollY;
    if (scroller) scroller.scrollTop += step;
    else window.scrollBy(0, step);
    if ((scroller ? scroller.scrollTop : window.scrollY) !== before) place(x, y);
  }

  function move(e) {
    if (!drag) return;
    if (!drag.active) {
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (moved < 6) return;
      if (e.pointerType === "touch") return end(); // a swipe, not a press
      activate(e);
    }
    e.preventDefault();
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.ghost.style.left = `${e.clientX - drag.offsetX}px`;
    drag.ghost.style.top = `${e.clientY - drag.offsetY}px`;
    place(e.clientX, e.clientY);
  }

  list.addEventListener("pointerdown", (e) => {
    if (drag || !canStart() || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.target.closest("button, a, input")) return;
    const item = e.target.closest(itemSelector);
    if (!item || item.parentElement !== list) return;
    drag = { item, startX: e.clientX, startY: e.clientY, active: false, timer: null, before: ids() };
    if (e.pointerType === "touch") drag.timer = setTimeout(() => drag && !drag.active && activate(e), 220);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  });

  return { cancel: end };
}
