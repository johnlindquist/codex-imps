# codex-daemons

Single-purpose, isolated [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) agents for common CLI tools. Each profile runs with ~6K input tokens instead of the default ~22K — faster, cheaper, and focused. Keep one warm per profile (`--daemon`) for ~2x lower latency.

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
bun profiles/pro-gh "list my open PRs"
```

## Profiles

| Command | Tool | Description |
|---------|------|-------------|
| `pro-cmux` | [cmux](https://github.com/manaflow-ai/cmux) | Terminal workspace automation |
| `pro-git` | [git](https://git-scm.com) | Local Git (status, diff, branches, log, stash, commit, safe sync) |
| `pro-docker` | [docker](https://docs.docker.com/engine/reference/commandline/cli/) | Containers, images, volumes, networks, Compose (guarded lifecycle) |
| `pro-gh` | [gh](https://cli.github.com) | GitHub CLI (issues, PRs, releases, actions) |
| `pro-karabiner` | [goku](https://github.com/yqrashawn/GokuRakuJoTu) | Karabiner-Elements config (karabiner.edn) |
| `pro-packx` | [packx](https://www.npmjs.com/package/packx) | AI context bundling |
| `pro-memory` | [basic-memory](https://github.com/basicmachines-co/basic-memory) | Knowledge management |
| `pro-bird` | [bird](https://www.npmjs.com/package/bird) | Twitter/X CLI |
| `pro-browser` | [agent-browser](https://www.npmjs.com/package/agent-browser) | Browser automation |
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

### Warm mode (lower latency)

Start a long-running daemon for any profile; subsequent calls auto-detect the socket and route through it. The daemon holds **one persistent `codex app-server` process** alive — so process spawn, auth/config load, and the WebSocket connection + prewarm are all paid **once at startup**, not per prompt. Each call is a fresh `thread/start` + `turn/start` on the already-warm process.

```bash
# Start the daemon (foreground — backgrounds nicely with `&` or your supervisor)
pro-gh --daemon

# In another shell — same exact command, just faster, answer streams token-by-token
pro-gh "list my open PRs"

# Force in-process (SDK exec, no daemon) even if a daemon is up
pro-gh --no-warm "list my open PRs"

# Per-prompt reasoning override (warm daemon path)
pro-gh --effort minimal "what's my gh auth status"
```

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
cp profiles/pro-minimal profiles/pro-my-tool
chmod +x profiles/pro-my-tool
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
