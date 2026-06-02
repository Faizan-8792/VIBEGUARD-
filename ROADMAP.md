# VibeGuard Roadmap — v2.0 (The Unbeatable Blend)

**Vision:** The unbeatable local-first code intelligence tool — a blend of Graphify's
token-reduction, code-review-graph's deep graph intelligence (blast radius, real MCP
server, flows, semantic search), and VibeGuard's unique security + safety + health moat.

**Positioning in one line:** *Graphify saves you tokens. code-review-graph reviews your
changes. VibeGuard does both — and is the only one that also finds secrets, blocks
cyberattacks, and cleans dead code reversibly — all locally, at zero token cost.*

> v1.0 (Days 1–10) and post-v1.0 hardening are shipped and removed from this file.
> Current baseline: health 93/100 (security 100, architecture 100, dead-code 92,
> context-efficiency 80), 214 tests passing, zero dependency cycles.

---

## Competitive Analysis (why v2.0 exists)

| Capability | Graphify | code-review-graph | VibeGuard (today) | VibeGuard (v2.0 target) |
|---|---|---|---|---|
| Graph build cost | 5k–50k tokens | 0 (local) | 0 (local) | **0 (local)** |
| Storage | cloud | SQLite + FTS5 | JSON files | **SQLite + FTS5** |
| **Live MCP server** | ✅ | ✅ (30 tools) | ❌ (instructions only) | **✅ real server** |
| Blast-radius / impact | partial | ✅ 100% recall | partial (`affected`) | **✅ measured recall** |
| Execution flows | ❌ | ✅ criticality-sorted | ❌ | **✅** |
| Semantic search | ✅ | ✅ (embeddings) | ❌ (keyword only) | **✅ optional embeddings** |
| Risk-scored change review | ❌ | ✅ `detect-changes` | ❌ | **✅ `review`** |
| Token-savings proof | claims | ✅ `--verify` tiktoken | estimate only | **✅ verified** |
| Export (GraphML/Cypher/Obsidian) | ❌ | ✅ | ❌ | **✅** |
| Multi-repo daemon | ❌ | ✅ | ❌ | **✅** |
| **Security scanning** | ❌ | ❌ | ✅ | **✅ (moat)** |
| **Cyberattack scan + AI fix** | ❌ | ❌ | ✅ | **✅ (moat)** |
| **Dead-code → trash → restore** | ❌ | detect-only | ✅ | **✅ (moat)** |
| **Health Score** | ❌ | ❌ | ✅ | **✅ (moat)** |
| Languages | 25 | 30+ (tree-sitter) | 5 (TS/JS deep + 4 regex) | **15+** |

**Strategic takeaway:** keep the security/safety/health moat, then close the graph-intelligence
gap. The highest-leverage single item is the **real MCP server** — it converts every existing
VibeGuard command into a live agent tool instead of a "shell out and parse" instruction.

---

## Phase 1: Real MCP Server  ⭐ highest leverage — DO THIS FIRST
*Turn VibeGuard from "instructions that tell an AI to shell out" into a live tool server.*

- [ ] Task 1.1: Add `@modelcontextprotocol/sdk` dependency and create `src/mcp/server.ts` (stdio transport)
- [ ] Task 1.2: Add `vibeguard serve` (alias `mcp`) command that boots the MCP server
- [ ] Task 1.3: Expose existing engines as MCP tools — `scan_security`, `scan_attacks`, `get_health`, `build_graph`, `query_graph`, `find_path`, `explain_node`, `get_affected`, `pack_context`, `detect_dead_code`
- [ ] Task 1.4: Add `get_minimal_context` tool (~100-token ultra-compact summary, called first)
- [ ] Task 1.5: Tool allowlist via `--tools a,b,c` and `VIBEGUARD_TOOLS` env (token-constrained clients)
- [ ] Task 1.6: Update all `install` targets to write real MCP config (`.mcp.json`) pointing at `vibeguard serve`, not just instruction files
- [ ] Task 1.7: Tests — spin up server in-process, assert each tool returns valid JSON with `schemaVersion`

## Phase 2: SQLite Graph Backend + FTS
*Replace JSON-file graph with a queryable, incremental, full-text-indexed store.*

- [ ] Task 2.1: Choose a zero-native-build SQLite (verify `better-sqlite3` prebuilds OR use `node:sqlite` (Node 22+) / WASM) to preserve the "no native compilation" guarantee
- [ ] Task 2.2: Create `src/storage/graph-db.ts` with `nodes`, `edges`, `metadata`, `communities`, `flows` tables (WAL mode)
- [ ] Task 2.3: Migration layer (versioned schema upgrades) + auto-migrate on open
- [ ] Task 2.4: Dual-write phase — keep `graph.json` export for back-compat, make SQLite the source of truth
- [ ] Task 2.5: FTS5 virtual table over node name / qualified-name / file / signature
- [ ] Task 2.6: Rewrite `query-engine` reads to hit SQLite indexes (qualified_name, file_path, edge source/target)
- [ ] Task 2.7: Benchmark — confirm sub-millisecond node lookup and faster incremental rebuilds on a 1k-file project

## Phase 3: Risk-Scored Change Review (the "code review" pillar)
*code-review-graph's core value prop — and it pairs perfectly with our security scan.*

- [ ] Task 3.1: `src/engines/change-detector.ts` — read `git diff`, map changed lines → affected nodes
- [ ] Task 3.2: Compute blast radius (BFS forward + reverse edges, configurable depth, default 2)
- [ ] Task 3.3: Risk score per change = blast-radius size × importance × (test-gap? boost)
- [ ] Task 3.4: `vibeguard review [--base <ref>]` — risk-ranked review items + test-coverage gaps
- [ ] Task 3.5: **Differentiator** — fold Security + Attack findings on changed files into the same review output (no competitor does this)
- [ ] Task 3.6: `--brief` Token Savings panel: full-context baseline vs graph response, with category breakdown
- [ ] Task 3.7: `--verify` flag cross-checks the savings estimate against a real tokenizer (`gpt-tokenizer` or equivalent)

## Phase 4: Execution Flows + Deeper Graph Intelligence
- [ ] Task 4.1: `src/engines/flow-analyzer.ts` — trace call chains from entry points (routes, CLI, tests), sort by criticality
- [ ] Task 4.2: `vibeguard flows` (list) and `vibeguard flow <id>` (detail) commands
- [ ] Task 4.3: `get_affected_flows` — which flows a change touches (feeds Phase 3 review)
- [ ] Task 4.4: Bridge detection via betweenness centrality (architectural chokepoints)
- [ ] Task 4.5: Knowledge-gap analysis — isolated nodes, untested hotspots, thin communities
- [ ] Task 4.6: Upgrade community detection from connected-component to Leiden/Louvain (deterministic seed)

## Phase 5: Semantic Search (optional, local-first)
- [ ] Task 5.1: `src/engines/embeddings.ts` — embed node signatures; pluggable provider
- [ ] Task 5.2: Local default (no network); optional OpenAI-compatible / Gemini providers behind explicit opt-in + egress warning
- [ ] Task 5.3: `vibeguard search "<natural language>"` — hybrid FTS keyword + vector similarity
- [ ] Task 5.4: Identifier-aware boost (dotted / snake_case / CamelCase token extraction ×2.0)
- [ ] Task 5.5: Store embeddings in a separate SQLite DB keyed by text-hash (skip re-embed on unchanged nodes)

## Phase 6: Exports + Visualization Upgrades
- [ ] Task 6.1: `vibeguard visualize --format graphml` (Gephi / yEd)
- [ ] Task 6.2: `--format cypher` (Neo4j), `--format obsidian` (wikilink vault), `--format svg` (static)
- [ ] Task 6.3: HTML graph: collapsed-by-default for large graphs, search box, edge-type toggles, degree-scaled nodes
- [ ] Task 6.4: `vibeguard wiki` — generate markdown wiki per community
- [ ] Task 6.5: Graph diff — `vibeguard graph-diff <ref>` shows new/removed nodes, edges, community shifts over time

## Phase 7: Multi-Repo + Daemon
- [ ] Task 7.1: Repo registry (`vibeguard register`, `unregister`, `repos`) in `~/.vibeguard/registry.json`
- [ ] Task 7.2: `vibeguard cross-search "<query>"` across all registered repos
- [ ] Task 7.3: Background daemon — watch multiple repos, one watcher per repo, health-check + auto-restart
- [ ] Task 7.4: TOML config at `~/.vibeguard/watch.toml`, hot-reloaded on change

## Phase 8: Proof, Trust, and Reach
- [ ] Task 8.1: Deterministic eval pipeline — pin upstream SHAs of 5–6 real repos, fixed-seed community detection, reproducible numbers
- [ ] Task 8.2: Publish benchmark table (token reduction, impact recall/F1) in README — measured, not claimed
- [ ] Task 8.3: Expand language coverage toward 15+ (Rust, C/C++, C#, Ruby, PHP, Kotlin, Swift) — reuse polyglot-parser pattern
- [ ] Task 8.4: VS Code extension shell that talks to the MCP server (graph view + inline review)
- [ ] Task 8.5: CI hardening — coverage gate, security scan of own code (dogfood), cross-platform matrix (Win/macOS/Linux)

---

## Guiding Principles (do not break these)

1. **Zero token cost for the core.** Graph build, query, security, dead-code, health stay 100% local.
2. **Stable JSON contracts.** Every command emits one JSON doc with `schemaVersion`; bump major on breaking change.
3. **Safety first.** Mutations are opt-in, support `--dry-run`, route deletes through recoverable trash.
4. **Loaders TTY-only.** Never corrupt `--json` / CI output.
5. **The moat is non-negotiable.** Security, cyberattack, and reversible cleanup are what no competitor has — every phase must keep them first-class.

---

## Success Metrics (v2.0 "unbeatable" definition)

| Metric | Target |
|---|---|
| Token reduction (graph query vs full read) | ≥ 40x median, verified vs real tokenizer |
| Blast-radius impact recall | 100% (conservative over-prediction acceptable) |
| Incremental re-index (2k-file repo) | < 2s |
| MCP tools exposed | 15+ live tools |
| Languages | 15+ |
| Unique vs all competitors | Security + cyberattack + reversible cleanup + health (kept) |
| Test suite | Green, expanded to cover MCP server + change review + flows |
