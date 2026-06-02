import { readdir, stat, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import picomatch from 'picomatch';

export async function resolveFiles(
  projectRoot: string,
  include: string[],
  skipSet: string[]
): Promise<string[]> {
  const isIncluded = picomatch(include);
  const isSkipped = picomatch(skipSet);
  const results: string[] = [];
  const rootResolved = resolve(projectRoot);

  await walkDir(rootResolved, rootResolved, isIncluded, isSkipped, results);

  results.sort();
  return results;
}

async function walkDir(
  dir: string,
  rootResolved: string,
  isIncluded: picomatch.Matcher,
  isSkipped: picomatch.Matcher,
  results: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const rel = relative(rootResolved, fullPath).replace(/\\/g, '/');

    // Skip if matches skip set
    if (isSkipped(rel)) continue;

    if (entry.isSymbolicLink()) {
      // Check if symlink points outside project root
      try {
        const target = await realpath(fullPath);
        if (!target.startsWith(rootResolved)) continue;
      } catch {
        continue;
      }
    }

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const dirStat = await stat(fullPath).catch(() => null);
      if (dirStat?.isDirectory()) {
        await walkDir(fullPath, rootResolved, isIncluded, isSkipped, results);
      }
    } else if (entry.isFile()) {
      if (isIncluded(rel)) {
        results.push(rel);
      }
    }
  }
}
