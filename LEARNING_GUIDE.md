# SkyGuard — a guided tour of the code

This document is for someone who has been handed this repository and asked to
understand it. It assumes you can read JavaScript and have seen React, and
assumes nothing about meteorology, statistics or machine learning.

It is a *reading order*, not a reference. Work through it top to bottom with
the code open beside you and you will understand the whole system in a few
hours. Every file mentioned carries a long comment at the top explaining
itself, so this guide's job is to tell you which file to open next and why.

---

## Part 0 — The problem, in one screen

A weather station reports **61.4 °C**.

Is the region on fire, or is the probe broken?

That question is the entire product. Answering it wrong is expensive in both
directions:

- Call a **real heatwave a fault** and you erase genuine weather from a
  climate record that people will still be using in fifty years.
- Call a **broken probe real** and you publish nonsense to every forecast,
  flood model and insurance calculation downstream of you.

Now here are two events from the demo network, happening at the same time:

| | AWS-007 · Marion Ridge | AWS-033 · Newport Headland |
|---|---|---|
| What happened | Temperature jumps to ~61 °C in one minute | Temperature falls ~7 °C over 40 minutes |
| Humidity | Unchanged | Rises as the air moistens |
| Pressure | Unchanged | Digs a trough, then recovers |
| Neighbours | Nothing, anywhere in the network | The same signature, in geographic order |
| Rate of change | Violates the physical limit | Fast, but physically achievable |
| **Verdict** | **Sensor fault — 98%** | **Genuine weather event** |

Both are anomalies. Only one is a hardware problem. Everything in `src/lib`
exists to tell those two apart **and to show its working**.

The four-stage pipeline the whole codebase follows:

```
DETECT  →  EXPLAIN  →  CORRECT  →  ACT
```

---

## Part 1 — Run it first

```bash
npm install
npm run dev          # http://localhost:3000
```

No API keys, no `.env`, no database. Before reading a line of code, spend ten
minutes in the running app:

1. Open the **Overview**. Note the two headline cards — that is the table above.
2. Click into **AWS-007**. Look at the chart: the raw trace leaves the others
   and comes back.
3. Open **Anomalies → the temperature spike**. Read the evidence list. That
   list is generated, not written by hand.
4. Open **Model Lab**. Six detection methods, scored against ground truth.
5. Press <kbd>⌘K</kbd>. Search anything.

You now know what the code has to produce. Reading it is much easier in that
order.

---

## Part 2 — The reading order

Nine files, about two hours. Read them **in this order** — each depends on the
ones before it.

### 1. `src/types/index.ts` — the nouns

Start here. It is pure vocabulary: `Station`, `Sensor`, `RawReading`,
`Anomaly`, `Incident`, `Correction`. No logic at all.

> **Take away:** a `RawReading` is what the instrument said. A `QcReading` is
> what we think about it. They are separate types on purpose, and that
> separation is the ethical core of the project.

### 2. `src/lib/utils.ts` — the maths toolbox

Ten small functions that the rest of the codebase is built from. Understand
these four properly and the analysis files become easy:

| Function | Question it answers |
|---|---|
| `stdev` | How spread out is this data? (the σ everything is measured in) |
| `slopeWithError` | Is this trend real, or am I fitting a line to noise? |
| `correlation` | Do these two stations move together? |
| `dewPoint` | How much water is actually in this air? |

> **Take away:** `slopeWithError` is the one to study. Anyone can fit a line;
> knowing whether to believe it is the harder and more valuable skill.

### 3. `src/lib/rng.ts` — why nothing is random

The entire simulation is deterministic. `Math.random()` appears nowhere.

> **Take away:** determinism is not a stylistic preference here. It is what
> makes bugs reproducible, renders stable, and demos identical on every
> machine. It costs about eighty lines.

### 4. `src/lib/simulation/engine.ts` — building a fake world honestly

Two stages, and keeping them separate is the whole trick:

```
STAGE 1   one regional atmosphere, sampled by all twelve stations
          ← cold fronts and heatwaves are applied HERE
STAGE 2   each station observes it through imperfect hardware
          ← faults are applied HERE
```

Because of that split, the properties the detector relies on are never coded —
they *emerge*. A front automatically appears at every station in geographic
order. A spike automatically appears at exactly one.

> **Take away:** if you simulate the phenomenon rather than the symptom, your
> detection code is genuinely being tested instead of being told the answer.
> This is the most transferable idea in the repository.

### 5. `src/lib/anomaly/detectors.ts` — finding the unusual

Seven statistical tests over one channel. The central concept is the
**z-score**:

```
z = |value − recent mean| ÷ recent standard deviation
```

"How many typical wobbles from normal is this?" Unit-free, so one threshold
serves °C, hPa and m/s alike.

Two details worth your attention:

- **The six-minute guard.** The baseline ends six minutes *before* the sample
  under test, so a fault that ramps up cannot contaminate its own reference
  window. Getting this wrong is one of the commonest ways to build a detector
  that quietly misses the events it was written for.
- **The prefix-sum trick** in `class Rolling`. It turns an O(n × window)
  problem into O(n). Read the diagram in the comment.

> **Take away:** a threshold on its own produces alarms nobody trusts. Every
> test here requires *both* statistical unusualness and physical significance.

### 6. `src/lib/neighbours.ts` — the second opinion

A station cannot audit its own thermometer. Eleven other stations can.

Three ideas, in order:

1. **`adjustToStation`** — you cannot compare two stations directly. Altitude
   changes temperature (lapse rate), pressure (barometric formula) and
   humidity (which needs converting to dew point and back). Translate first.
2. **`computeRelevance`** — proximity is a poor guide. A peak 8 km away is a
   worse reference than a valley town 60 km away. Distance, elevation,
   terrain and historical correlation are blended.
3. **`findPropagation`** — the decisive one. Does this signature appear at
   other stations, at a plausible lag, in geographic order?

> **Take away:** weather travels; a broken probe does not. That single
> asymmetry does more classification work than every statistic in the project.

### 7. `src/lib/anomaly/classify.ts` — the verdict

**If you read one file, read this one.** Evidence is accumulated on both sides
with named weights, and confidence is simply the winner's share:

```
fault 8.4, weather 1.2  →  0.875  →  "sensor fault, 88%"
fault 3.2, weather 3.0  →  0.516  →  "indeterminate"
```

Three decisions to notice:

- Both sides start at 0.3, so **no verdict can ever reach 100%**.
- Below 60% the answer is **`indeterminate`** — "a human should look at this"
  is a legitimate output, and far better than a confident coin flip.
- A frozen channel or an out-of-range value **short-circuits** the weighing
  entirely. Those are not judgement calls.

> **Take away:** "94% confident" here is arithmetic over a list the operator
> can read and disagree with — not a probability from a model. That is the
> difference between a system people trust and one they eventually switch off.

### 8. `src/lib/corrections/ensemble.ts` — what it should have read

Five independent estimators, weighted, renormalised over whichever were
available. Their **disagreement becomes the prediction interval**.

> **Take away, and the rule that matters most in the whole codebase:**
> **the raw value is never overwritten.** A correction is an additional record
> beside the original. Overwriting destroys the evidence that the instrument
> was failing and makes the archive unauditable.

### 9. `src/lib/world.ts` — the assembly line

One pure function turns `(seed, events, clock)` into the entire application
state. Every screen reads from that one object, so no two screens can
disagree — they are looking at the same array.

```
buildWorld({ seed, events, now })  →  World  →  every page
```

> **Take away:** the pages contain no analysis whatsoever. They are pure
> presentation over one object. That is why "the overview says 3 and the
> anomaly list says 4" is not a bug that can exist here.

---

## Part 3 — The interface layer

Once the engine makes sense, the UI is short.

| File | What to notice |
|---|---|
| `src/hooks/useWorld.ts` | The only bridge between React and `src/lib`. Two layers of caching, safe *only* because `buildWorld` is pure. |
| `src/store/useSkyGuard.ts` | Stores **inputs and human decisions, never derived data**. This is what makes stale-copy bugs unrepresentable. |
| `src/app/layout.tsx` | How Next.js routing works: folders are routes. Also Server vs Client Components. |
| `src/app/page.tsx` | A whole page that does no analysis at all. |
| `src/components/charts/TimeSeriesChart.tsx` | Four traces at once — the visual form of the classifier's argument. |

---

## Part 4 — Concepts, defined once

Terms you will meet, in plain language.

| Term | Meaning |
|---|---|
| **σ (sigma) / standard deviation** | The typical distance of a value from the average. The unit "unusual" is measured in. |
| **z-score** | How many σ from normal a value is. z = 4 is roughly a 1-in-16,000 sample. |
| **Baseline** | The recent normal a value is compared against — here the trailing 90 minutes. |
| **OLS / least squares** | Fitting the straight line that minimises squared vertical distance to the points. |
| **r²** | The fraction of the variation a fitted line explains. 0 = useless, 1 = perfect. |
| **Standard error** | The uncertainty in a fitted number. A slope smaller than twice its standard error is not evidence of anything. |
| **MAD** | Median absolute deviation — a spread measure one wild outlier cannot inflate. |
| **Precision** | Of what I flagged, how much was real? |
| **Recall** | Of what was real, how much did I flag? |
| **Lapse rate** | Air cools 6.5 °C per 1000 m of altitude. |
| **Dew point** | The temperature at which air would start condensing — an absolute measure of moisture. |
| **MSLP** | Pressure reduced to mean sea level, so stations at different altitudes are comparable. |
| **Digital twin** | A model of what a perfect instrument at this site should be reading right now. |
| **Isolation Forest** | Unsupervised outlier detection: outliers need fewer random splits to isolate. |
| **Shadow model** | A candidate model run on live data whose output goes nowhere near the user. |
| **Pure function** | Same inputs → same output, no side effects. What makes caching and testing safe. |
| **Memoisation** | Caching a function's result against its inputs. |
| **Provenance** | A record of where a number came from — `LIVE`, `SIMULATED`, `CORRECTED`… |

---

## Part 5 — Trace one number end to end

The single most useful exercise. Follow 61.4 °C through the system.

**1 · It is created** — `simulation/engine.ts`
The regional field says 22.1 °C at Marion Ridge. An injected
`temperature_spike` event adds ~39 °C in stage 2 — the hardware stage, so the
regional field is untouched and every neighbour still reads ~22 °C.

**2 · It is detected** — `anomaly/detectors.ts`
Baseline over the previous 90 minutes: mean 21.8, σ 0.31.
`z = |61.4 − 21.8| ÷ 0.31 = 128`. Three tests fire: `spike`,
`rate_of_change` (39 °C in one minute against a 0.8 °C/min limit) and `range`
(61.4 is outside −48…56).

**3 · Physics is checked** — `physics/rules.ts`
Six rules evaluated, each reporting what it saw and the limit it compared
against. `rate_of_change` and `range` both fail.

**4 · Neighbours are asked** — `neighbours.ts`
Consensus of eleven stations, adjusted into Marion Ridge's frame: 22.0 °C,
spread 0.4. `findPropagation` searches ±3 hours at every relevant neighbour
and finds **nothing**. Coverage: 0.

**5 · It is classified** — `anomaly/classify.ts`
`range` is dispositive and short-circuits the weighing. Verdict:
`sensor_fault`, 98%, with the evidence list attached.

**6 · It is corrected** — `corrections/ensemble.ts`
physics 22.1 · ml 22.4 · neighbours 22.0 · external 21.8 · history 22.3
→ **22.16 °C, interval 21.9–22.5, confidence 91%.**
The raw 61.4 is still there, untouched, and still in the raw export.

**7 · It becomes work** — `incidents/group.ts`, `health/score.ts`
An incident, a critical alert, a maintenance task, an audit entry, and a
health score for that sensor with the penalty itemised.

**8 · It is displayed** — every page, from the same `World` object.

---

## Part 6 — Exercises

Roughly in order of difficulty. Each one is a real change to a real system.

1. **Add a detector.** A "stuck at maximum" test: value pinned to the top of
   the sensor range for more than ten minutes. Add it to `detectors.ts` and to
   the `DetectorType` union in `types/index.ts`.
2. **Change the sensitivity curve.** In `physics/rules.ts`, `scaleConfig` is
   linear. Make it exponential and watch the Model Lab's precision/recall move.
3. **Add an estimator.** A sixth source in `ensemble.ts` — for example the
   same time yesterday. Give it a weight and check that renormalisation still
   sums to 1.
4. **Weaken the classifier deliberately.** Delete the propagation evidence in
   `classify.ts` and rerun the demo. The cold front should now be misread as
   twelve simultaneous sensor faults. This failure is more instructive than
   any amount of it working.
5. **Add a scenario.** A new injectable event in `simulation/events.ts` — an
   icing event on the anemometer, say — and check it appears coherently.
6. **Prove the caching claim.** Add a `console.count()` inside `buildWorld` and
   confirm it runs once per clock tick, not once per render.

---

## Part 7 — Where each idea lives

| If you want to learn… | Read |
|---|---|
| Statistics in production code | `anomaly/detectors.ts`, `utils.ts` |
| A real ML model, implemented | `models/lab.ts` (Isolation Forest) |
| Evidence-based decisions | `anomaly/classify.ts` |
| Physical modelling | `simulation/engine.ts` |
| Uncertainty quantification | `corrections/ensemble.ts` |
| Clean state architecture | `world.ts`, `store/useSkyGuard.ts` |
| Performance in JavaScript | `class Rolling` in `detectors.ts`, `hooks/useWorld.ts` |
| Accessible interface work | `components/ui/primitives.tsx`, `app/layout.tsx` |
| Honest data provenance | `types/index.ts` (`DataSource`), the badges everywhere |

---

## Part 8 — Things this project does that you should steal

1. **Show your working.** Every verdict carries the evidence that produced it.
2. **Never destroy the original.** Corrections sit beside the raw data.
3. **Refuse to be certain.** No confidence reaches 100%; `indeterminate` is a
   valid answer.
4. **One source of truth.** Screens that read the same object cannot disagree.
5. **Determinism by default.** A bug you can reproduce is a bug you can fix.
6. **Label everything.** `LIVE` vs `SIMULATED` on every number, always.
7. **Explain the threshold, not just the result.** "4.2 °C above the 90-minute
   baseline (7.1σ)" beats "anomaly detected" every single time.
8. **Simulate the cause, not the symptom.** Then your detector is genuinely
   under test.

---

## Part 9 — Honest limitations

Worth being able to state in a viva, because the questions will come:

- The station network is **fictional**. Nothing connects to real hardware.
- Precision and recall in the Model Lab are measured against ground truth that
  exists **only because this is a simulation**. Real hardware never comes with
  that label — which is precisely why the production path publishes evidence
  and rules rather than a score.
- Failure risk is a deterministic score, not a trained model.
- The operator assistant is **not** a language model. Every answer is
  assembled from the same objects the screens render, so it cannot invent a
  number. It sits behind a provider interface so a real model could be added
  later — as an additional provider, not as a replacement for that guarantee.
- Telemetry covers a rolling 24-hour window; longer-baseline statistics are
  reconstructed deterministically and labelled as estimates.
- State lives in `localStorage`. There is no backend and no multi-user
  coordination.

---

## Quick reference

```bash
npm run dev      # development server
npm run build    # production build
npm run lint     # ESLint, including React Compiler rules
npm run smoke    # headless pass over every route, fails on any console error
```

```
src/
  types/         the nouns
  lib/
    utils.ts     maths toolbox            ← read 2nd
    rng.ts       deterministic randomness ← read 3rd
    simulation/  the fake world           ← read 4th
    anomaly/     detect + classify        ← read 5th, 7th
    neighbours.ts the second opinion      ← read 6th
    physics/     what the atmosphere can do
    corrections/ what it should have read ← read 8th
    health/      per-sensor scoring
    incidents/   correlation into events
    models/      Isolation Forest, shadow evaluation
    world.ts     the assembly line        ← read 9th
  store/         inputs and human decisions only
  hooks/         the React ↔ lib bridge
  components/    presentation only
  app/           15 sections, folder-based routing
```

Read `AGENTS.md` before changing anything: this project runs a version of
Next.js whose conventions may differ from what you have seen before, and the
guides in `node_modules/next/dist/docs/` are the authority.
