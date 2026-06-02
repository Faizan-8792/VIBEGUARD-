/**
 * Polyglot parser for Python, Go, Java, and Markdown.
 *
 * This intentionally avoids native parsers so the CLI remains portable, but it
 * still extracts language-aware imports, public API symbols, declared symbols,
 * packages, and cross-file symbol uses for semantic graph edges.
 */

export type SupportedLanguage = 'python' | 'go' | 'java' | 'markdown' | 'typescript' | 'unknown';
export type ImportBindingKind = 'module' | 'named' | 'wildcard' | 'static' | 'side-effect';
export type SymbolUseKind = 'call' | 'type-reference' | 'reference';
export type DeclaredSymbolKind =
  | 'function'
  | 'class'
  | 'type'
  | 'method'
  | 'field'
  | 'constant'
  | 'package'
  | 'heading';

export interface ImportBinding {
  /** Raw module/package path from the language import statement. */
  module: string;
  /** Imported symbol name when the language exposes one. */
  imported?: string;
  /** Local name that appears in code after aliasing. */
  local: string;
  kind: ImportBindingKind;
}

export interface SymbolUse {
  /** Full symbol as seen in code, e.g. UserService or auth.Login. */
  symbol: string;
  kind: SymbolUseKind;
  qualifier?: string;
  member?: string;
}

export interface DeclaredSymbol {
  name: string;
  kind: DeclaredSymbolKind;
  exported: boolean;
}

export interface ParsedFile {
  language: SupportedLanguage;
  imports: string[];
  exports: string[];
  /** Language/package namespace when available. */
  packageName?: string;
  /** Rich import bindings for semantic edge extraction. */
  importBindings?: ImportBinding[];
  /** All top-level symbols, including package-private/unexported symbols. */
  declaredSymbols?: DeclaredSymbol[];
  /** Cross-file symbol-use candidates. */
  symbolUses?: SymbolUse[];
  /** For markdown: extracted links and code references. */
  references?: string[];
  /** Concepts extracted from markdown headings. */
  concepts?: string[];
}

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
      return parseMarkdown(content);
    default:
      return { language: 'unknown', imports: [], exports: [] };
  }
}

// ─── Python ────────────────────────────────────────────────────────────────

function parsePython(content: string): ParsedFile {
  const imports: string[] = [];
  const exports: string[] = [];
  const importBindings: ImportBinding[] = [];
  const declaredSymbols: DeclaredSymbol[] = [];
  const explicitAllExports = new Set<string>();

  let match: RegExpExecArray | null;

  const allRegex = /__all__\s*=\s*(?:\[(?<list>[\s\S]*?)\]|\((?<tuple>[\s\S]*?)\))/g;
  while ((match = allRegex.exec(content)) !== null) {
    const rawNames = match.groups?.['list'] ?? match.groups?.['tuple'] ?? '';
    for (const name of extractQuotedValues(rawNames)) {
      explicitAllExports.add(name);
      exports.push(name);
    }
  }

  const fromBlockRegex = /^from\s+([.\w]+)\s+import\s*\(([\s\S]*?)\)/gm;
  const consumedRanges: Array<[number, number]> = [];
  while ((match = fromBlockRegex.exec(content)) !== null) {
    consumedRanges.push([match.index, match.index + match[0].length]);
    processPythonFromImport(match[1], match[2], imports, importBindings);
  }

  const fromLineRegex = /^from\s+([.\w]+)\s+import\s+([^\n]+)/gm;
  while ((match = fromLineRegex.exec(content)) !== null) {
    if (isInsideRanges(match.index, consumedRanges)) continue;
    processPythonFromImport(match[1], match[2], imports, importBindings);
  }

  const importRegex = /^import\s+([^\n]+)/gm;
  while ((match = importRegex.exec(content)) !== null) {
    for (const importSpec of splitCommaList(match[1])) {
      const parsed = parseAlias(importSpec);
      if (!parsed.name) continue;
      const local = parsed.alias ?? parsed.name.split('.')[0];
      imports.push(parsed.name);
      importBindings.push({ module: parsed.name, imported: '*', local, kind: 'module' });
    }
  }

  const declarationRegex = /^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = declarationRegex.exec(content)) !== null) {
    const keyword = match[0].trim().startsWith('class') ? 'class' : 'function';
    const name = match[1];
    const exported = explicitAllExports.has(name) || !name.startsWith('_');
    declaredSymbols.push({ name, kind: keyword, exported });
    if (exported) exports.push(name);
  }

  const constantRegex = /^([A-Z][A-Z0-9_]*)\s*=/gm;
  while ((match = constantRegex.exec(content)) !== null) {
    const name = match[1];
    declaredSymbols.push({ name, kind: 'constant', exported: true });
    exports.push(name);
  }

  const searchable = stripPythonNoise(content);
  const symbolUses = extractGenericSymbolUses(searchable, {
    includeDottedCalls: true,
    typeIdentifier: /^[A-Z][A-Za-z0-9_]*$/,
  });

  return {
    language: 'python',
    imports: unique(imports),
    exports: unique(exports),
    importBindings: uniqueBindings(importBindings),
    declaredSymbols: uniqueDeclaredSymbols(declaredSymbols),
    symbolUses,
  };
}

function processPythonFromImport(
  moduleName: string,
  importedPart: string,
  imports: string[],
  importBindings: ImportBinding[],
): void {
  imports.push(moduleName);

  for (const importSpec of splitCommaList(importedPart.replace(/[()]/g, ''))) {
    const parsed = parseAlias(importSpec);
    if (!parsed.name) continue;

    if (parsed.name === '*') {
      importBindings.push({ module: moduleName, imported: '*', local: '*', kind: 'wildcard' });
      continue;
    }

    const local = parsed.alias ?? parsed.name;
    importBindings.push({ module: moduleName, imported: parsed.name, local, kind: 'named' });
    imports.push(combinePythonModuleAndSymbol(moduleName, parsed.name));
  }
}

function combinePythonModuleAndSymbol(moduleName: string, importedName: string): string {
  if (moduleName === '.') return `.${importedName}`;
  if (moduleName.endsWith('.')) return `${moduleName}${importedName}`;
  return `${moduleName}.${importedName}`;
}

// ─── Go ────────────────────────────────────────────────────────────────────

function parseGo(content: string): ParsedFile {
  const imports: string[] = [];
  const exports: string[] = [];
  const importBindings: ImportBinding[] = [];
  const declaredSymbols: DeclaredSymbol[] = [];

  const packageMatch = /^package\s+([A-Za-z_][A-Za-z0-9_]*)/m.exec(content);
  const packageName = packageMatch?.[1];
  if (packageName) {
    exports.push(`package:${packageName}`);
    declaredSymbols.push({ name: `package:${packageName}`, kind: 'package', exported: true });
  }

  let match: RegExpExecArray | null;
  const blockImportRegex = /import\s*\(([\s\S]*?)\)/g;
  const consumedRanges: Array<[number, number]> = [];
  while ((match = blockImportRegex.exec(content)) !== null) {
    consumedRanges.push([match.index, match.index + match[0].length]);
    for (const line of match[1].split('\n')) {
      processGoImportSpec(line, imports, importBindings);
    }
  }

  const singleImportRegex = /^import\s+(.+)$/gm;
  while ((match = singleImportRegex.exec(content)) !== null) {
    if (isInsideRanges(match.index, consumedRanges)) continue;
    processGoImportSpec(match[1], imports, importBindings);
  }

  const searchable = stripGoNoise(content);
  const functionRegex = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  while ((match = functionRegex.exec(searchable)) !== null) {
    addGoSymbol(match[1], 'function', exports, declaredSymbols);
  }

  const typeRegex = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  while ((match = typeRegex.exec(searchable)) !== null) {
    addGoSymbol(match[1], 'type', exports, declaredSymbols);
  }

  const constVarLineRegex = /^(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;
  while ((match = constVarLineRegex.exec(searchable)) !== null) {
    addGoSymbol(match[1], 'field', exports, declaredSymbols);
  }

  const constVarBlockRegex = /^(?:var|const)\s*\(([\s\S]*?)\)/gm;
  while ((match = constVarBlockRegex.exec(searchable)) !== null) {
    const block = match[1];
    const blockNameRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\b/gm;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = blockNameRegex.exec(block)) !== null) {
      addGoSymbol(blockMatch[1], 'field', exports, declaredSymbols);
    }
  }

  const symbolUses = extractGenericSymbolUses(searchable, {
    includeDottedCalls: true,
    typeIdentifier: /^[A-Z][A-Za-z0-9_]*$/,
  });

  return {
    language: 'go',
    imports: unique(imports),
    exports: unique(exports),
    packageName,
    importBindings: uniqueBindings(importBindings),
    declaredSymbols: uniqueDeclaredSymbols(declaredSymbols),
    symbolUses,
  };
}

function processGoImportSpec(
  spec: string,
  imports: string[],
  importBindings: ImportBinding[],
): void {
  const cleaned = spec.replace(/\/\/.*$/, '').trim();
  const match = /^(?:(?<alias>[A-Za-z_][A-Za-z0-9_]*|\.|_)\s+)?["'](?<path>[^"']+)["']/.exec(cleaned);
  if (!match?.groups) return;

  const importPath = match.groups['path'];
  const alias = match.groups['alias'];
  const local = alias && alias !== '_' && alias !== '.'
    ? alias
    : goDefaultImportName(importPath);

  imports.push(importPath);
  importBindings.push({
    module: importPath,
    imported: '*',
    local,
    kind: alias === '_' ? 'side-effect' : 'module',
  });
}

function addGoSymbol(
  name: string,
  kind: DeclaredSymbolKind,
  exports: string[],
  declaredSymbols: DeclaredSymbol[],
): void {
  const exported = /^[A-Z]/.test(name);
  declaredSymbols.push({ name, kind, exported });
  if (exported) exports.push(name);
}

function goDefaultImportName(importPath: string): string {
  return importPath.split('/').filter(Boolean).pop()?.replace(/[^A-Za-z0-9_]/g, '') || importPath;
}

// ─── Java ──────────────────────────────────────────────────────────────────

function parseJava(content: string): ParsedFile {
  const imports: string[] = [];
  const exports: string[] = [];
  const importBindings: ImportBinding[] = [];
  const declaredSymbols: DeclaredSymbol[] = [];

  const packageMatch = /^package\s+([\w.]+);/m.exec(content);
  const packageName = packageMatch?.[1];
  if (packageName) {
    exports.push(`package:${packageName}`);
    declaredSymbols.push({ name: `package:${packageName}`, kind: 'package', exported: true });
  }

  let match: RegExpExecArray | null;
  const importRegex = /^import\s+(static\s+)?([\w.]+(?:\.\*)?);/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const isStatic = Boolean(match[1]);
    const importPath = match[2];
    imports.push(importPath);

    if (importPath.endsWith('.*')) {
      importBindings.push({ module: importPath, imported: '*', local: '*', kind: 'wildcard' });
      continue;
    }

    const parts = importPath.split('.');
    const imported = parts[parts.length - 1];
    importBindings.push({
      module: importPath,
      imported,
      local: imported,
      kind: isStatic ? 'static' : 'named',
    });
  }

  const searchable = stripJavaNoise(content);

  const typeRegex = /^(?:\s*(?:public|protected|private|abstract|final|sealed|non-sealed|static)\s+)*\s*(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  while ((match = typeRegex.exec(searchable)) !== null) {
    const exported = !/\bprivate\b/.test(match[0]);
    const name = match[2];
    declaredSymbols.push({ name, kind: 'class', exported });
    if (exported) exports.push(name);
  }

  const methodRegex = /^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>\[\],.? extends super\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  while ((match = methodRegex.exec(searchable)) !== null) {
    const name = match[1];
    if (!exports.includes(name)) exports.push(name);
    declaredSymbols.push({ name, kind: 'method', exported: true });
  }

  const fieldRegex = /^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],.? extends super\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)/gm;
  while ((match = fieldRegex.exec(searchable)) !== null) {
    const name = match[1];
    exports.push(name);
    declaredSymbols.push({ name, kind: 'field', exported: true });
  }

  const symbolUses = extractGenericSymbolUses(searchable, {
    includeDottedCalls: true,
    typeIdentifier: /^[A-Z][A-Za-z0-9_]*$/,
  });

  const newExpressionRegex = /\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
  while ((match = newExpressionRegex.exec(searchable)) !== null) {
    symbolUses.push({ symbol: match[1], kind: 'type-reference' });
  }

  return {
    language: 'java',
    imports: unique(imports),
    exports: unique(exports),
    packageName,
    importBindings: uniqueBindings(importBindings),
    declaredSymbols: uniqueDeclaredSymbols(declaredSymbols),
    symbolUses: uniqueSymbolUses(symbolUses),
  };
}

// ─── Markdown ──────────────────────────────────────────────────────────────

function parseMarkdown(content: string): ParsedFile {
  const imports: string[] = [];
  const exports: string[] = [];
  const references: string[] = [];
  const concepts: string[] = [];
  const declaredSymbols: DeclaredSymbol[] = [];
  const symbolUses: SymbolUse[] = [];

  let match: RegExpExecArray | null;
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  while ((match = headingRegex.exec(content)) !== null) {
    const heading = stripMarkdownInlineSyntax(match[2].trim());
    if (!heading) continue;
    const slug = slugifyHeading(heading);
    concepts.push(heading);
    exports.push(slug);
    declaredSymbols.push({ name: slug, kind: 'heading', exported: true });
  }

  const markdownLinkRegex = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    addMarkdownReference(match[2], imports, references, symbolUses);
  }

  const wikiLinkRegex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    addMarkdownReference(match[1], imports, references, symbolUses);
  }

  const inlineCodeRegex = /`([^`]+)`/g;
  while ((match = inlineCodeRegex.exec(content)) !== null) {
    addMarkdownReference(match[1], imports, references, symbolUses);
  }

  const pathReferenceRegex = /(^|[\s(["'])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyw|go|java|md|mdx))(?=$|[\s)"',.;:!?])/g;
  while ((match = pathReferenceRegex.exec(content)) !== null) {
    addMarkdownReference(match[2], imports, references, symbolUses);
  }

  return {
    language: 'markdown',
    imports: unique(imports),
    exports: unique(exports),
    declaredSymbols: uniqueDeclaredSymbols(declaredSymbols),
    symbolUses: uniqueSymbolUses(symbolUses),
    references: unique(references),
    concepts: unique(concepts),
  };
}

function addMarkdownReference(
  rawReference: string,
  imports: string[],
  references: string[],
  symbolUses: SymbolUse[],
): void {
  const normalized = normalizeMarkdownTarget(rawReference);
  if (!normalized || isExternalMarkdownTarget(normalized)) return;
  imports.push(normalized);
  references.push(normalized);
  symbolUses.push({ symbol: normalized, kind: 'reference' });
}

// ─── Dead Code Detection Helpers ───────────────────────────────────────────

export function pythonModuleName(filePath: string): string {
  return filePath
    .replace(/\.pyw?$/, '')
    .replace(/\//g, '.')
    .replace(/__init__$/, '')
    .replace(/\.$/, '');
}

export function goPackagePath(filePath: string): string {
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/');
}

export function javaFullyQualifiedName(filePath: string, packageName: string, className: string): string {
  return packageName ? `${packageName}.${className}` : className;
}

// ─── Import Resolution ─────────────────────────────────────────────────────

export function resolvePolyglotImports(
  filePath: string,
  rawImports: string[],
  allFiles: Set<string>,
): string[] {
  const language = detectLanguage(filePath);
  const resolved: string[] = [];

  for (const rawImport of rawImports) {
    let targets: string[] = [];
    switch (language) {
      case 'python':
        targets = resolvePythonImport(rawImport, filePath, allFiles);
        break;
      case 'go':
        targets = resolveGoImport(rawImport, allFiles);
        break;
      case 'java':
        targets = resolveJavaImport(rawImport, filePath, allFiles);
        break;
      case 'markdown':
        targets = resolveMarkdownImport(rawImport, filePath, allFiles);
        break;
      default:
        targets = [];
    }

    for (const target of targets) {
      if (target && target !== filePath) resolved.push(target);
    }
  }

  return unique(resolved);
}

const PY_EXTS = ['.py', '.pyw'];

function resolvePythonImport(raw: string, filePath: string, allFiles: Set<string>): string[] {
  const modulePath = pythonModuleToPath(raw, filePath);
  const candidates: string[] = [];

  for (const extension of PY_EXTS) {
    candidates.push(`${modulePath}${extension}`);
    candidates.push(`${modulePath}/__init__${extension}`);
  }

  const direct = candidates.find((candidate) => allFiles.has(candidate));
  if (direct) return [direct];

  const suffixMatches: string[] = [];
  for (const extension of PY_EXTS) {
    const suffix = `${modulePath}${extension}`;
    for (const file of allFiles) {
      if (file.endsWith(`/${suffix}`)) suffixMatches.push(file);
    }
  }

  return unique(suffixMatches);
}

function pythonModuleToPath(raw: string, filePath: string): string {
  if (!raw.startsWith('.')) return raw.replace(/\./g, '/');

  const dotCount = raw.match(/^\.+/)?.[0].length ?? 0;
  const rest = raw.slice(dotCount).replace(/\./g, '/');
  const directoryParts = filePath.split('/').slice(0, -1);
  for (let index = 1; index < dotCount; index++) {
    directoryParts.pop();
  }
  return [...directoryParts, rest].filter(Boolean).join('/');
}

function resolveGoImport(raw: string, allFiles: Set<string>): string[] {
  const importParts = raw.split('/').filter(Boolean);
  const matches: string[] = [];

  for (let startIndex = 0; startIndex < importParts.length; startIndex++) {
    const suffix = importParts.slice(startIndex).join('/');
    for (const file of allFiles) {
      if (!file.endsWith('.go')) continue;
      const directory = file.split('/').slice(0, -1).join('/');
      if (directory === suffix || directory.endsWith(`/${suffix}`)) {
        matches.push(file);
      }
    }
    if (matches.length > 0) break;
  }

  return unique(matches);
}

function resolveJavaImport(raw: string, filePath: string, allFiles: Set<string>): string[] {
  if (raw.endsWith('.*')) {
    const packagePath = raw.slice(0, -2).replace(/\./g, '/');
    return [...allFiles].filter((file) =>
      file.endsWith('.java') && javaFilePackagePath(file).endsWith(packagePath)
    );
  }

  const classPath = raw.replace(/\./g, '/');
  const exact = findJavaClassPath(classPath, allFiles);
  if (exact) return [exact];

  // Static member imports point at a class plus a member; drop the member.
  const ownerClassPath = raw.split('.').slice(0, -1).join('/').replace(/\./g, '/');
  const owner = findJavaClassPath(ownerClassPath, allFiles);
  if (owner) return [owner];

  // Same-package references sometimes appear in synthetic import lists.
  const packageName = javaPackageNameFromFilePath(filePath, allFiles);
  if (packageName) {
    const localClass = raw.split('.').pop() ?? raw;
    const samePackage = findJavaClassPath(`${packageName.replace(/\./g, '/')}/${localClass}`, allFiles);
    if (samePackage) return [samePackage];
  }

  return [];
}

function findJavaClassPath(classPath: string, allFiles: Set<string>): string | null {
  const candidate = `${classPath}.java`;
  if (allFiles.has(candidate)) return candidate;

  for (const file of allFiles) {
    if (file.endsWith(`/${candidate}`)) return file;
  }
  return null;
}

function resolveMarkdownImport(raw: string, filePath: string, allFiles: Set<string>): string[] {
  const cleanTarget = normalizeMarkdownTarget(raw);
  if (!cleanTarget || isExternalMarkdownTarget(cleanTarget)) return [];

  const directory = filePath.split('/').slice(0, -1);
  const candidates = markdownCandidatePaths(cleanTarget, directory);

  for (const candidate of candidates) {
    if (allFiles.has(candidate)) return [candidate];
  }

  return [];
}

function markdownCandidatePaths(raw: string, currentDirectoryParts: string[]): string[] {
  const normalizedRaw = normalizePathSegments(raw.split('/'));
  const relativePath = normalizePathSegments([...currentDirectoryParts, ...raw.split('/')]);
  const candidates = [relativePath, normalizedRaw];
  const expanded: string[] = [];

  for (const candidate of candidates) {
    expanded.push(candidate);
    if (!/\.[A-Za-z0-9]+$/.test(candidate)) {
      expanded.push(`${candidate}.md`);
      expanded.push(`${candidate}.mdx`);
      expanded.push(`${candidate}/README.md`);
      expanded.push(`${candidate}/index.md`);
    }
  }

  return unique(expanded.filter(Boolean));
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseAlias(spec: string): { name: string; alias?: string } {
  const cleaned = spec.trim().replace(/#.*$/, '').trim();
  const aliasMatch = /^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(cleaned);
  if (aliasMatch) {
    return { name: aliasMatch[1].trim(), alias: aliasMatch[2] };
  }
  return { name: cleaned };
}

function extractQuotedValues(value: string): string[] {
  const names: string[] = [];
  const quotedRegex = /['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(value)) !== null) {
    names.push(match[1]);
  }
  return names;
}

function extractGenericSymbolUses(
  content: string,
  options: { includeDottedCalls: boolean; typeIdentifier: RegExp },
): SymbolUse[] {
  const uses: SymbolUse[] = [];
  let match: RegExpExecArray | null;

  const callRegex = options.includeDottedCalls
    ? /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g
    : /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  while ((match = callRegex.exec(content)) !== null) {
    const symbol = match[1];
    if (isLanguageKeyword(symbol)) continue;
    const parts = symbol.split('.');
    uses.push({
      symbol,
      kind: 'call',
      qualifier: parts.length > 1 ? parts.slice(0, -1).join('.') : undefined,
      member: parts.length > 1 ? parts[parts.length - 1] : undefined,
    });
  }

  const identifierRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  while ((match = identifierRegex.exec(content)) !== null) {
    const symbol = match[0];
    if (isLanguageKeyword(symbol)) continue;
    if (options.typeIdentifier.test(symbol)) {
      uses.push({ symbol, kind: 'type-reference' });
    }
  }

  return uniqueSymbolUses(uses);
}

function stripPythonNoise(content: string): string {
  return content
    .replace(/("""|''')[\s\S]*?\1/g, ' ')
    .replace(/(['"])(?:\\.|(?!\1).)*\1/g, ' ')
    .replace(/#.*$/gm, ' ');
}

function stripGoNoise(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`[\s\S]*?`/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

function stripJavaNoise(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ');
}

function normalizeMarkdownTarget(raw: string): string {
  const withoutTitle = raw.trim().split(/\s+["'][^"']*["']\s*$/)[0].trim();
  const withoutFragment = withoutTitle.split('#')[0].split('?')[0].trim();
  try {
    return decodeURIComponent(withoutFragment).replace(/\\/g, '/');
  } catch {
    return withoutFragment.replace(/\\/g, '/');
  }
}

function isExternalMarkdownTarget(target: string): boolean {
  return /^(?:https?:|mailto:|tel:|data:|#)/i.test(target) || target === '';
}

function stripMarkdownInlineSyntax(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim();
}

function slugifyHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizePathSegments(parts: string[]): string {
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized.join('/');
}

function javaFilePackagePath(filePath: string): string {
  return filePath.split('/').slice(0, -1).join('/');
}

function javaPackageNameFromFilePath(filePath: string, allFiles: Set<string>): string | null {
  const className = filePath.split('/').pop()?.replace(/\.java$/, '');
  if (!className) return null;

  for (const file of allFiles) {
    if (file === filePath) {
      const parts = file.split('/');
      const javaIndex = parts.lastIndexOf('java');
      if (javaIndex !== -1 && javaIndex < parts.length - 2) {
        return parts.slice(javaIndex + 1, -1).join('.');
      }
    }
  }
  return null;
}

function isInsideRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function isLanguageKeyword(symbol: string): boolean {
  return new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'def', 'defer', 'default', 'do', 'else', 'enum', 'extends', 'false',
    'final', 'finally', 'for', 'func', 'if', 'implements', 'import', 'interface', 'new',
    'nil', 'null', 'package', 'private', 'protected', 'public', 'return', 'static',
    'struct', 'switch', 'this', 'throw', 'throws', 'true', 'try', 'type', 'var', 'void',
    'while', 'yield',
  ]).has(symbol);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function uniqueBindings(bindings: ImportBinding[]): ImportBinding[] {
  const seen = new Set<string>();
  const uniqueValues: ImportBinding[] = [];
  for (const binding of bindings) {
    const key = `${binding.kind}:${binding.module}:${binding.imported ?? ''}:${binding.local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueValues.push(binding);
  }
  return uniqueValues;
}

function uniqueDeclaredSymbols(symbols: DeclaredSymbol[]): DeclaredSymbol[] {
  const seen = new Set<string>();
  const uniqueValues: DeclaredSymbol[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.kind}:${symbol.name}:${symbol.exported}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueValues.push(symbol);
  }
  return uniqueValues;
}

function uniqueSymbolUses(uses: SymbolUse[]): SymbolUse[] {
  const seen = new Set<string>();
  const uniqueValues: SymbolUse[] = [];
  for (const use of uses) {
    const key = `${use.kind}:${use.symbol}:${use.qualifier ?? ''}:${use.member ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueValues.push(use);
  }
  return uniqueValues;
}
