/**
 * Deterministic pseudo-randomness.
 *
 * The whole simulation is reproducible: every value traces back to a string
 * seed, so a demo run looks identical on every machine and nothing changes
 * between React renders.
 */

/** FNV-1a — turns a seed string into a 32-bit integer. */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32 — small, fast, good enough for simulation noise. */
export function makeRng(seed: string | number): Rng {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal deviate from a uniform generator. */
export function gaussian(rng: Rng, mean = 0, sd = 1): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Deterministic hash-based unit value for an arbitrary coordinate. */
function hash1(seed: number, x: number): number {
  let h = seed ^ Math.imul(x | 0, 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 1-D value noise: smooth, continuous, and repeatable. Used for the slow
 * meandering of temperature/pressure/wind rather than per-sample jitter.
 */
export function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(seed, i);
  const b = hash1(seed, i + 1);
  return a + (b - a) * smoothstep(f);
}

/** Summed octaves of value noise, normalised to roughly -1..1. */
export function fbm(seed: number, x: number, octaves = 4): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (valueNoise(seed + o * 7919, x * freq) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}
