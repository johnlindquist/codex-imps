#!/usr/bin/env bun
/**
 * TTFT benchmark. Measures wall-clock from user prompt entry to:
 *   - first stderr/stdout byte (TTFT)
 *   - process exit (total)
 *
 * Usage:
 *   bun bench.ts imp-gh "say hi"             # cold (no imp)
 *   bun bench.ts imp-gh "say hi" --runs 5
 *   bun bench.ts imp-gh "say hi" --warm      # assumes imp is already running
 */

import { spawn } from "child_process";
import { join } from "path";

const args = process.argv.slice(2);
const runsIdx = args.indexOf("--runs");
const runs = runsIdx !== -1 ? parseInt(args[runsIdx + 1], 10) : 3;
const warm = args.includes("--warm");
const positional = args.filter((a, i) =>
  !a.startsWith("--") && args[i - 1] !== "--runs"
);
const [profile, ...promptParts] = positional;
const prompt = promptParts.join(" ");

if (!profile || !prompt) {
  console.error("usage: bun bench.ts <profile> <prompt> [--runs N] [--warm]");
  process.exit(1);
}

const profilePath = join(import.meta.dir, "imps", profile);

interface Sample { ttft: number; total: number; }
const samples: Sample[] = [];

for (let i = 0; i < runs; i++) {
  const sample = await new Promise<Sample>((resolve, reject) => {
    const start = performance.now();
    let firstByte: number | null = null;

    const child = spawn(
      "bun",
      [profilePath, "-q", ...(warm ? [] : ["--no-warm"]), prompt],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const markFirst = () => { if (firstByte === null) firstByte = performance.now(); };
    child.stdout.on("data", markFirst);
    child.stderr.on("data", markFirst);
    child.on("error", reject);
    child.on("close", () => {
      const total = performance.now() - start;
      resolve({ ttft: firstByte !== null ? firstByte - start : total, total });
    });
  });
  samples.push(sample);
  process.stderr.write(`run ${i + 1}/${runs}: ttft=${sample.ttft.toFixed(0)}ms total=${sample.total.toFixed(0)}ms\n`);
}

const stats = (key: keyof Sample) => {
  const xs = samples.map((s) => s[key]).sort((a, b) => a - b);
  const median = xs[Math.floor(xs.length / 2)];
  const min = xs[0];
  const max = xs[xs.length - 1];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { min, median, mean, max };
};

console.log(`\n=== ${warm ? "WARM (via imp)" : "COLD"} — ${profile} — ${runs} runs ===`);
const t = stats("ttft");
const o = stats("total");
console.log(`TTFT   min=${t.min.toFixed(0)}ms  median=${t.median.toFixed(0)}ms  mean=${t.mean.toFixed(0)}ms  max=${t.max.toFixed(0)}ms`);
console.log(`Total  min=${o.min.toFixed(0)}ms  median=${o.median.toFixed(0)}ms  mean=${o.mean.toFixed(0)}ms  max=${o.max.toFixed(0)}ms`);
