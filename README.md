# codex-imps

Single-purpose, isolated [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) agents — **imps** — for common CLI tools. An imp is a small, fast daemon-spirit bound to exactly one tool. Each imp runs with ~6K input tokens instead of the default ~22K — faster, cheaper, and focused. Warm mode is **on by default**: the first call auto-starts a warm background imp and every later call reuses it for ~2x lower latency (opt out with `--no-warm`).

All imps start with `imp-` so you can type `imp-` and tab-complete to summon the whole roster.

## What is an imp?

An imp is a single executable TypeScript file that wraps a CLI tool with an isolated Codex agent. It:

- Loads **zero** user-space config (no plugins, skills, hooks, memories, or MCP servers)
- Replaces the ~20K system prompt with a focused, Oracle-tuned prompt optimized for low-reasoning models
- Disables unused tool schemas (Gmail, Slack, web, imagegen) via feature flags
- Symlinks only `auth.json` for login — token refreshes propagate automatically
- Uses `gpt-5.3-codex-spark` with `low` reasoning effort for maximum speed
- Streams by default — shows commands, output, reasoning, and todos as they happen
- Clean Ctrl+C — kills the agent, its commands, and cleans up temp files immediately

## Install

```bash
# Requires bun (https://bun.sh) and @openai/codex CLI (authenticated)
git clone https://github.com/johnlindquist/codex-imps
cd codex-imps
bun install
bun link
```

This symlinks all imps to `~/.bun/bin/`. Type `imp-` then tab to see them all. You can also run imps directly without linking:

```bash
bun imps/imp-gh "list my open PRs"
```

## The imps

| Command | Tool | Description |
|---------|------|-------------|
| `imp-cmux` | [cmux](https://github.com/manaflow-ai/cmux) | Terminal workspace automation |
| `imp-cmux-extensions` | cmux/files | Persistent cmux extension authoring: actions, scripts, receipts, dock controls, and custom sidebars |
| `imp-git` | [git](https://git-scm.com) | Local Git (status, diff, branches, log, stash, commit, safe sync) |
| `imp-docker` | [docker](https://docs.docker.com/engine/reference/commandline/cli/) | Containers, images, volumes, networks, Compose (guarded lifecycle) |
| `imp-npm` | [npm](https://docs.npmjs.com/cli) | Node scripts, deps, package metadata, installs, audits |
| `imp-kubectl` | [kubectl](https://kubernetes.io/docs/reference/kubectl/) | Kubernetes pods, services, logs, events, rollouts (guarded apply/delete) |
| `imp-terraform` | [terraform](https://developer.hashicorp.com/terraform/cli) | IaC init, fmt, validate, plan, state inspection (guarded apply/destroy) |
| `imp-aws` | [aws](https://docs.aws.amazon.com/cli/) | AWS identity, EC2/S3/Lambda/logs inventory (guarded mutations) |
| `imp-jq` | [jq](https://jqlang.github.io/jq/) | Inspect, filter, and transform JSON; build & test precise filters |
| `imp-rg` | [ripgrep](https://github.com/BurntSushi/ripgrep) | Fast codebase search (read-only): symbols, TODOs, imports, configs |
| `imp-psql` | [psql](https://www.postgresql.org/docs/current/app-psql.html) | PostgreSQL schema, indexes, query plans, stats, locks (guarded writes) |
| `imp-gcloud` | [gcloud](https://cloud.google.com/sdk/gcloud) | Google Cloud project/account/resource inventory (guarded mutations) |
| `imp-gh` | [gh](https://cli.github.com) | GitHub CLI (issues, PRs, releases, actions) |
| `imp-zsh` | zsh/files | John's `~/.config/zsh` specialist for aliases, functions, wrappers, startup, and tests |
| `imp-gmail` | [gog](https://github.com/johnlindquist/gog) | Gmail search/read/draft specialist using the gog CLI with no-send defaults |
| `imp-karabiner` | [goku](https://github.com/yqrashawn/GokuRakuJoTu) | Karabiner-Elements config (karabiner.edn) |
| `imp-packx` | [packx](https://www.npmjs.com/package/packx) | AI context bundling |
| `imp-memory` | [basic-memory](https://github.com/basicmachines-co/basic-memory) | Knowledge management |
| `imp-bird` | [bird](https://www.npmjs.com/package/bird) | Twitter/X CLI |
| `imp-browser` | [agent-browser](https://www.npmjs.com/package/agent-browser) | Browser automation (hidden/headless browser it owns) |
| `imp-browser-automate` | [agent-browser](https://www.npmjs.com/package/agent-browser) | Drives your **live** Chrome over CDP — your real tabs, logins, session |
| `imp-ffmpeg` | [ffmpeg](https://ffmpeg.org) | Video/audio: probe, convert, trim, scale, extract, GIFs (never overwrites inputs) |
| `imp-imagemagick` | [magick](https://imagemagick.org) | Images: identify, resize, crop, convert, montage (never overwrites originals) |
| `imp-yt-dlp` | [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Video downloads: formats, audio-only, subtitles, playlists (guarded bulk) |
| `imp-osascript` | osascript | macOS automation: apps, notifications, dialogs, clipboard, Finder (guarded UI control) |
| `imp-brew` | [brew](https://brew.sh) | Homebrew: search, info, outdated, deps (guarded install/upgrade/cleanup) |
| `imp-selfimprove` | — | **Experimental** self-improving imp — learns from its own failed commands |
| `imp-minimal` | — | Bare template for building your own |

Local-only imps run sandboxed to match their promises: `imp-rg` is `read-only`; `imp-jq`, `imp-packx`, `imp-ffmpeg`, and `imp-imagemagick` are `workspace-write`. The sandbox enforces what the prompt claims.

## Usage

Every imp streams by default — you see commands, output, reasoning, and todos as they happen:

```bash
# Streaming (default) — shows everything in real-time
imp-gh "list my open PRs"

# Quiet mode — buffered, only shows the final answer
imp-gh -q "list my open PRs"

# Interactive codex TUI in this terminal
imp-gh -i

# Help
imp-gh --help

# Ctrl+C to stop at any time — kills agent + commands cleanly
```

### Pipe data in

Piped stdin is saved to a temp file and pointed out to the imp, so imps compose in pipelines:

```bash
cat data.json | imp-jq "how many users are on the pro plan?"
curl -s https://api.example.com/things | imp-jq "group these by status and count"
git log --oneline -30 | imp-git "summarize what shipped this week"
```

### Route without thinking: `imp`

`imp` picks the right imp from your prompt by deliberate keyword matching (free, instant, predictable — not a model call). When nothing matches or several imps tie, it lists candidates instead of guessing.

```bash
imp "what changed in git since yesterday?"     # -> imp-git
imp "trim the first 10s off intro.mp4"         # -> imp-ffmpeg
imp git "what changed?"                        # explicit tool prefix, no guessing
imp --which "list my PRs"                      # print the routing decision only
imp -l                                         # list all routes
```

### Manage the fleet: `imps`

```bash
imps list                    # roster: every imp, warm status, lesson count
imps ps                      # warm imps: pid, uptime, idle timeout
imps stop imp-gh             # stop one warm imp (or: imps stop --all)
imps lessons                 # which imps have learned lessons
imps lessons imp-gh          # one imp's lessons: date, category, command
imps lessons imp-gh --promote  # paste-ready Error-recovery candidates
imps lessons imp-gh --prune    # age out old lessons now
imps doctor                  # env sanity checks + stale socket cleanup
```

Warm imps **shut themselves down after 30 idle minutes** (the next call transparently respawns one). Tune with `CODEX_IMP_IDLE_MINUTES` (`0` disables).

### Warm mode (on by default)

**Warm mode is the default — no flags, no setup.** The first call to any imp auto-starts a warm background copy of itself and routes through it; every later call reuses that same warm imp for instant responses. The warm imp holds **one persistent `codex app-server` process** alive — so process spawn, auth/config load, and the WebSocket connection + prewarm are all paid **once** on that first call, not per prompt. Each call is a fresh `thread/start` + `turn/start` on the already-warm process.

```bash
# First call auto-spawns a warm background imp, answers, and leaves it warm
imp-gh "list my open PRs"

# Every later call routes through the warm imp automatically — just faster
imp-gh "list my open issues"

# Opt OUT: force a cold in-process run (SDK exec, no warm imp)
imp-gh --no-warm "list my open PRs"

# Run the warm imp server in the foreground instead (for a supervisor like launchd/systemd)
imp-gh --serve

# Per-prompt reasoning override (warm path)
imp-gh --effort minimal "what's my gh auth status"
```

The auto-started warm imp is detached and persists after the call returns, so it stays warm for your next prompt. Pass `--no-warm` whenever you want a one-off run that doesn't start or use the warm imp.

**Edits hot-reload automatically.** A warm imp holds your imp's code in memory, so editing it would normally have no effect until you killed the process by hand. Instead, every call fingerprints the imp's source — the executable (its instructions, model, env) plus every `lib/*.ts` module it loads — and compares it to what the running warm imp was started with. If anything changed, the stale process is stopped and a fresh one is spawned **before** your prompt runs. So you can tweak an imp's internal prompt, swap the model, or change shared lib code and the **very next prompt respects the change** — no manual restart, no flag.

### 🧪 Experimental: a self-improving imp (`imp-selfimprove`)

> **Status: experimental.** It is **on by default for every imp** through the shared runtime. Treat it as a research feature: an imp that rewrites its own prompt is inherently unpredictable, so don't point it at anything you can't afford to have it nudge over time. See the caveats below before relying on it.

The shared runtime includes self-improvement support for every imp. Opt out with `selfImprove: { enabled: false }` on an imp. When a turn ends, the runtime scans failed command executions (non-zero exits), classifies each failure (`command-not-found`, `usage-error`, `missing-path`, `permission-denied`, `timeout`, `connection-error`), and appends a categorized **lesson** with corrective advice to an `imps/<name>.lessons.md` overlay file. Expected non-failures (a `rg`/`grep`/`test` exiting 1 on "no match") are filtered out so the imp doesn't learn noise. On startup the imp folds the overlay into its `developerInstructions`, and the active lessons file is part of the hot-reload fingerprint — so the **next prompt restarts the warm imp with the new lesson baked into its own prompt**. Over time it accumulates operating guidance shaped by what actually went wrong.

```bash
imp-selfimprove "run a command that doesn't exist"   # turn 1: fails, records a lesson
cat imps/imp-selfimprove.lessons.md                  # see what it learned
imp-selfimprove "what have you learned so far?"      # turn 2: restarted, lesson now in its instructions
```

How it knows itself: self-improving imps receive `CODEX_IMP_SELF_PATH`, `CODEX_IMP_LIB_DIR`, and `CODEX_IMP_LESSONS_PATH` in the spawned Codex environment. Opted-out imps receive none of that self-improvement env. Lessons are deduped by a content signature (stable parts only, so volatile output doesn't defeat dedup), common secrets are redacted before rendering, and the writer fails open — a broken self-improvement step never breaks your turn.

**Lessons have a lifecycle.** Each lesson carries its date; lessons older than 30 days (configurable via `selfImprove.maxLessonAgeDays`) are pruned automatically whenever new lessons are appended, so stale guidance ages out instead of accumulating forever. Inspect with `imps lessons <name>`, prune on demand with `--prune`, and **graduate** a proven lesson into the imp's permanent `## Error recovery` section with `--promote` (it prints paste-ready lines).

**Why it's experimental (and the sharp edges):**

- **It edits its own prompt.** Each failed turn changes what the imp will be told next time. Behavior drifts as lessons accumulate, and a bad lesson can make it *worse*. There's no automatic rollback-on-regression yet — if it goes sideways, reset it: `rm imps/imp-selfimprove.lessons.md`.
- **Lessons can grow.** The runtime caps how many overlay bytes are loaded into the prompt (cutting at lesson boundaries, never mid-lesson), but the local lessons file can still accumulate over time. Prune the file periodically.
- **Failure detection is a heuristic** — it flags non-zero command exits (and `error`/`failed` markers), not genuine "mistakes." Known query commands that legitimately exit 1 are filtered, but other intentional non-zero exits can still generate a lesson.
- **It works via a shared runtime-side trigger, not Codex's hooks.** The intended design was a Codex `Stop` lifecycle hook, but the shipped Codex CLI (verified on 0.134/0.135) does **not** execute user-config hooks for non-interactive `exec`/`app-server` turns. So detection runs off the turn stream instead; optional `stopHook: true` wiring is kept only as forward-compat for builds that do run user hooks. This is the main reason it's labeled experimental rather than stable.
- **Lessons files are git-ignored** (`imps/*.lessons.md`) — an imp's learned state is local to your machine, not shared or versioned.

To try it safely, run it in a throwaway repo, watch `imps/imp-selfimprove.lessons.md`, and delete that file whenever you want a clean slate.

**`--effort <none|minimal|low|medium|high|xhigh>`** overrides reasoning effort for a single prompt. Lower is faster, but verified caveat: **`none` breaks tool use** — with zero reasoning the model answers trivial prompts ("say hi") but never decides to run commands, so a real `gh` task returns empty. `low` (the default) is the floor that reliably executes tools. Use `none`/`minimal` only for pure text replies.

Measured on `gpt-5.3-codex-spark` low effort, prompt `"say hi"`, N=8 each (same session):

| Mode | Median total | Mean | Range |
|---|---|---|---|
| Cold (SDK `codex exec` per request) | 6847 ms | 7042 ms | 4656–9901 |
| Warm (app-server imp) | 3187 ms | 3108 ms | 2095–3978 |

**~2x faster.** The first protocol frame returns in ~1 ms (the connection is hot and waiting); the remaining seconds are pure model inference on your prompt — the one cost that can't be pre-paid, since the model hasn't seen the prompt until you send it. Run-to-run variance is high (backend scheduling), so collect ≥8 samples before drawing conclusions.

Benchmark it yourself:

```bash
bun bench.ts imp-gh "say hi" --runs 8            # cold
imp-gh --serve &                                 # warm
bun bench.ts imp-gh "say hi" --runs 8 --warm
```

Want to see the raw warm-floor breakdown (setup cost, first-frame vs first-content-token, fresh-thread vs same-thread)? Run `bun probe-appserver.ts`.

### What you see while streaming

```
$ gh pr list --author @me --state all --limit 3    ← command (dimmed)
#42 fix login bug  OPEN                            ← command output (dimmed)
#38 add search     MERGED                          ← command output (dimmed)
                                                   
Your 2 most recent PRs:                            ← agent's answer (normal)
1. #42 fix login bug (open)
2. #38 add search (merged)
```

Reasoning text appears in dim italic. Todo items show with ○/✓ marks. All verbose output goes to stderr, final answer to stdout — so `imp-gh "list PRs" > prs.txt` captures only the clean answer.

## Create your own

### Option A: Interactive generator

```bash
bun run create
# or after global install:
imp-create
```

### Option B: Copy-paste prompt

See [docs/PROMPT.md](docs/PROMPT.md) — paste it into any AI agent with your tool's `--help` output.

### Option C: Copy the template

```bash
cp imps/imp-minimal imps/imp-my-tool
chmod +x imps/imp-my-tool
# Edit and customize
```

## Prompt design

Prompts are optimized for `gpt-5.3-codex-spark` at `low` reasoning effort (reviewed by Oracle/GPT-5.5-pro). Key patterns:

- **Operating rule first**: "Run [tool] via exec_command before any final answer. Do not answer from memory."
- **Command maps**: Explicit IF/THEN mappings instead of vague instructions. Low-reasoning models need literal decision shortcuts.
- **Worked examples**: 3-5 few-shot examples per imp (user request → numbered exact command sequence → report step). Low-reasoning models imitate examples far better than they follow abstract rules.
- **Error recovery maps**: exact error text → exact next command, so a failed command never dead-ends the turn.
- **Consistent structure**: Every imp follows the same section order: Operating rule → Command map → Workflow → Worked examples → Error recovery → Command rules → Output.
- **No --help dumps**: Curated command maps are more effective than raw CLI reference for low-reasoning models.

## How isolation works

Each imp creates a temporary `CODEX_HOME` with only a symlinked `auth.json`. Combined with feature flags, this strips ~16K tokens of overhead:

| What's disabled | Tokens saved | Config key |
|---|---|---|
| Server-side apps (Gmail, Slack, DeepWiki) | ~14,000 | `features.apps = false` |
| Image generation | ~1,000 | `features.image_generation = false` |
| Web search | ~1,000 | `web_search = "disabled"` |
| Tool discovery | ~500 | `features.tool_search = false` |
| Model system prompt | ~5,000 | `base_instructions` override |
| Skills, plugins, hooks, memories | varies | Feature flags |

See [docs/ISOLATION.md](docs/ISOLATION.md) for the full research with source line references.

## Evals (model-paid behavioral checks)

`bun test` proves the imps *load*; evals prove they *behave*. Each suite in `evals/` runs real prompts against a hermetic temp-dir fixture and asserts on the answer **and** the resulting filesystem (e.g. imp-jq must create `users.csv` and must NOT touch `users.json`; imp-git must commit only the named file and leave unrelated dirty files alone). One model turn per case — run after editing an imp's prompt; hot-reload means the very next eval exercises the change.

```bash
bun run evals               # all suites
bun evals.ts imp-jq         # one suite
bun evals.ts imp-git --filter commit --keep   # one case, keep sandbox for post-mortem
```

## Tests

Fast, model-free smoke tests guard against arg-parsing and load regressions:

```bash
bun test
```

`test/parseargs.test.ts` exhaustively checks flag/prompt parsing (the spot a past `--effort` bug dropped the first prompt word). `test/cli-smoke.test.ts` loads every imp binary, checks `--help`/no-args, and confirms a real prompt survives parsing without paying a model turn.

**Push gate:** enable the pre-push hook once per clone so failing tests block a push:

```bash
git config core.hooksPath .githooks
```

(Override an individual push with `git push --no-verify`.)

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Codex CLI](https://www.npmjs.com/package/@openai/codex) (authenticated — `codex auth login`)
- The CLI tool each imp wraps (e.g. `gh`, `bird`, `cmux`)
