#!/usr/bin/env bun
/**
 * imp — summon the right imp for a prompt.
 *
 *   imp "what changed in git since yesterday?"   keyword-routes to imp-git
 *   imp git "what changed?"                      explicit tool prefix, no guessing
 *   imp "find the TODOs in src; then commit"     compound: imp-rg, then imp-git
 *   imp --which "list my PRs"                    print the routing decision, don't run
 *   imp -l                                       list all routes
 *
 * Routing is deliberate keyword matching, not a model call: free, instant, and
 * predictable. When nothing matches (or several imps tie), it lists candidates
 * instead of guessing — a wrong imp acting on a vague prompt is worse than a
 * second keystroke. Flags after routing (-q, --effort, --no-warm) pass through.
 *
 * Compound prompts: strong connectors (";", ". ", "then", "after that") split
 * the prompt, and when every segment routes cleanly to an imp the steps run
 * sequentially, each imp getting only its own segment. A bare "and" never
 * splits ("open a pane and cd into it" is one cmux task), and if ANY segment
 * is unclear the split is abandoned in favor of whole-prompt routing.
 */
import { spawn } from "child_process";
import { readdirSync } from "fs";
import { join } from "path";

const IMPS_DIR = join(import.meta.dir, "imps");

interface Route {
  imp: string;
  /** Word-boundary keyword alternation tested against the prompt. */
  pattern: RegExp;
  hint: string;
}

// Ordered most-specific first: earlier routes win score ties.
const ROUTES: Route[] = [
  { imp: "imp-cmux-extensions", pattern: /\b(cmux extension|dock control|custom sidebar|palette (command|action))\b/i, hint: "persistent cmux extensions" },
  { imp: "imp-cmux", pattern: /\b(cmux|workspace|pane|surface|split|tmux)\b/i, hint: "terminal workspaces" },
  { imp: "imp-browser-automate", pattern: /\b(my (chrome|browser)|current tab|live tab|logged.?in (page|site|session)|real browser)\b/i, hint: "your live Chrome" },
  { imp: "imp-browser", pattern: /\b(browser|web ?page|website|snapshot|form fill|headless)\b/i, hint: "hidden browser automation" },
  { imp: "imp-gh", pattern: /\b(github|gh|pull request|prs?|issues?|ci run|workflow run|releases?|repo)\b/i, hint: "GitHub" },
  { imp: "imp-git", pattern: /\b(git|commits?|branch(es)?|stash|staged|unstaged|merge|rebase|push|pull)\b/i, hint: "local git" },
  { imp: "imp-docker", pattern: /\b(docker|containers?|compose|dockerfile|images?)\b/i, hint: "containers" },
  { imp: "imp-kubectl", pattern: /\b(kubernetes|kubectl|k8s|pods?|namespaces?|deployments?|cluster)\b/i, hint: "Kubernetes" },
  { imp: "imp-terraform", pattern: /\b(terraform|tfplan|tfstate|infrastructure as code|iac)\b/i, hint: "Terraform" },
  { imp: "imp-aws", pattern: /\b(aws|s3|ec2|lambda|cloudwatch|iam|dynamodb|sqs|rds)\b/i, hint: "AWS" },
  { imp: "imp-gcloud", pattern: /\b(gcloud|gcp|google cloud|gke|cloud run|pubsub)\b/i, hint: "Google Cloud" },
  { imp: "imp-psql", pattern: /\b(psql|postgres(ql)?|sql|database|tables?|schema|query plan)\b/i, hint: "PostgreSQL" },
  { imp: "imp-npm", pattern: /\b(npm|package\.json|node_modules|dependenc(y|ies)|devdependenc(y|ies)|audit)\b/i, hint: "npm packages" },
  { imp: "imp-jq", pattern: /\b(jq|json)\b/i, hint: "JSON processing" },
  { imp: "imp-rg", pattern: /\b(rg|ripgrep|grep|search (the )?(code|codebase|repo|files)|find in files|todos?|fixmes?)\b/i, hint: "code search" },
  { imp: "imp-gmail", pattern: /\b(gmail|email|inbox|mail|drafts?|unread)\b/i, hint: "Gmail via gog" },
  { imp: "imp-bird", pattern: /\b(tweets?|twitter|bird|mentions|timeline|followers)\b/i, hint: "Twitter/X" },
  { imp: "imp-memory", pattern: /\b(remember|recall|notes?|knowledge|basic memory|what do i know)\b/i, hint: "knowledge base" },
  { imp: "imp-karabiner", pattern: /\b(karabiner|goku|keyboard shortcut|remap|keybinding|hyper key|caps lock)\b/i, hint: "keyboard config" },
  { imp: "imp-packx", pattern: /\b(packx|context bundle|bundle (the )?(repo|code|context))\b/i, hint: "context bundling" },
  { imp: "imp-zsh", pattern: /\b(zsh|alias(es)?|shell function|zshrc|dotfiles?)\b/i, hint: "zsh config" },
  { imp: "imp-ffmpeg", pattern: /\b(ffmpeg|videos?|mp4|mkv|webm|trim|transcode|extract audio|gif from)\b/i, hint: "video/audio processing" },
  { imp: "imp-imagemagick", pattern: /\b(imagemagick|magick|images?|png|jpe?g|webp|resize|crop|thumbnails?)\b/i, hint: "image processing" },
  { imp: "imp-yt-dlp", pattern: /\b(youtube|yt-dlp|download (a |the )?(video|audio|playlist))\b/i, hint: "video downloads" },
  { imp: "imp-osascript", pattern: /\b(applescript|osascript|notification|dialog|clipboard|finder|frontmost|dark mode|volume)\b/i, hint: "macOS automation" },
  { imp: "imp-brew", pattern: /\b(brew|homebrew|formula|cask|installed packages)\b/i, hint: "Homebrew" },
];

function roster(): Set<string> {
  return new Set(readdirSync(IMPS_DIR).filter((f) => /^imp-[a-z0-9-]+$/.test(f)));
}

function pickRoute(prompt: string): { winner?: Route; scores: Array<{ route: Route; score: number }> } {
  const scored = ROUTES.map((route) => {
    const matches = prompt.match(new RegExp(route.pattern.source, "gi"));
    return { route, score: matches ? matches.length : 0 };
  }).filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { scores: [] };
  // A clear winner beats the runner-up; an exact tie is ambiguous on purpose.
  if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].route.imp !== scored[1].route.imp) {
    return { scores: scored };
  }
  return { winner: scored[0].route, scores: scored };
}

interface Step {
  imp: string;
  prompt: string;
}

// Strong connectors only. A bare " and " is NOT a split point — "open a pane
// and cd into it" is one task. "." splits only when followed by whitespace, so
// file names (intro.mp4, ~/.agents) survive.
const CONNECTOR_SRC = String.raw`(?:;|\.(?=\s)|\b(?:and\s+)?then\b|\bafter\s+that\b|\bafterwards?\b)`;

function splitPrompt(prompt: string): string[] {
  return prompt
    .split(new RegExp(CONNECTOR_SRC, "gi"))
    .map((s) => s.replace(/^[\s,]+(?:and\s+)?/i, "").replace(/[\s,.]+$/, "").trim())
    .filter((s) => /[a-z]/i.test(s));
}

/**
 * Compound routing: every segment must route cleanly, consecutive segments
 * with the same imp merge back into one step, and a plan only exists when at
 * least two DIFFERENT imps are involved. Anything less falls back (null) to
 * whole-prompt routing — splitting must never make routing worse.
 */
function planRoute(prompt: string, available: Set<string>): Step[] | null {
  const segments = splitPrompt(prompt);
  if (segments.length < 2) return null;
  const steps: Step[] = [];
  for (const seg of segments) {
    const { winner } = pickRoute(seg);
    if (!winner || !available.has(winner.imp)) return null;
    const prev = steps[steps.length - 1];
    if (prev && prev.imp === winner.imp) prev.prompt += "; " + seg;
    else steps.push({ imp: winner.imp, prompt: seg });
  }
  return steps.length >= 2 ? steps : null;
}

function runStep(imp: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(join(IMPS_DIR, imp), args, { stdio: "inherit", cwd: process.cwd() });
    child.on("exit", (code, signal) => resolve(signal ? 130 : code ?? 0));
    child.on("error", (e) => {
      console.error(`imp: failed to launch ${imp}: ${e.message}`);
      resolve(1);
    });
  });
}

function usage(): void {
  console.log(`imp — summon the right imp for a prompt

Usage:
  imp <prompt>            route by keywords and run the matching imp
  imp <tool> <prompt>     explicit: imp git "...", imp jq "..." (no guessing)
  imp "<a>; then <b>"     compound: each segment runs on its own imp, in order
  imp --which <prompt>    print the routing decision without running
  imp -l | --list         list all routes

Flags after routing (e.g. -q, --effort, --no-warm) pass through to the imp.`);
}

const args = process.argv.slice(2);
const which = args.includes("--which");
const passthrough = args.filter((a) => a !== "--which");

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  usage();
  process.exit(0);
}

if (args[0] === "-l" || args[0] === "--list") {
  for (const r of ROUTES) console.log(`${r.imp.padEnd(24)}${r.hint}`);
  process.exit(0);
}

const names = roster();
let target: string | undefined;
let impArgs = passthrough;

// Explicit tool prefix: `imp git ...` / `imp imp-git ...` routes deterministically.
const first = passthrough[0];
if (first && (names.has(first) || names.has(`imp-${first}`))) {
  target = names.has(first) ? first : `imp-${first}`;
  impArgs = passthrough.slice(1);
} else {
  const promptText = passthrough.filter((a) => !a.startsWith("-")).join(" ");
  const flagArgs = passthrough.filter((a) => a.startsWith("-"));

  const steps = planRoute(promptText, names);
  if (steps) {
    if (which) {
      for (const s of steps) console.log(`${s.imp.padEnd(24)}${s.prompt}`);
      process.exit(0);
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      console.error(`[${i + 1}/${steps.length}] ${s.imp}: ${s.prompt}`);
      const code = await runStep(s.imp, [...flagArgs, s.prompt]);
      if (code !== 0) {
        console.error(`imp: ${s.imp} exited ${code} — skipping ${steps.length - i - 1} remaining step(s)`);
        process.exit(code);
      }
    }
    process.exit(0);
  }

  const { winner, scores } = pickRoute(promptText);
  if (winner && names.has(winner.imp)) {
    target = winner.imp;
  } else if (scores.length > 0) {
    console.error("ambiguous — these imps all match:");
    const top = scores[0].score;
    for (const s of scores.filter((x) => x.score === top)) {
      console.error(`  ${s.route.imp.padEnd(24)}${s.route.hint}`);
    }
    console.error(`\nbe explicit: imp ${scores[0].route.imp.replace(/^imp-/, "")} "..."`);
    process.exit(2);
  } else {
    console.error("no imp matched that prompt. Available imps:");
    for (const r of ROUTES) if (names.has(r.imp)) console.error(`  ${r.imp.padEnd(24)}${r.hint}`);
    console.error(`\nbe explicit: imp <tool> "your prompt"   (e.g. imp git "what changed?")`);
    process.exit(2);
  }
}

if (which) {
  console.log(target);
  process.exit(0);
}

if (impArgs.filter((a) => !a.startsWith("-")).length === 0) {
  console.error(`routed to ${target}, but no prompt remains. Try: imp ${target.replace(/^imp-/, "")} "your prompt"`);
  process.exit(1);
}

const child = spawn(join(IMPS_DIR, target), impArgs, { stdio: "inherit", cwd: process.cwd() });
child.on("exit", (code, signal) => process.exit(signal ? 130 : code ?? 0));
child.on("error", (e) => {
  console.error(`imp: failed to launch ${target}: ${e.message}`);
  process.exit(1);
});
