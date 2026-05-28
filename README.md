# codex-profiles

Single-purpose, isolated [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) agents for common CLI tools. Each profile runs with ~6K input tokens instead of the default ~22K — faster, cheaper, and focused.

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
git clone https://github.com/johnlindquist/codex-profiles
cd codex-profiles
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

# Interactive TUI in a new cmux pane
pro-gh -i

# Help
pro-gh --help

# Ctrl+C to stop at any time — kills agent + commands cleanly
```

### Warm mode (lower latency)

Start a long-running daemon for any profile; subsequent calls auto-detect the socket and route through it, skipping bun startup + SDK import + isolated `CODEX_HOME` setup.

```bash
# Start the daemon (foreground — backgrounds nicely with `&` or your supervisor)
pro-gh --daemon

# In another shell — same exact command, just faster
pro-gh "list my open PRs"

# Force in-process even if daemon is up
pro-gh --no-warm "list my open PRs"
```

Measured on `gpt-5.3-codex-spark` low effort, prompt `"say hi"`, N=8 each:

| Mode | Median TTFT | Mean TTFT | Range |
|---|---|---|---|
| Cold (no daemon) | 5444 ms | 5873 ms | 5007–8628 |
| Warm (via daemon) | 4907 ms | 5079 ms | 4533–5694 |

Savings ~500 ms median come from skipping the client's bun+SDK boot. The dominant remaining cost (~4.5s) is the model API roundtrip — every request still spawns a fresh `codex exec` inside the daemon and sends ~6K tokens to OpenAI. To go below ~4.5s you'd need session caching via `resumeThread` (different optimization axis).

Run-to-run variance is high relative to the savings — collect ≥8 samples before drawing conclusions from your own benchmarks.

Benchmark it yourself:

```bash
bun bench.ts pro-gh "say hi" --runs 5            # cold
pro-gh --daemon &                                 # warm
bun bench.ts pro-gh "say hi" --runs 5 --warm
```

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

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Codex CLI](https://www.npmjs.com/package/@openai/codex) (authenticated — `codex auth login`)
- The CLI tool each profile wraps (e.g. `gh`, `bird`, `cmux`)
