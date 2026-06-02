# VibeGuard Roadmap — v2.0 (The Unbeatable Blend)

**Vision:** The unbeatable local-first code intelligence tool — a blend of Graphify's
token-reduction, code-review-graph's deep graph intelligence (blast radius, real MCP
server, flows, semantic search), and VibeGuard's unique security + safety + health moat.

**Positioning in one line:** *Graphify saves you tokens. code-review-graph reviews your
changes. VibeGuard does both — and is the only one that also finds secrets, blocks
cyberattacks, and cleans dead code reversibly — all locally, at zero token cost.*

> v1.0 (Days 1–10) and post-v1.0 hardening are shipped and removed from this file.
> Current baseline: health 93/100 (security 100, architecture 100, dead-code 92,
> context-efficiency 80), **272 tests passing**, zero dependency cycles.
>
> **Phases 1–5 are now SHIPPED ✅** (see checkboxes below). Phases 6–8 remain planned.

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

## Phase 1: Real MCP Server  ⭐ — SHIPPED ✅
*Turn VibeGuard from "instructions that tell an AI to shell out" into a live tool server.*

- [x] Task 1.1: Added `@modelcontextprotocol/sdk` + `src/mcp/server.ts` (stdio transport)
- [x] Task 1.2: Added `vibeguard serve` (alias `mcp`) command
- [x] Task 1.3: Exposed engines as MCP tools — `scan_security`, `scan_attacks`, `get_health`, `build_graph`, `query_graph`, `find_path`, `explain_node`, `get_affected`, `pack_context`, `detect_dead_code`
- [x] Task 1.4: Added `get_minimal_context` tool (ultra-compact summary, call first)
- [x] Task 1.5: Tool allowlist via `--tools a,b,c` and `VIBEGUARD_TOOLS` env
- [x] Task 1.6: `install` now writes a real, merge-safe `.mcp.json` pointing at `vibeguard serve`
- [x] Task 1.7: In-memory client/server integration tests assert valid JSON + `schemaVersion`

## Phase 2: Indexed Graph Store + FTS — SHIPPED ✅
*Pure-TypeScript indexed store + inverted-index FTS. NO native SQLite (honors Req 1.10 "no native compilation").*

- [x] Task 2.1: Chose a zero-native-build approach — pure-TS index over the JSON graph instead of `better-sqlite3`
- [x] Task 2.2: `src/engines/graph-index.ts` with O(1) keyed lookup + inverted index
- [x] Task 2.3: Layered over the existing `graph.json` (no schema migration / back-compat break)
- [x] Task 2.4: Inverted-index FTS over node path + export names
- [x] Task 2.5: camelCase/snake_case/path-aware tokenization with exact + prefix matching
- [x] Task 2.6: Deterministic scoring with basename boost; covered by unit tests

## Phase 3: Risk-Scored Change Review — SHIPPED ✅
*code-review-graph's core value prop — paired with our security scan.*

- [x] Task 3.1: `src/engines/change-detector.ts` — maps changed files → affected nodes
- [x] Task 3.2: Blast radius via reverse-edge BFS (configurable depth, default 2)
- [x] Task 3.3: Risk score = blast radius × importance × test-gap boost (0-100)
- [x] Task 3.4: `vibeguard review [--base <ref>]` — risk-ranked items + test-coverage gaps
- [x] Task 3.5: **Differentiator** — folds Security + Attack findings on changed files into the review
- [x] Task 3.6: Token Savings panel (full-context baseline vs graph response)
- [x] Task 3.7: `src/engines/token-savings.ts` estimate (verifier hook left for Phase 8)

## Phase 4: Execution Flows + Graph Intelligence — SHIPPED ✅
- [x] Task 4.1: `src/engines/flow-analyzer.ts` — traces call chains from entry points, criticality-scored
- [x] Task 4.2: `vibeguard flows` (with `--view flows|bridges|gaps`)
- [x] Task 4.3: Bridge detection (flow-betweenness over entrypoint→leaf paths)
- [x] Task 4.4: Knowledge-gap analysis — isolated nodes + untested hotspots
- [x] Task 4.5: Cycle-safe DFS tracing; covered by unit tests
- [ ] Task 4.6: Upgrade community detection to Leiden/Louvain (deferred — current connected-component is sufficient)

## Phase 5: Semantic Search (local-first) — SHIPPED ✅
- [x] Task 5.1: `src/engines/embeddings.ts` — deterministic local hashing embeddings (zero native deps, zero network)
- [x] Task 5.2: Local default; cloud providers intentionally NOT wired (left as a future opt-in)
- [x] Task 5.3: `vibeguard search "<query>"` — hybrid FTS keyword + cosine similarity
- [x] Task 5.4: Identifier-aware tokenization (dotted / snake_case / CamelCase)
- [x] Task 5.5: In-memory `SemanticIndex`; covered by unit tests

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
