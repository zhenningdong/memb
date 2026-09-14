// memory blue — shared bits for the player and the video exporter:
// the Ken Burns motion plan for each photograph, and shuffling.

export const TRANSITION_S = 0.9; // seconds; the player's TRANSITION_MS / 1000
export const KEN_BURNS_SCALE = 1.08;

// A small deterministic pseudo-random in [0, 1) from an index and a salt, so
// the same photograph always gets the same drift, in the player and the video.
function noise(index, salt) {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The slow drift and zoom for one photograph: either a zoom in or a zoom out,
 * with a gentle sideways/vertical drift. Values are a scale factor and a
 * translation in percent of the frame.
 */
export function kenBurnsPlan(index) {
  const zoomIn = noise(index, 1) < 0.5;
  const dx = (noise(index, 2) - 0.5) * 3.2; // ±1.6 % of the width
  const dy = (noise(index, 3) - 0.5) * 2.2; // ±1.1 % of the height
  const near = { scale: KEN_BURNS_SCALE, x: dx / 2, y: dy / 2 };
  const far = { scale: 1, x: -dx / 2, y: -dy / 2 };
  return zoomIn ? { from: far, to: near } : { from: near, to: far };
}

const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/** The transform at progress p (0..1) through a plan. */
export function kenBurnsAt(plan, p) {
  const e = easeInOut(Math.min(1, Math.max(0, p)));
  return {
    scale: plan.from.scale + (plan.to.scale - plan.from.scale) * e,
    x: plan.from.x + (plan.to.x - plan.from.x) * e,
    y: plan.from.y + (plan.to.y - plan.from.y) * e,
  };
}

/** A random permutation of 0..n-1; never starts with `avoidFirst` when n > 1. */
export function shuffled(n, avoidFirst = -1) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (n > 1 && order[0] === avoidFirst) {
    const k = 1 + Math.floor(Math.random() * (n - 1));
    [order[0], order[k]] = [order[k], order[0]];
  }
  return order;
}
