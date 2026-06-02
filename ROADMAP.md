# VibeGuard — Roadmap & Command Guide

> **What is VibeGuard?**
> A local-only CLI that helps you and your AI coding assistant understand a codebase
> *cheaply and safely*. It maps your dependencies, finds secrets and attack surfaces,
> removes dead code reversibly, scores project health, packs minimal context for AI
> (80–95% fewer tokens), and now compresses AI replies with **Caveman Mode**.
>
> **Everything runs on your machine.** No cloud, no native build, Node ≥ 18.

---

## 1. Quick Start (60 seconds)

```bash
# 1. Install (global) — or symlink the repo for local dev
npm install -g vibeguard

# 2. Set up the project (creates .vibeguard/, all gitignored)
vibeguard init

# 3. Build the dependency graph
vibeguard map

# 4. Open the interactive menu — easiest way to use everything
vibeguard --run
```

That's it. From the interactive menu you can reach **every** feature below without
remembering a single flag.

---

## 2. The 5 Things People Use Most

| I want to… | Run this | What you get |
|---|---|---|
| Save AI tokens on every reply | `vibeguard caveman on` | Terse, high-signal AI answers (~35–75% fewer tokens) |
| Give my AI the *right* files only | `vibeguard pack "fix login bug"` | A focused context bundle, not the whole repo |
| Find leaked secrets / risky code | `vibeguard --scan` | Secrets, `.gitignore` gaps, framework misuse |
| See how my project is doing | `vibeguard --health` | One 0–100 score with sub-scores |
| Visualize the codebase | `vibeguard graph` | Interactive HTML dependency map |

---

## 3. Full Command Reference (all shipped ✅)

### Setup & everyday
| Command | What it does |
|---|---|
| `vibeguard init` | Create `.vibeguard/` config |
| `vibeguard --run` | Interactive menu (recommended entry point) |
| `vibeguard map` | Build/refresh the dependency graph (incremental) |
| `vibeguard watch` | Auto-rebuild graph/tags/importance on file save |
| `vibeguard graph` | Generate + open the interactive HTML graph |

### Understand the code (zero tokens — answered from the graph)
| Command | What it does |
|---|---|
| `vibeguard query "<question>"` | Answer a question without reading files |
| `vibeguard explain <node>` | Role, connections, and importance of a file/symbol |
| `vibeguard affected <node>` | What breaks if this changes (reverse impact) |
| `vibeguard path <a> <b>` | Shortest dependency path between two nodes |
| `vibeguard flows` | Execution flows, architectural bridges, knowledge gaps |
| `vibeguard search "<query>"` | Hybrid keyword + semantic search (local) |
| `vibeguard benchmark` | Token usage: VibeGuard graph vs reading every file |

### Security & safety (the moat)
| Command | What it does |
|---|---|
| `vibeguard security` / `--scan` | Find secrets + `.gitignore` gaps |
| `vibeguard security --fix gitignore\|env` | Auto-fix the common gaps |
| `vibeguard attack` | Scan for DDoS, brute-force, OTP abuse, SQLi, XSS, SSRF |
| `vibeguard attack --ai --fix` | AI-powered deep scan + apply fixes |
| `vibeguard clean --plan` | Detect dead code (no changes yet) |
| `vibeguard clean --apply` | Move dead files to recoverable trash |
| `vibeguard trash list\|restore\|purge` | Manage soft-deleted files |
| `vibeguard hook install` | Git pre-commit hook that blocks secret commits |
| `vibeguard doctor` / `--health` | Project Health Score (0–100) |

### AI context & output
| Command | What it does |
|---|---|
| `vibeguard pack "<task>"` | Minimal task-focused context bundle (80–95% fewer tokens) |
| `vibeguard add <file.pdf>` | Ingest a PDF, link its concepts to the graph |
| `vibeguard caveman on\|off\|status\|level` | **Caveman Mode** — compress AI replies on every chat |
| `vibeguard review` | Risk-scored review of changed files + security fold-in |

### Connect to your AI assistant
| Command | What it does |
|---|---|
| `vibeguard install --platform <name>` | Wire VibeGuard into Kiro/Cursor/Claude/Copilot/Gemini/Aider |
| `vibeguard serve` (alias `mcp`) | Start the MCP server — live agent tools over stdio |
| `vibeguard config set-key <key>` | Save an LLM API key for AI-powered scans |

---

## 4. ⭐ Caveman Mode — Save Tokens & Boost Speed

> *"Why use many token when few do trick."*

Makes your AI assistant answer like a smart caveman: drop filler, keep 100% technical
accuracy, reply in dense fragments. Inspired by the
[`caveman`](https://github.com/JuliusBrussee/caveman) skill. *(Description rephrased for
compliance with the source's licensing.)*

**Use it:**
```bash
vibeguard caveman on          # enable (default level: full)
vibeguard caveman on ultra    # enable at max compression
vibeguard caveman level lite  # change level, stays on
vibeguard caveman status      # check current state
vibeguard caveman benchmark   # show real measured token savings per level
vibeguard caveman off         # back to normal prose
```
Or pick **🪨 Caveman Mode** from `vibeguard --run`. One-step setup with your
assistant: `vibeguard install --platform kiro --caveman ultra`. An AI agent can
also toggle it live through the MCP `set_caveman` tool, and `vibeguard doctor`
reports whether it's on.

**Levels:** `lite` (~35%, full sentences) · `full` (~65%, classic) · `ultra` (~75%, telegraphic).

**How it sticks across every chat:** enabling writes an *always-on* rule file your
assistant reads each turn — `.kiro/steering/vibeguard-caveman.md` for Kiro, plus mirrors
for Cursor (`.cursor/rules`), Windsurf (`.windsurf/rules`), and a marker-fenced block in
`CLAUDE.md` / Copilot / Gemini / `AGENTS.md` / `.windsurfrules` / `.clinerules` **if those
already exist**. Every reply starts with a visible `🪨 Caveman mode: ON (<level>)` line so
you always know it's active. State lives in `.vibeguard/caveman.json`. Turning it off
removes every rule cleanly. Code, commits, and security warnings are always written in full
prose — safety first.

> **Important:** assistants read always-on rules at the **start of a chat session**. After
> `caveman on`, open a **new chat** (or reload the IDE window) so the rule loads — otherwise
> the current chat won't change.

---

## 5. Status — Now / Next / Later

### ✅ Now (shipped & tested — 293 tests passing)
- **Core graph:** incremental `map` (SHA-256 change detection), file add/delete tracking
  with `+added`/`-removed` deltas, `watch`, interactive HTML graph, architecture report.
- **Understanding:** `query`, `explain`, `affected`, `path`, `flows`, `search`, `benchmark`.
- **Security & safety:** `security` (+fixes), `attack` (+AI fix), reversible `clean`/`trash`,
  `doctor` health score, git `hook`.
- **AI context & output:** `pack`, `add` (PDF), **Caveman Mode**, risk-scored `review`.
- **Integration:** `install`/`uninstall` for 6 assistants, MCP `serve`, interactive `--run`.

### 🔜 Next (close the gaps — small, high-value)
- [x] `install --caveman [level]` enables Caveman in the same step (one-command setup)
- [x] `uninstall` also removes the Caveman rule file (no leftover on teardown)
- [x] MCP `set_caveman` tool so an agent can toggle Caveman live, mid-chat
- [x] `doctor` shows a "Caveman: on (ultra)" status line (text + JSON)
- [x] `caveman benchmark` — real measured token savings per level (deterministic compressor)

### 🌅 Later (bigger bets)
- [ ] **Exports:** `visualize --format graphml|cypher|obsidian|svg`, `wiki`, `graph-diff <ref>`
- [ ] **Multi-repo:** `register`/`repos`, `cross-search`, background daemon, `~/.vibeguard/watch.toml`
- [ ] **Proof & reach:** deterministic eval pipeline, published benchmarks (token reduction,
      impact recall), 15+ languages, VS Code extension, CI hardening (coverage + cross-OS)

---

## 6. How VibeGuard Works (A → Z)

1. **Install** → `npm i -g vibeguard` (Node ≥ 18, no native build).
2. **Init** → `vibeguard init` writes `.vibeguard/` (config + artifacts, gitignored).
3. **Map** → resolves the live file set, parses imports/exports, builds `graph.json`
   incrementally (unchanged files are skipped via SHA-256 hashes).
4. **Track** → new files auto-added, deleted files auto-pruned; `map`/`watch` report deltas.
5. **Understand** → `query`/`explain`/`affected`/`path`/`flows`/`search` answer from the graph.
6. **Secure** → `security` + `attack` find risks; `clean` removes dead code to recoverable trash.
7. **Score** → `doctor` rolls it all into one health number.
8. **Pack** → `pack "<task>"` builds a minimal AI context bundle.
9. **Compress** → `caveman on` shrinks AI output on every reply.
10. **Integrate** → `install` wires it into your assistant; `serve` exposes live MCP tools.

---

## 7. Guiding Principles (don't break these)

1. **Zero token cost for the core.** Graph, query, security, dead-code, health stay 100% local.
2. **No native compilation.** Pure TypeScript on Node ≥ 18 — never add a native build step.
3. **Stable JSON contracts.** Every command emits one JSON doc with `schemaVersion`.
4. **Safety first.** Mutations are opt-in, support `--dry-run`, and route deletes through recoverable trash.
5. **Loaders are TTY-only.** Never corrupt `--json` / CI output.
6. **No repo litter.** Integrations only touch files you already have; everything is reversible.
7. **The moat is non-negotiable.** Security, cyberattack defense, reversible cleanup, health
   scoring, and Caveman compression are the combination no competitor matches — keep them first-class.

---

## 8. Project Facts

- **Package:** `vibeguard` v0.1.0 · MIT · Node ≥ 18
- **Build:** `npm run build` (tsc) · **Test:** `npm test` (vitest) · **Lint/typecheck:** `npm run lint`
- **Key deps:** `commander`, `ts-morph`, `@modelcontextprotocol/sdk`, `@inquirer/prompts`, `chalk`, `ora`
- **Layout:** `src/commands/*` (CLI entry points) · `src/engines/*` (analysis logic) ·
  `src/storage/*` (config + file store) · `test/{unit,integration,property}/*`
- **Local data:** everything lives under `.vibeguard/` and is gitignored.
