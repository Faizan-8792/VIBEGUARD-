/**
 * Polyglot Parser — regex-based import/export extraction for Python, Go, Java, and Markdown.
 * No tree-sitter required. Works on file content strings.
 */

export type SupportedLanguage = 'python' | 'go' | 'java' | 'markdown' | 'typescript' | 'unknown';

export interface ParsedFile {
  language: SupportedLanguage;
  imports: string[];
  exports: string[];
  /** For markdown: extracted headings, links, and code references */
  references?: string[];
  /** Concepts extracted from markdown (headings) */
  concepts?: string[];
}

/**
 * Detect language from file extension.
 */
export function detectLanguage(filePath: string): SupportedLanguage {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'py':
    case 'pyw':
      return 'python';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'typescript';
    default:
      return 'unknown';
  }
}

/**
 * Parse a file's content and extract imports/exports based on detected language.
 */
export function parseFile(filePath: string, content: string): ParsedFile {
  const language = detectLanguage(filePath);

  switch (language) {
    case 'python':
      return parsePython(content);
    case 'go':
      return parseGo(content);
    case 'java':
      return parseJava(content);
    case 'markdown':
      return parseMarkdown(content, filePath);
    default:
      return { language: 'unknown', imports: [], exports: [] };
  }
}

// ─── Python Parser ──────────────────────────────────────────────────────────

function parsePython(content: string): ParsedFile {
  const imports: string[] = [];
  const exports: string[] = [];

  // import module
  // import module as alias
  const importRegex = /^import\s+([\w.]+)/gm;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // from module import name
  // from module import name1, name2
  // from .relative import name
  const fromImportRegex = /^from\s+([\w.]+)\s+import\s+(.+)/gm;
  while ((match = fromImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Exports: Python doesn't have explicit exports, but we can infer from:
  // - __all__ = ['name1', 'name2']
  const allRegex = /__all__\s*=\s*\[([^\]]*)\]/g;
  while ((match = allRegex.exec(content)) !== null) {
    const names = match[1].match(/['"]([^'"]+)['"]/g);
    if (names) {
      for (const n of names) {
        exports.push(n.replace(/['"]/g, ''));
      }
    }
  }

  // Top-level def and class (public API)
  const defRegex = /^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = defRegex.exec(content)) !== null) {
    const name = match[1];
    // Skip private (underscore-prefixed)
    if (!name.startsWith('_')) {
      exports.push(name);
    }
  }

  return { language: 'python', imports: [...new Set(imports)], exports: [...new Set(exports)] };
}

// ─── Go Parser ──────────────────────────────────────────────────────────────

function parseGo(content: string): ParsedFile {
  const imports: string[] = [];
  const exports: string[] = [];

  // Single import: import "package/path"
  const singleImportRegex = /^import\s+"([^"]+)"/gm;
  let match;
  while ((match = singleImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Block import: import ( "package1" \n "package2" )
  const blockImportRegex = /import\s*\(\s*([\s\S]*?)\)/g;
  while ((match = blockImportRegex.exec(content)) !== null) {
    const block = match[1];
    const pathRegex = /"([^"]+)"/g;
    let pathMatch;
    while ((pathMatch = pathRegex.exec(block)) !== null) {
      imports.push(pathMatch[1]);
    }
  }

  // Exports: In Go, exported symbols start with uppercase
  // func ExportedName(
  const funcRegex = /^func\s+(?:\([^)]*\)\s+)?([A-Z][A-Za-z0-9_]*)/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  // type ExportedType struct/interface
  const typeRegex = /^type\s+([A-Z][A-Za-z0-9_]*)/gm;
  while ((match = typeRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  // var/const ExportedName
  const varRegex = /^(?:var|const)\s+([A-Z][A-Za-z0-9_]*)/gm;
  while ((match = varRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  return { language: 'go', imports: [...new Set(imports)], exports: [...new Set(exports)] };
}

// ─── Java Parser ────────────────────────────────────────────────────────────

function parseJava(content: string): ParsedFile {
  const imports: string[] = [];
  const exports: string[] = [];

  // import com.example.ClassName;
  // import static com.example.ClassName.method;
  const importRegex = /^import\s+(?:static\s+)?([\w.]+);/gm;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // package declaration (useful for graph building)
  const packageRegex = /^package\s+([\w.]+);/m;
  const pkgMatch = packageRegex.exec(content);
  const packageName = pkgMatch ? pkgMatch[1] : '';

  // Public class/interface/enum declarations
  const classRegex = /^(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = classRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }

  // Public methods
  const methodRegex = /^\s+public\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>\[\],\s]+\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
  while ((match = methodRegex.exec(content)) !== null) {
    const name = match[1];
    // Skip constructors (same name as class)
    if (!exports.includes(name)) {
      exports.push(name);
    }
  }

  // If we found a package, prefix it
  if (packageName) {
    exports.unshift(`package:${packageName}`);
  }

  return { language: 'java', imports: [...new Set(imports)], exports: [...new Set(exports)] };
}

// ─── Markdown Parser ────────────────────────────────────────────────────────

function parseMarkdown(content: string, filePath: string): ParsedFile {
  const imports: string[] = []; // links to other files
  const exports: string[] = []; // headings as "exports"
  const references: string[] = [];
  const concepts: string[] = [];

  // Extract headings as concepts
  const headingRegex = /^(#{1,6})\s+(.+)/gm;
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const heading = match[2].trim();
    concepts.push(heading);
    exports.push(heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  }

  // Extract markdown links: [text](path)
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = linkRegex.exec(content)) !== null) {
    const linkTarget = match[2];
    // Only track internal file references (not URLs)
    if (!linkTarget.startsWith('http') && !linkTarget.startsWith('#') && !linkTarget.startsWith('mailto:')) {
      imports.push(linkTarget.split('#')[0]); // strip fragment
      references.push(linkTarget);
    }
  }

  // Extract code references: `filename.ext` or `path/to/file`
  const codeRefRegex = /`([a-zA-Z0-9_\-./]+\.[a-z]{1,5})`/g;
  while ((match = codeRefRegex.exec(content)) !== null) {
    const ref = match[1];
    if (ref.includes('/') || ref.match(/\.(ts|js|py|go|java|rs|rb|c|cpp|h)$/)) {
      references.push(ref);
    }
  }

  return {
    language: 'markdown',
    imports: [...new Set(imports)],
    exports: [...new Set(exports)],
    references: [...new Set(references)],
    concepts,
  };
}

// ─── Dead Code Detection Helpers ────────────────────────────────────────────

/**
 * Check if a Python file has any importers (is imported by another file).
 * Uses module name matching against known imports in the project.
 */
export function pythonModuleName(filePath: string): string {
  return filePath
    .replace(/\.py$/, '')
    .replace(/\//g, '.')
    .replace(/__init__$/, '')
    .replace(/\.$/, '');
}

/**
 * Check if a Go file's package is imported anywhere.
 */
export function goPackagePath(filePath: string): string {
  // Go imports use directory-based paths
  const parts = filePath.split('/');
  parts.pop(); // remove filename
  return parts.join('/');
}

/**
 * Check if a Java class is imported anywhere.
 */
export function javaFullyQualifiedName(filePath: string, packageName: string, className: string): string {
  return packageName ? `${packageName}.${className}` : className;
}

// ─── Import Resolution (module name → project file path) ─────────────────────

/**
 * Resolve a single file's raw imports to actual project file paths.
 * Returns only imports that resolve to files within the project (internal edges).
 * This is what makes the dependency graph actually connect for Python/Go/Java.
 *
 * @param filePath  The importing file (project-relative, forward-slashed)
 * @param rawImports The raw import strings from parseFile()
 * @param allFiles  Set of all project file paths (project-relative, forward-slashed)
 */
export function resolvePolyglotImports(
  filePath: string,
  rawImports: string[],
  allFiles: Set<string>,
): string[] {
  const language = detectLanguage(filePath);
  const resolved: string[] = [];

  for (const raw of rawImports) {
    let target: string | null = null;
    switch (language) {
      case 'python':
        target = resolvePythonImport(raw, filePath, allFiles);
        break;
      case 'go':
        target = resolveGoImport(raw, allFiles);
        break;
      case 'java':
        target = resolveJavaImport(raw, allFiles);
        break;
      case 'markdown':
        target = resolveMarkdownImport(raw, filePath, allFiles);
        break;
      default:
        target = null;
    }
    if (target && target !== filePath) {
      resolved.push(target);
    }
  }

  return [...new Set(resolved)];
}

const PY_EXTS = ['.py', '.pyw'];

function resolvePythonImport(raw: string, filePath: string, allFiles: Set<string>): string | null {
  // Relative import: leading dots indicate package level
  let modulePath: string;
  if (raw.startsWith('.')) {
    const dots = raw.match(/^\.+/)?.[0].length ?? 0;
    const rest = raw.slice(dots).replace(/\./g, '/');
    const dir = filePath.split('/').slice(0, -1);
    // Each extra dot beyond the first goes up one directory
    for (let i = 1; i < dots; i++) dir.pop();
    modulePath = [...dir, rest].filter(Boolean).join('/');
  } else {
    // Absolute (project-rooted) module: app.models -> app/models
    modulePath = raw.replace(/\./g, '/');
  }

  // Try modulePath.py, modulePath/__init__.py
  for (const ext of PY_EXTS) {
    const candidate = `${modulePath}${ext}`;
    if (allFiles.has(candidate)) return candidate;
    const initCandidate = `${modulePath}/__init__${ext}`;
    if (allFiles.has(initCandidate)) return initCandidate;
  }

  // Try matching by suffix (handles src/ prefixes): any file ending with the module path
  for (const ext of PY_EXTS) {
    const suffix = `${modulePath}${ext}`;
    for (const f of allFiles) {
      if (f.endsWith(`/${suffix}`)) return f;
    }
  }

  return null;
}

function resolveGoImport(raw: string, allFiles: Set<string>): string | null {
  // Go imports are package paths; map to a directory in the project.
  // Match the trailing path segments against project directories.
  const parts = raw.split('/');
  // Try progressively shorter suffixes of the import path
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    // Find any .go file whose directory ends with this suffix
    for (const f of allFiles) {
      if (!f.endsWith('.go')) continue;
      const dir = f.split('/').slice(0, -1).join('/');
      if (dir === suffix || dir.endsWith(`/${suffix}`)) {
        return f; // link to a representative file in that package
      }
    }
  }
  return null;
}

function resolveJavaImport(raw: string, allFiles: Set<string>): string | null {
  // import com.example.app.UserService -> .../com/example/app/UserService.java
  if (raw.endsWith('.*')) {
    // Wildcard package import — link to any file in that package dir
    const pkgPath = raw.slice(0, -2).replace(/\./g, '/');
    for (const f of allFiles) {
      if (f.endsWith('.java') && f.includes(`${pkgPath}/`)) return f;
    }
    return null;
  }

  const classPath = raw.replace(/\./g, '/');
  const candidate = `${classPath}.java`;
  if (allFiles.has(candidate)) return candidate;

  // Match by suffix (handles src/main/java/ prefixes)
  for (const f of allFiles) {
    if (f.endsWith(`/${candidate}`)) return f;
  }
  return null;
}

function resolveMarkdownImport(raw: string, filePath: string, allFiles: Set<string>): string | null {
  // Markdown links are relative file paths
  const clean = raw.replace(/^\.\//, '');
  const dir = filePath.split('/').slice(0, -1);

  // Resolve relative to the markdown file's directory
  const segments = clean.split('/');
  const resolvedParts = [...dir];
  for (const seg of segments) {
    if (seg === '..') resolvedParts.pop();
    else if (seg !== '.') resolvedParts.push(seg);
  }
  const resolvedPath = resolvedParts.join('/');

  if (allFiles.has(resolvedPath)) return resolvedPath;
  // Also try as project-root-relative
  if (allFiles.has(clean)) return clean;

  return null;
}
