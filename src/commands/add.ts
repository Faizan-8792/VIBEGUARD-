import { resolve, relative, extname } from 'node:path';
import { access } from 'node:fs/promises';
import type { CommandContext } from '../context.js';
import { extractPdf, type PdfExtraction } from '../engines/pdf-extractor.js';
import { loadGraph } from '../engines/graph-builder.js';
import { FileStoreImpl } from '../storage/file-store.js';
import { emitJson } from '../utils/json-output.js';
import { header, keyValue, brand, statusIcon, divider } from '../utils/ui.js';
import { VibeguardError, ErrorCodes } from '../utils/errors.js';

export interface AddCommandOptions {
  file: string;
}

export interface DocumentLink {
  conceptOrRef: string;
  node: string;
}

export interface StoredDocument {
  file: string;
  title: string;
  pageCount: number;
  concepts: Array<{ term: string; weight: number }>;
  codeReferences: string[];
  links: DocumentLink[];
  addedAt: string;
}

interface DocumentsData {
  schemaVersion: string;
  documents: StoredDocument[];
}

const DOCS_SCHEMA_VERSION = '1.0.0';

export async function runAdd(ctx: CommandContext, opts: AddCommandOptions): Promise<void> {
  const { projectRoot, options } = ctx;

  const absPath = resolve(projectRoot, opts.file);
  const ext = extname(absPath).toLowerCase();

  if (ext !== '.pdf') {
    throw new VibeguardError(
      ErrorCodes.PARSE_ERROR,
      `Unsupported file type "${ext}". Currently only .pdf is supported.`,
    );
  }

  try {
    await access(absPath);
  } catch {
    throw new VibeguardError(ErrorCodes.CONFIG_NOT_FOUND, `File not found: ${opts.file}`);
  }

  if (!options.json) ctx.logger.startSpinner('Extracting PDF content...');

  let extraction: PdfExtraction;
  try {
    extraction = await extractPdf(absPath);
  } catch (err) {
    if (!options.json) ctx.logger.stopSpinner(false);
    throw new VibeguardError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Link PDF concepts/references to graph nodes
  const links = await linkToGraph(projectRoot, extraction);

  if (!options.json) ctx.logger.stopSpinner(true);

  // Persist into documents.json (append, dedup by file path)
  const store = new FileStoreImpl(projectRoot);
  const existing = (await store.read<DocumentsData>('documents.json')) ?? {
    schemaVersion: DOCS_SCHEMA_VERSION,
    documents: [],
  };

  const relPath = relative(projectRoot, absPath).replace(/\\/g, '/');
  const stored: StoredDocument = {
    file: relPath,
    title: extraction.title,
    pageCount: extraction.pageCount,
    concepts: extraction.concepts,
    codeReferences: extraction.codeReferences,
    links,
    addedAt: new Date().toISOString(),
  };

  const filtered = existing.documents.filter((d) => d.file !== relPath);
  filtered.push(stored);
  await store.write<DocumentsData>('documents.json', {
    schemaVersion: DOCS_SCHEMA_VERSION,
    documents: filtered,
  });

  if (options.json) {
    emitJson({
      file: relPath,
      title: extraction.title,
      pageCount: extraction.pageCount,
      conceptCount: extraction.concepts.length,
      concepts: extraction.concepts.slice(0, 15),
      links,
      linkedNodes: links.length,
    });
  } else {
    const output: string[] = [];
    output.push(header('Add Document', '📄'));
    output.push('');
    output.push(keyValue('File', brand.secondary(relPath)));
    output.push(keyValue('Title', brand.info(extraction.title)));
    output.push(keyValue('Pages', brand.muted(String(extraction.pageCount))));
    output.push(keyValue('Concepts', brand.info(String(extraction.concepts.length))));
    output.push(keyValue('Linked to graph', brand.success(`${links.length} nodes`)));
    output.push('');

    if (extraction.concepts.length > 0) {
      output.push(`  ${brand.primary.bold('Top concepts:')}`);
      for (const c of extraction.concepts.slice(0, 10)) {
        output.push(`    ${brand.muted('•')} ${c.term} ${brand.muted(`(×${c.weight})`)}`);
      }
      output.push('');
    }

    if (links.length > 0) {
      output.push(`  ${brand.primary.bold('Graph links:')}`);
      for (const link of links.slice(0, 10)) {
        output.push(`    ${brand.muted('→')} ${brand.secondary(link.node)} ${brand.muted(`(${link.conceptOrRef})`)}`);
      }
      output.push('');
    }

    output.push(divider());
    output.push(`  ${statusIcon('success')} ${brand.success('Saved to')} ${brand.muted('.vibeguard/documents.json')}`);
    output.push('');
    process.stdout.write(output.join('\n') + '\n');
  }
}

/**
 * Link a PDF's code references and concepts to actual graph nodes.
 * Matches by direct path reference and by concept-term appearing in a file path.
 */
async function linkToGraph(projectRoot: string, extraction: PdfExtraction): Promise<DocumentLink[]> {
  const graph = await loadGraph(projectRoot);
  if (!graph) return [];

  const links: DocumentLink[] = [];
  const seen = new Set<string>();
  const nodeKeys = Object.keys(graph.nodes);

  // 1. Direct code references → node match (exact or suffix)
  for (const ref of extraction.codeReferences) {
    const match = nodeKeys.find((k) => k === ref || k.endsWith(`/${ref}`) || k.includes(ref.replace(/\./g, '/')));
    if (match && !seen.has(match)) {
      seen.add(match);
      links.push({ conceptOrRef: ref, node: match });
    }
  }

  // 2. Concept terms → node basename match (e.g. concept "scanner" → security-scanner.ts)
  for (const concept of extraction.concepts) {
    if (links.length >= 30) break;
    const term = concept.term;
    // Skip short terms and multi-word phrases (filenames never contain spaces)
    if (term.length < 4 || term.includes(' ')) continue;
    const match = nodeKeys.find((k) => {
      const base = k.split('/').pop()?.toLowerCase() ?? '';
      return base.includes(term);
    });
    if (match && !seen.has(match)) {
      seen.add(match);
      links.push({ conceptOrRef: term, node: match });
    }
  }

  return links;
}
