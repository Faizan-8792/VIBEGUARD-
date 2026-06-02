# VibeGuard v1.0 Roadmap

Goal: Beat Graphify in usability, cost-efficiency, and feature coverage.

## Progress Tracker

### Day 1: Foundation
- [x] Interactive HTML graph visualization
- [x] npm publish readiness
- [x] `vibeguard cursor install`
- [x] `vibeguard claude install`
- [x] Build, test, push

### Day 2: Platforms + Graph Depth
- [x] `vibeguard copilot install`
- [x] `vibeguard gemini install`
- [x] `vibeguard aider install`
- [x] Semantic edges (function calls, not just imports)
- [x] Confidence scoring on edges

### Day 3: Python Support
- [x] Python import parser (regex-based, no tree-sitter needed)
- [x] Python dead code detection
- [x] Python security patterns (eval, subprocess, pickle, etc.)
- [x] Test with a real Python project
- [x] Python file tagging

### Day 4: Go Support
- [x] Go import parser
- [x] Go dead code detection
- [x] Go security patterns
- [x] Go file tagging
- [x] Test with a real Go project

### Day 5: Java Support
- [x] Java import parser
- [x] Java dead code detection
- [x] Java security patterns (SQLi, deserialization, etc.)
- [x] Java file tagging
- [x] Test with a real Java project

### Day 6: Multimodal — Docs
- [x] Markdown file parsing (extract headings, links, concepts)
- [x] Link documentation to code files via references
- [x] README/docs influence on tagging
- [x] Architecture doc extraction
- [x] Test with a project containing docs

### Day 7: Multimodal — PDF
- [x] PDF text extraction (pdf-parse)
- [x] Concept extraction from PDF content
- [x] Link PDF concepts to graph nodes
- [x] `vibeguard add <file.pdf>` command
- [x] Test with technical papers/specs

### Day 8: Graph Intelligence
- [x] Community detection (connected component clustering)
- [x] God-node identification (highest degree nodes)
- [x] Surprising connections (cross-community edges)
- [x] GRAPH_REPORT.md auto-generation
- [x] Suggested questions from graph structure

### Day 9: Query Engine
- [x] `vibeguard query "what connects X to Y?"`
- [x] `vibeguard path A B` (shortest path between nodes)
- [x] `vibeguard explain <node>` (plain-language explanation)
- [x] Query result token budgeting
- [x] Test query accuracy

### Day 10: Watch + Auto
- [x] `vibeguard watch` — file watcher with auto-rebuild
- [x] Post-commit hook auto-graph-update (code changes: instant, docs: notify)
- [x] Incremental tag/importance refresh
- [x] Performance optimization for large projects
- [x] Benchmark: compare token usage VibeGuard vs Graphify on same project

## Metrics to Beat

| Metric | Graphify | VibeGuard Target |
|--------|----------|-----------------|
| Graph build cost | ~5000-50000 tokens | 0 tokens (local) |
| Query cost | Reads compact graph | Reads compact graph |
| Security scanning | ❌ None | ✅ 18+ attack types |
| Languages | 25 | 10+ (TS, JS, Python, Go, Java, Rust...) |
| Platforms | 15+ | 10+ |
| Multimodal | PDF, images, video | PDF, docs, markdown |
| Graph output | Interactive HTML | Interactive HTML |
