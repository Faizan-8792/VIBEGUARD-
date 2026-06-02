---
name: vibeguard
description: Local-only static analysis, security scanning, dead code detection, and AI context packaging. Trigger with /vibeguard.
---
# VibeGuard Skill

Local-only TypeScript/JavaScript static analysis, security scanning, dead code detection, and AI context packaging.

## Trigger

When the user types `/vibeguard` followed by anything (a command or a task description), execute the corresponding flow.

## Core Flow: Smart Context Selection (Default)

When the user types `/vibeguard <any task or question>` (not a known command):

### Step 1: Ensure graph exists
Run: `npx vibeguard map --json --cwd {projectRoot}`
If already cached (check `.vibeguard/graph.json` timestamp), skip.

### Step 2: Select relevant files
Run: `npx vibeguard pack "<user's task>" --json --cwd {projectRoot}`

This does:
- Normalizes the task text
- Matches against file tags from the dependency graph
- Expands by import/dependent radius
- Applies token budget constraint

### Step 3: If no match (generic/casual prompt)
If `selectedFiles` is empty and the user has an LLM configured:
- VibeGuard uses AI file selection (sends only file names + tags, NOT content — very cheap ~300 tokens)
- Falls back to selecting the top 5-8 most connected/important files

### Step 4: Read selected files and use as context
Read the content of selected files. Use this as focused context to answer the user's question or implement their task.

### Step 5: Show the dependency graph
Display the connections between selected files as a visual tree showing imports and dependents.

**Key principle**: Never read the entire project blindly. Always go through the graph first. Only the most relevant 5-15 files get read — this is 80-95% fewer tokens than blind reading.

## Known Commands

### `/vibeguard scan`
Run: `npx vibeguard security --json --cwd {projectRoot}`
Present issues with severity, file, line, message, and suggested fix.

### `/vibeguard attack`
Run: `npx vibeguard attack --json --cwd {projectRoot}`
Show cyberattack vulnerabilities with recommendations.

### `/vibeguard health`
Run: `npx vibeguard doctor --json --cwd {projectRoot}`
Present health scores and suggestions.

### `/vibeguard dead`
Run: `npx vibeguard clean --plan --json --cwd {projectRoot}`
Show dead code candidates sorted by importance.

### `/vibeguard map`
Run: `npx vibeguard map --json --cwd {projectRoot}`
Show graph statistics.

### `/vibeguard fix`
Run: `npx vibeguard security --fix=gitignore --cwd {projectRoot}`
Auto-fix .gitignore issues.

### `/vibeguard attack --ai --fix`
Run: `npx vibeguard attack --ai --fix --cwd {projectRoot}`
AI-powered security scan + auto-fix.

### `/vibeguard`
Show available commands.

## How it Optimizes Token Usage

1. **Graph-first**: File relationships are pre-computed locally (no tokens used)
2. **Tag matching**: Tasks are matched to files via keyword/tag analysis (no tokens used)
3. **Radius expansion**: Related files found by following imports/dependents (no tokens used)
4. **Budget constraint**: Stops adding files when token budget is reached
5. **AI fallback only when needed**: If local matching fails, asks AI using ONLY file names (not content) — ~300 tokens
6. **Selective reading**: Only 5-15 files are read instead of the entire project

Result: 80-95% fewer tokens per query vs reading the full codebase.

## Notes
- All analysis is local — no API calls for graph/tag/importance computation
- AI is only used when: (a) tag matching returns 0 results, or (b) user explicitly requests `--ai`
- Files are cached in `.vibeguard/` — incremental rebuilds only re-process changed files
- The dependency graph visualization shows HOW files connect, helping understand code architecture
