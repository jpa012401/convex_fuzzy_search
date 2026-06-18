# matchTokens Parallelization — Benchmark Results

**Date:** 2026-06-18
**Outcome:** Change merged as a defensive improvement. No measurable steady-state speedup at 5k docs.

## Finding: the original numbers were cold-start, not steady-state

The diagnosis that drove this work used `products:benchmark` figures of
700–2429ms for text and filter+facet queries. Re-running the benchmark **warm**
(second and third invocations) on the cloud dev deployment at 5k docs showed
**every case at 1–3ms**, including the cases targeted for optimization:

| case                    | original (cold) | warm steady-state |
|-------------------------|----------------:|------------------:|
| multi-term AND          | 892ms           | 2ms               |
| plain term              | 800ms           | 3ms               |
| prefix (as-you-type)    | 781ms           | 2ms               |
| typo tolerance          | 707ms           | 2ms               |
| boolean+facet           | 2429ms          | 2ms               |

The benchmark's `ms` wraps `ctx.runQuery` inside an action; on a cold deployment
that includes function-module load and cache warming. The first run of each
deployment session paid that cost; warm runs do not.

## Consequence

- The serial-read analysis of the `matchTokens` verify loop was structurally
  correct, but the conclusion that it caused a **steady-state** bottleneck was
  not supported once warm numbers were measured. At 5k docs with ~159 driver
  matches, the verify loop completes in single-digit ms warm.
- The parallelization (commits for the regression test + the two-phase
  restructure) is **behavior-preserving, read-count-neutral, and review-clean**.
  It is retained as a **defensive** improvement: it helps genuinely large driver
  match counts and cold paths, and does no harm. It is **not** a measured win at
  this scale, and this document records that honestly.

## If latency is ever revisited

The real user-visible latency at 5k is **cold start** (first query 700ms–2.4s),
not steady-state query cost. Cold-start mitigation (bundling, warmup pings) — not
per-query read parallelization — is the lever that would move it.
