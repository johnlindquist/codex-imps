# codex-daemons

Single-purpose, isolated [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) agents for common CLI tools. Each profile runs with ~6K input tokens instead of the default ~22K — faster, cheaper, and focused. Warm mode is **on by default**: the first call auto-starts a background daemon and every later call reuses it for ~2x lower latency (opt out with `--no-warm`).

All profiles start with `pro-` so you can type `pro-` and tab-complete to see every available agent.

## What is a profile?

A profile is a single executable TypeScript file that wraps a CLI tool with an isolated Codex agent. It:

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
git clone https://github.com/johnlindquist/codex-daemons
cd codex-daemons
bun install
bun link
```

This symlinks all profiles to `~/.bun/bin/`. Type `pro-` then tab to see them all. You can also run profiles directly without linking:

```bash
bun daemons/pro-gh "list my open PRs"
```

## Profiles

| Command | Tool | Description |
|---------|------|-------------|
| `pro-cmux` | [cmux](https://github.com/manaflow-ai/cmux) | Terminal workspace automation |
| `pro-cmux-extensions` | cmux/files | Persistent cmux extension authoring: actions, scripts, receipts, dock controls, and custom sidebars |
| `pro-git` | [git](https://git-scm.com) | Local Git (status, diff, branches, log, stash, commit, safe sync) |
| `pro-docker` | [docker](https://docs.docker.com/engine/reference/commandline/cli/) | Containers, images, volumes, networks, Compose (guarded lifecycle) |
| `pro-npm` | [npm](https://docs.npmjs.com/cli) | Node scripts, deps, package metadata, installs, audits |
| `pro-kubectl` | [kubectl](https://kubernetes.io/docs/reference/kubectl/) | Kubernetes pods, services, logs, events, rollouts (guarded apply/delete) |
| `pro-terraform` | [terraform](https://developer.hashicorp.com/terraform/cli) | IaC init, fmt, validate, plan, state inspection (guarded apply/destroy) |
| `pro-aws` | [aws](https://docs.aws.amazon.com/cli/) | AWS identity, EC2/S3/Lambda/logs inventory (guarded mutations) |
| `pro-jq` | [jq](https://jqlang.github.io/jq/) | Inspect, filter, and transform JSON; build & test precise filters |
| `pro-rg` | [ripgrep](https://github.com/BurntSushi/ripgrep) | Fast codebase search (read-only): symbols, TODOs, imports, configs |
| `pro-psql` | [psql](https://www.postgresql.org/docs/current/app-psql.html) | PostgreSQL schema, indexes, query plans, stats, locks (guarded writes) |
| `pro-gcloud` | [gcloud](https://cloud.google.com/sdk/gcloud) | Google Cloud project/account/resource inventory (guarded mutations) |
| `pro-gh` | [gh](https://cli.github.com) | GitHub CLI (issues, PRs, releases, actions) |
| `pro-zsh` | zsh/files | John's `~/.config/zsh` specialist for aliases, functions, wrappers, startup, and tests |
| `pro-gmail` | [gog](https://github.com/johnlindquist/gog) | Gmail search/read/draft specialist using the gog CLI with no-send defaults |
| `pro-karabiner` | [goku](https://github.com/yqrashawn/GokuRakuJoTu) | Karabiner-Elements config (karabiner.edn) |
| `pro-packx` | [packx](https://www.npmjs.com/package/packx) | AI context bundling |
| `pro-memory` | [basic-memory](https://github.com/basicmachines-co/basic-memory) | Knowledge management |
| `pro-bird` | [bird](https://www.npmjs.com/package/bird) | Twitter/X CLI |
| `pro-browser` | [agent-browser](https://www.npmjs.com/package/agent-browser) | Browser automation (hidden/headless browser it owns) |
| `pro-browser-automate` | [agent-browser](https://www.npmjs.com/package/agent-browser) | Drives your **live** Chrome over CDP — your real tabs, logins, session |
| `pro-selfimprove` | — | **Experimental** self-improving daemon — learns from its own failed commands |
| `pro-minimal` | — | Bare template for building your own |

## Usage

Every profile streams by default — you see commands, output, reasoning, and todos as they happen:

```bash
# Streaming (default) — shows everything in real-time
pro-gh "list my open PRs"

# Quiet mode — buffered, only shows the final answer
pro-gh -q "list my open PRs"

# Interactive codex TUI in this terminal
pro-gh -i

# Help
pro-gh --help

# Ctrl+C to stop at any time — kills agent + commands cleanly
```

### Warm mode (on by default)

**Warm mode is the default — no flags, no setup.** The first call to any profile auto-starts a background daemon and routes through it; every later call reuses that same daemon for instant responses. The daemon holds **one persistent `codex app-server` process** alive — so process spawn, auth/config load, and the WebSocket connection + prewarm are all paid **once** on that first call, not per prompt. Each call is a fresh `thread/start` + `turn/start` on the already-warm process.

```bash
# First call auto-spawns a background daemon, answers, and leaves it warm
pro-gh "list my open PRs"

# Every later call routes through the warm daemon automatically — just faster
pro-gh "list my open issues"

# Opt OUT: force a cold in-process run (SDK exec, no daemon)
pro-gh --no-warm "list my open PRs"

# Run the daemon in the foreground instead (for a supervisor like launchd/systemd)
pro-gh --daemon

# Per-prompt reasoning override (warm daemon path)
pro-gh --effort minimal "what's my gh auth status"
```

The auto-started daemon is detached and persists after the call returns, so it stays warm for your next prompt. Pass `--no-warm` whenever you want a one-off run that doesn't start or use a daemon.

**Edits hot-reload automatically.** A warm daemon holds your profile's code in memory, so editing it would normally have no effect until you killed the daemon by hand. Instead, every call fingerprints the daemon's source — the profile executable (its instructions, model, env) plus every `lib/*.ts` module it loads — and compares it to what the running daemon was started with. If anything changed, the stale daemon is stopped and a fresh one is spawned **before** your prompt runs. So you can tweak a profile's internal prompt, swap the model, or change shared lib code and the **very next prompt respects the change** — no manual restart, no flag.

### 🧪 Experimental: a self-improving daemon (`pro-selfimprove`)

> **Status: experimental.** Added recently alongside the hot-reload work (see commits `Make warm daemon mode the default` → `Add pro-browser-automate + self-improve & hot-reload work`). It is now **on by default for every profile** through the shared runtime. Treat it as a research feature: a daemon that rewrites its own prompt is inherently unpredictable, so don't point it at anything you can't afford to have it nudge over time. See the caveats below before relying on it.

The shared runtime includes self-improvement support for every daemon. Opt out with `selfImprove: { enabled: false }` on a profile. When a turn ends, the runtime can scan failed command executions (non-zero exits) and append a concise **lesson** to a `daemons/<name>.lessons.md` overlay file. On startup that profile folds the overlay into its `developerInstructions`, and the active lessons file is part of the hot-reload fingerprint — so the **next prompt restarts the daemon with the new lesson baked into its own prompt**. Over time it accumulates operating guidance shaped by what actually went wrong.

```bash
pro-selfimprove "run a command that doesn't exist"   # turn 1: fails, records a lesson
cat daemons/pro-selfimprove.lessons.md               # see what it learned
pro-selfimprove "what have you learned so far?"        # turn 2: daemon restarted, lesson now in its instructions
```

How it knows itself: self-improving profiles receive `CODEX_DAEMON_SELF_PATH`, `CODEX_DAEMON_LIB_DIR`, and `CODEX_DAEMON_LESSONS_PATH` in the spawned Codex environment. Opted-out profiles receive none of that self-improvement env. Lessons are deduped by a content signature, common secrets are redacted before rendering, and the writer fails open — a broken self-improvement step never breaks your turn.

**Why it's experimental (and the sharp edges):**

- **It edits its own prompt.** Each failed turn changes what the daemon will be told next time. Behavior drifts as lessons accumulate, and a bad lesson can make it *worse*. There's no automatic rollback-on-regression yet — if it goes sideways, reset it: `rm daemons/pro-selfimprove.lessons.md`.
- **Lessons can grow.** The runtime caps how many overlay bytes are loaded into the prompt, but the local lessons file can still accumulate over time. Prune the file periodically.
- **Failure detection is a blunt heuristic** — it flags non-zero command exits (and `error`/`failed` markers), not genuine "mistakes." A command that's *supposed* to exit non-zero (a probe, a grep with no match) can still generate a lesson.
- **It works via a shared daemon-side trigger, not Codex's hooks.** The intended design was a Codex `Stop` lifecycle hook, but the shipped Codex CLI (verified on 0.134/0.135) does **not** execute user-config hooks for non-interactive `exec`/`app-server` turns. So detection runs daemon-side off the turn stream instead; optional `stopHook: true` wiring is kept only as forward-compat for builds that do run user hooks. This is the main reason it's labeled experimental rather than stable.
- **Lessons files are git-ignored** (`daemons/*.lessons.md`) — a daemon's learned state is local to your machine, not shared or versioned.

To try it safely, run it in a throwaway repo, watch `daemons/pro-selfimprove.lessons.md`, and delete that file whenever you want a clean slate.

**`--effort <none|minimal|low|medium|high|xhigh>`** overrides reasoning effort for a single prompt. Lower is faster, but verified caveat: **`none` breaks tool use** — with zero reasoning the model answers trivial prompts ("say hi") but never decides to run commands, so a real `gh` task returns empty. `low` (the default) is the floor that reliably executes tools. Use `none`/`minimal` only for pure text replies.

Measured on `gpt-5.3-codex-spark` low effort, prompt `"say hi"`, N=8 each (same session):

| Mode | Median total | Mean | Range |
|---|---|---|---|
| Cold (SDK `codex exec` per request) | 6847 ms | 7042 ms | 4656–9901 |
| Warm (app-server daemon) | 3187 ms | 3108 ms | 2095–3978 |

**~2x faster.** The first protocol frame returns in ~1 ms (the connection is hot and waiting); the remaining seconds are pure model inference on your prompt — the one cost that can't be pre-paid, since the model hasn't seen the prompt until you send it. Run-to-run variance is high (backend scheduling), so collect ≥8 samples before drawing conclusions.

Benchmark it yourself:

```bash
bun bench.ts pro-gh "say hi" --runs 8            # cold
pro-gh --daemon &                                 # warm
bun bench.ts pro-gh "say hi" --runs 8 --warm
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

Reasoning text appears in dim italic. Todo items show with ○/✓ marks. All verbose output goes to stderr, final answer to stdout — so `pro-gh "list PRs" > prs.txt` captures only the clean answer.

## Create your own

### Option A: Interactive generator

```bash
bun run create
# or after global install:
pro-create
```

### Option B: Copy-paste prompt

See [docs/PROMPT.md](docs/PROMPT.md) — paste it into any AI agent with your tool's `--help` output.

### Option C: Copy the template

```bash
cp daemons/pro-minimal daemons/pro-my-tool
chmod +x daemons/pro-my-tool
# Edit and customize
```

## Prompt design

Prompts are optimized for `gpt-5.3-codex-spark` at `low` reasoning effort (reviewed by Oracle/GPT-5.5-pro). Key patterns:

- **Operating rule first**: "Run [tool] via exec_command before any final answer. Do not answer from memory."
- **Command maps**: Explicit IF/THEN mappings instead of vague instructions. Low-reasoning models need literal decision shortcuts.
- **Consistent structure**: Every profile follows the same section order: Operating rule → Command map → Workflow → Command rules → Output.
- **No --help dumps**: Curated command maps are more effective than raw CLI reference for low-reasoning models.

## How isolation works

Each profile creates a temporary `CODEX_HOME` with only a symlinked `auth.json`. Combined with feature flags, this strips ~16K tokens of overhead:

| What's disabled | Tokens saved | Config key |
|---|---|---|
| Server-side apps (Gmail, Slack, DeepWiki) | ~14,000 | `features.apps = false` |
| Image generation | ~1,000 | `features.image_generation = false` |
| Web search | ~1,000 | `web_search = "disabled"` |
| Tool discovery | ~500 | `features.tool_search = false` |
| Model system prompt | ~5,000 | `base_instructions` override |
| Skills, plugins, hooks, memories | varies | Feature flags |

See [docs/ISOLATION.md](docs/ISOLATION.md) for the full research with source line references.

## Tests

Fast, model-free smoke tests guard against arg-parsing and load regressions:

```bash
bun test
```

`test/parseargs.test.ts` exhaustively checks flag/prompt parsing (the spot a past `--effort` bug dropped the first prompt word). `test/cli-smoke.test.ts` loads every profile binary, checks `--help`/no-args, and confirms a real prompt survives parsing without paying a model turn.

**Push gate:** enable the pre-push hook once per clone so failing tests block a push:

```bash
git config core.hooksPath .githooks
```

(Override an individual push with `git push --no-verify`.)

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Codex CLI](https://www.npmjs.com/package/@openai/codex) (authenticated — `codex auth login`)
- The CLI tool each profile wraps (e.g. `gh`, `bird`, `cmux`)
