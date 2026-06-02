import { readFile, writeFile, chmod, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { header, statusIcon, brand } from '../utils/ui.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';
import { emitJson } from '../utils/json-output.js';
import type { CommandContext } from '../context.js';

export interface HookCommandOptions {
  action: string;
}

// Pre-commit hook script (cross-platform sh + node for JSON parsing)
const PRE_COMMIT_HOOK = `#!/bin/sh
# VibeGuard Pre-Commit Security Hook
# Scans for secrets and vulnerabilities before each commit.
# To bypass: git commit --no-verify

# Run security scan
RESULT=$(node ./node_modules/.bin/../vibeguard/dist/cli.js security --json 2>/dev/null || npx vibeguard security --json 2>/dev/null)

if [ -z "$RESULT" ]; then
  exit 0
fi

# Check for critical/high issues using node
BLOCK=$(echo "$RESULT" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try {
    const j=JSON.parse(d);
    const c=j.counts||{};
    if((c.critical||0)>0||(c.high||0)>0){
      console.log('BLOCK:'+c.critical+':'+c.high);
    } else {
      console.log('OK');
    }
  } catch { console.log('OK'); }
});
" 2>/dev/null)

if echo "$BLOCK" | grep -q "^BLOCK:"; then
  CRITICAL=$(echo "$BLOCK" | cut -d: -f2)
  HIGH=$(echo "$BLOCK" | cut -d: -f3)
  echo ""
  echo "❌ VibeGuard: COMMIT BLOCKED"
  echo ""
  echo "   Found: $CRITICAL critical, $HIGH high severity issues"
  echo ""
  echo "   Run: npx vibeguard --scan    (to see details)"
  echo "   Fix: npx vibeguard security --fix gitignore"
  echo "        npx vibeguard security --fix env"
  echo ""
  echo "   Bypass: git commit --no-verify"
  echo ""
  exit 1
fi

echo "✅ VibeGuard: Security check passed."
exit 0
`;

// Post-commit hook script: auto-updates the dependency graph after each commit.
// Code changes rebuild instantly; doc-only changes print a notify message.
const POST_COMMIT_HOOK = `#!/bin/sh
# VibeGuard Post-Commit Graph Auto-Update
# Rebuilds the dependency graph after each commit (local, 0 tokens).
# To bypass: git commit --no-verify

CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null)

# Determine whether code files changed (vs docs only)
CODE=$(echo "$CHANGED" | grep -E '\\.(ts|tsx|js|jsx|mjs|cjs|py|pyw|go|java)$' || true)
DOCS=$(echo "$CHANGED" | grep -E '\\.(md|mdx)$' || true)

if [ -n "$CODE" ]; then
  echo "🔄 VibeGuard: code changed, rebuilding graph..."
  (node ./node_modules/vibeguard/dist/cli.js map --quiet 2>/dev/null || npx vibeguard map --quiet 2>/dev/null) &
elif [ -n "$DOCS" ]; then
  echo "📝 VibeGuard: docs changed. Run 'vibeguard map' to refresh doc links."
fi

exit 0
`;

export async function runHook(ctx: CommandContext, opts: HookCommandOptions): Promise<void> {
  const { projectRoot, options } = ctx;

  switch (opts.action) {
    case 'install':
      await installHook(projectRoot, options.json);
      break;
    case 'uninstall':
      await uninstallHook(projectRoot, options.json);
      break;
    case 'status':
      await hookStatus(projectRoot, options.json);
      break;
    case 'graph-install':
      await installPostCommitHook(projectRoot, options.json);
      break;
    case 'graph-uninstall':
      await uninstallPostCommitHook(projectRoot, options.json);
      break;
    default:
      throw new VibeguardError(
        ErrorCodes.UNKNOWN_COMMAND,
        `Unknown hook action: "${opts.action}". Valid: install, uninstall, status, graph-install, graph-uninstall`,
      );
  }
}

async function installHook(projectRoot: string, json: boolean): Promise<void> {
  const hookPath = join(projectRoot, '.git', 'hooks', 'pre-commit');

  // Check if .git exists
  try {
    await access(join(projectRoot, '.git'));
  } catch {
    throw new VibeguardError(
      ErrorCodes.GIT_UNAVAILABLE,
      'No .git directory found. Initialize a git repo first: git init',
    );
  }

  // Check if hook already exists (not ours)
  let existingHook = '';
  try {
    existingHook = await readFile(hookPath, 'utf-8');
  } catch {
    // doesn't exist — fine
  }

  if (existingHook && !existingHook.includes('VibeGuard')) {
    throw new VibeguardError(
      ErrorCodes.ALREADY_EXISTS,
      'A pre-commit hook already exists (not VibeGuard). Use --force or manually merge.',
    );
  }

  // Write the hook
  await writeFile(hookPath, PRE_COMMIT_HOOK, 'utf-8');
  try {
    await chmod(hookPath, 0o755);
  } catch {
    // Windows doesn't need chmod
  }

  if (json) {
    emitJson({ installed: true, path: hookPath, type: 'pre-commit' });
  } else {
    const out: string[] = [];
    out.push(header('Git Hook Installed', '🪝'));
    out.push('');
    out.push(`  ${statusIcon('success')} ${brand.success('Pre-commit hook installed!')}`);
    out.push('');
    out.push(`  ${brand.muted('What happens now:')}`);
    out.push(`    ${brand.secondary('•')} Every ${brand.info('git commit')} will run a security scan`);
    out.push(`    ${brand.secondary('•')} Commits are ${brand.danger('blocked')} if critical/high issues found`);
    out.push(`    ${brand.secondary('•')} Bypass with: ${brand.muted('git commit --no-verify')}`);
    out.push('');
    out.push(`  ${brand.muted('Manage:')}`);
    out.push(`    ${brand.secondary('vibeguard hook status')}      ${brand.muted('Check if active')}`);
    out.push(`    ${brand.secondary('vibeguard hook uninstall')}   ${brand.muted('Remove the hook')}`);
    out.push('');
    process.stdout.write(out.join('\n') + '\n');
  }
}

async function uninstallHook(projectRoot: string, json: boolean): Promise<void> {
  const hookPath = join(projectRoot, '.git', 'hooks', 'pre-commit');

  try {
    const content = await readFile(hookPath, 'utf-8');
    if (!content.includes('VibeGuard')) {
      throw new VibeguardError(
        ErrorCodes.CONFIG_NOT_FOUND,
        'Pre-commit hook exists but is not a VibeGuard hook. Not removing.',
      );
    }
    await rm(hookPath);
  } catch (err) {
    if (err instanceof VibeguardError) throw err;
    // Hook doesn't exist
  }

  if (json) {
    emitJson({ uninstalled: true, type: 'pre-commit' });
  } else {
    process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('Pre-commit hook removed.')}\n\n`);
  }
}

async function hookStatus(projectRoot: string, json: boolean): Promise<void> {
  const hookPath = join(projectRoot, '.git', 'hooks', 'pre-commit');

  let installed = false;
  try {
    const content = await readFile(hookPath, 'utf-8');
    installed = content.includes('VibeGuard');
  } catch {
    // doesn't exist
  }

  if (json) {
    emitJson({ installed, type: 'pre-commit' });
  } else {
    if (installed) {
      process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('VibeGuard pre-commit hook is active.')}\n\n`);
    } else {
      process.stdout.write(`\n  ${statusIcon('info')} ${brand.muted('No VibeGuard hook installed.')} ${brand.secondary('Run: vibeguard hook install')}\n\n`);
    }
  }
}

async function installPostCommitHook(projectRoot: string, json: boolean): Promise<void> {
  const hookPath = join(projectRoot, '.git', 'hooks', 'post-commit');

  try {
    await access(join(projectRoot, '.git'));
  } catch {
    throw new VibeguardError(
      ErrorCodes.GIT_UNAVAILABLE,
      'No .git directory found. Initialize a git repo first: git init',
    );
  }

  let existingHook = '';
  try {
    existingHook = await readFile(hookPath, 'utf-8');
  } catch {
    // doesn't exist — fine
  }

  if (existingHook && !existingHook.includes('VibeGuard')) {
    throw new VibeguardError(
      ErrorCodes.ALREADY_EXISTS,
      'A post-commit hook already exists (not VibeGuard). Manually merge or remove it first.',
    );
  }

  await writeFile(hookPath, POST_COMMIT_HOOK, 'utf-8');
  try {
    await chmod(hookPath, 0o755);
  } catch {
    // Windows doesn't need chmod
  }

  if (json) {
    emitJson({ installed: true, path: hookPath, type: 'post-commit' });
  } else {
    const out: string[] = [];
    out.push(header('Graph Auto-Update Hook', '🪝'));
    out.push('');
    out.push(`  ${statusIcon('success')} ${brand.success('Post-commit hook installed!')}`);
    out.push('');
    out.push(`  ${brand.muted('What happens now:')}`);
    out.push(`    ${brand.secondary('•')} After each commit, code changes ${brand.info('rebuild the graph instantly')}`);
    out.push(`    ${brand.secondary('•')} Doc-only changes print a ${brand.info('notify')} message`);
    out.push(`    ${brand.secondary('•')} Runs locally — ${brand.success('0 tokens')}`);
    out.push('');
    process.stdout.write(out.join('\n') + '\n');
  }
}

async function uninstallPostCommitHook(projectRoot: string, json: boolean): Promise<void> {
  const hookPath = join(projectRoot, '.git', 'hooks', 'post-commit');

  try {
    const content = await readFile(hookPath, 'utf-8');
    if (!content.includes('VibeGuard')) {
      throw new VibeguardError(
        ErrorCodes.CONFIG_NOT_FOUND,
        'Post-commit hook exists but is not a VibeGuard hook. Not removing.',
      );
    }
    await rm(hookPath);
  } catch (err) {
    if (err instanceof VibeguardError) throw err;
    // Hook doesn't exist
  }

  if (json) {
    emitJson({ uninstalled: true, type: 'post-commit' });
  } else {
    process.stdout.write(`\n  ${statusIcon('success')} ${brand.success('Post-commit graph hook removed.')}\n\n`);
  }
}
