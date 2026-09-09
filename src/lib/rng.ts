/**
 * Deterministic pseudo-randomness.
 *
 * The whole simulation is reproducible: every value traces back to a string
 * seed, so a demo run looks identical on every machine and nothing changes
 * between React renders.
 *
 * ─── Why not just use Math.random()? ─────────────────────────────────────
 *
 * Math.random() gives a different number every call. That is fatal here for
 * three separate reasons:
 *
 *   1. React may render the same component twice (Strict Mode does this on
 *      purpose). With Math.random() the two renders would disagree, and the
 *      chart would visibly flicker.
 *   2. A bug you can only reproduce once is a bug you cannot fix. With a
 *      seed, "the spike at AWS-007 at 14:32" is there every single run.
 *   3. A demo has to look the same on the presenter's laptop as it did in
 *      rehearsal.
 *
 * So instead of true randomness we use a *pseudo*-random generator: a
 * deterministic function that produces a stream of numbers which merely look
 * random. Same seed in → same stream out, forever.
 */

/**
 * FNV-1a — turns a seed string into a 32-bit integer.
 *
 * A hash function squeezes text of any length down to one fixed-size number.
 * We need this because our seeds are human-readable strings such as
 * `"AWS-007:temperature"`, while the generator below wants a number.
 *
 * The loop is the whole algorithm: XOR in one character, then multiply by a
 * large prime. Multiplication smears each character's influence across all 32
 * bits, so `"AWS-007"` and `"AWS-008"` produce completely unrelated outputs —
 * which is exactly what we want, otherwise neighbouring stations would get
 * suspiciously similar "random" noise.
 *
 * `Math.imul` is JavaScript's 32-bit integer multiply. Plain `*` would give a
 * float and silently lose the low bits we are relying on.
 */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A random-number generator: call it, get the next value in 0..1. */
export type Rng = () => number;

/**
 * mulberry32 — small, fast, good enough for simulation noise.
 *
 * The pattern to notice: `a` is the generator's *state*. Each call nudges the
 * state forward by a fixed constant and then scrambles it with shifts, XORs
 * and multiplies. The scrambling is what breaks up the obvious "+1 each time"
 * pattern; the fixed step is what makes it repeatable.
 *
 * The final division by 2^32 (4294967296) turns the scrambled 32-bit integer
 * into the 0..1 float that callers expect.
 *
 *   const rng = makeRng('AWS-007');
 *   rng();  // 0.6789...  — and it will be 0.6789... on every machine
 *   rng();  // 0.1234...
 */
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

/**
 * Box–Muller normal deviate from a uniform generator.
 *
 * `makeRng` gives *uniform* numbers: every value in 0..1 is equally likely.
 * Real measurement noise is not uniform — it is bell-shaped, clustered around
 * zero, with big excursions rare. That is a normal (Gaussian) distribution.
 *
 * The Box–Muller transform converts two uniform numbers into one normal one
 * using the identity below. You do not need to derive it to use it; what
 * matters is the shape of the result:
 *
 *   gaussian(rng, 0, 1)   →  ~68% of values land in -1..+1
 *                            ~95% land in -2..+2
 *                            values beyond ±3 are genuinely rare
 *
 * `sd` (standard deviation) sets how wide that bell is. A thermometer with
 * ±0.2 °C noise is `gaussian(rng, trueTemp, 0.2)`.
 *
 * The `while (u === 0)` guards exist because `Math.log(0)` is -Infinity.
 */
export function gaussian(rng: Rng, mean = 0, sd = 1): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Deterministic hash-based unit value for an arbitrary coordinate.
 *
 * Unlike `makeRng`, this has no state you have to step through: give it an
 * integer `x` and it returns *that* position's random value directly. That
 * random-access property is what makes the smooth noise below possible.
 */
function hash1(seed: number, x: number): number {
  let h = seed ^ Math.imul(x | 0, 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smoothstep — an S-curve that eases from 0 to 1.
 *
 * Plain linear interpolation between two random values gives visible kinks at
 * every integer. Smoothstep has zero gradient at both ends, so consecutive
 * segments join without a corner and the result looks like a physical
 * quantity rather than a zig-zag.
 *
 *   smoothstep(0) = 0 · smoothstep(0.5) = 0.5 · smoothstep(1) = 1
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 1-D value noise: smooth, continuous, and repeatable. Used for the slow
 * meandering of temperature/pressure/wind rather than per-sample jitter.
 *
 * How it works: pick the random values at the two whole numbers either side
 * of `x`, then blend between them using the S-curve above.
 *
 *   x = 3.25  →  blend 75% of hash(3) with 25% of hash(4), eased
 *
 * The result is a wobbly but *continuous* line — nearby inputs give nearby
 * outputs. That is the difference between weather (which drifts) and static.
 */
export function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(seed, i);
  const b = hash1(seed, i + 1);
  return a + (b - a) * smoothstep(f);
}

/**
 * Fractional Brownian motion — summed octaves of value noise, normalised to
 * roughly -1..1.
 *
 * One layer of value noise is too smooth to look like real weather. fBm adds
 * several layers ("octaves"), each one twice as fast and half as strong as
 * the last:
 *
 *   octave 0:  ±1.00 amplitude, slow    ← the synoptic trend over days
 *   octave 1:  ±0.50 amplitude, faster  ← the shape of an afternoon
 *   octave 2:  ±0.25 amplitude, faster  ← passing cloud
 *   octave 3:  ±0.125 amplitude         ← gusts
 *
 * Summing them gives detail at every scale at once, which is how natural
 * signals actually behave. Dividing by `norm` (the total amplitude spent)
 * keeps the output in a predictable range no matter how many octaves you ask
 * for. The odd multiplier 2.07 rather than exactly 2 stops the octaves from
 * lining up at the same integers and producing a visible repeating pattern.
 */
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
