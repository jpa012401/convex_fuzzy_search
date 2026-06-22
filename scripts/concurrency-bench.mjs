#!/usr/bin/env node
// Client-side concurrency benchmark: fires N parallel search queries at the
// configured Convex deployment and reports the latency distribution + effective
// throughput per query shape. Unlike the serial `products:benchmark` action,
// this exercises the deployment's QUERY-CONCURRENCY scheduler — the metric that
// reflects a deployment's concurrency CLASS (e.g. Convex S16 runs at most 16
// concurrent queries; beyond ~16 in-flight, queued queries inflate p99/max while
// each query's own latency is unchanged — the queue is the bottleneck).
//
// Usage:
//   node scripts/concurrency-bench.mjs [CONCURRENCY] [ROUNDS]
//     CONCURRENCY  parallel queries per round (default 16 — S16's ceiling)
//     ROUNDS       sequential rounds          (default 3)
//
// Examples:
//   node scripts/concurrency-bench.mjs            # 16 parallel x 3 rounds
//   node scripts/concurrency-bench.mjs 32 5       # 32 parallel x 5 rounds (over S16)
//
// Targets the deployment in .env.local (VITE_CONVEX_URL / CONVEX_URL). Seed first:
//   scripts/seed.sh 5000
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Resolve the deployment URL from env or .env.local.
function resolveUrl() {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
  if (process.env.VITE_CONVEX_URL) return process.env.VITE_CONVEX_URL;
  try {
    const env = readFileSync(join(root, ".env.local"), "utf8");
    const m = env.match(/^(?:VITE_)?CONVEX_URL=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  throw new Error("No CONVEX_URL / VITE_CONVEX_URL found (env or .env.local).");
}

const CONCURRENCY = Math.max(1, parseInt(process.argv[2] ?? "16", 10));
const ROUNDS = Math.max(1, parseInt(process.argv[3] ?? "3", 10));

// Representative shapes: a cheap text query, the heaviest in-memory shape
// (rankBy browse re-ranks the candidate window), and a filtered facet.
const shapes = [
  { label: "text (light)", args: { q: "jacket" } },
  {
    label: "rankBy browse (heavy)",
    args: { q: "", rankBy: { text: 1, fields: [{ field: "affinity", weight: 5 }, { field: "popularity", weight: 0.01 }] } },
  },
  { label: "filter+facet", args: { q: "", filterBy: "inStock:true", facetBy: ["category"] } },
];

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

async function main() {
  const url = resolveUrl();
  // The generated API (api.products.searchProducts) — import the JS the codegen emits.
  const { api } = await import(join(root, "example/convex/_generated/api.js"));
  const client = new ConvexHttpClient(url);

  console.log(`\nConcurrency benchmark @ ${url}`);
  console.log(`concurrency=${CONCURRENCY} rounds=${ROUNDS} (samples/shape=${CONCURRENCY * ROUNDS})`);
  console.log(
    CONCURRENCY > 16
      ? `NOTE: concurrency>16 — on Convex S16 the excess queues; p99/max reflect queue wait.\n`
      : `NOTE: within S16's 16-concurrent-query budget.\n`,
  );

  const rows = [];
  for (const shape of shapes) {
    const latencies = [];
    const wallStart = Date.now();
    for (let r = 0; r < ROUNDS; r++) {
      const batch = Array.from({ length: CONCURRENCY }, async () => {
        const t0 = Date.now();
        // products:searchProducts hardcodes the collection internally — pass only the query args.
        await client.query(api.products.searchProducts, shape.args);
        return Date.now() - t0;
      });
      latencies.push(...(await Promise.all(batch)));
    }
    const wallMsTotal = Date.now() - wallStart;
    const sorted = [...latencies].sort((a, b) => a - b);
    rows.push({
      shape: shape.label,
      samples: latencies.length,
      p50: pct(sorted, 50),
      p95: pct(sorted, 95),
      p99: pct(sorted, 99),
      max: sorted[sorted.length - 1] ?? 0,
      wallMs: wallMsTotal,
      qps: Math.round((latencies.length / (wallMsTotal / 1000)) * 10) / 10,
    });
  }
  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
