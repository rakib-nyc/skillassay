import { load as loadYaml } from 'js-yaml';
import type { ParseOutcome } from '../types.js';

export interface Frontmatter {
  readonly raw: string;
  readonly data: Record<string, unknown>;
  readonly body: string;
  /** Number of source lines consumed by the frontmatter block, incl. delimiters. */
  readonly headerLines: number;
}

const BOM = '﻿';

/**
 * Strip a UTF-8 BOM and normalise line endings.
 *
 * Both matter: a BOM sits *before* the opening `---`, so a naive `startsWith`
 * check rejects a perfectly valid file, and CRLF files fail any regex anchored
 * on `\n`. Both were silent-skip bugs in practice, and a silently skipped skill
 * is a skill missing from the budget.
 */
export function normaliseSource(text: string): string {
  const withoutBom = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  return withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Extract YAML frontmatter delimited by `---` fences.
 *
 * Every failure path returns a distinct `code` so the report can say what is
 * actually wrong with the file instead of "could not parse".
 */
export function parseFrontmatter(source: string): ParseOutcome<Frontmatter> {
  const text = normaliseSource(source);

  if (text.trim().length === 0) {
    return { ok: false, code: 'empty_file', message: 'File is empty' };
  }

  const lines = text.split('\n');
  // Tolerate trailing whitespace on the fence, which editors add invisibly.
  if (lines[0]?.trimEnd() !== '---') {
    return {
      ok: false,
      code: 'no_frontmatter',
      message: 'File does not begin with a `---` YAML frontmatter fence',
    };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trimEnd() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return {
      ok: false,
      code: 'unterminated_frontmatter',
      message: 'Opening `---` fence has no matching closing fence',
    };
  }

  const raw = lines.slice(1, closingIndex).join('\n');
  const body = lines.slice(closingIndex + 1).join('\n');

  let loaded: unknown;
  try {
    loaded = loadYaml(raw, { json: true });
  } catch (error) {
    // js-yaml messages include a multi-line source excerpt. Keep the first line:
    // it names the problem and the position, and the excerpt is noise in a report.
    const first = String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
    return { ok: false, code: 'malformed_yaml', message: `Invalid YAML: ${first.trim()}` };
  }

  if (loaded === null || loaded === undefined) {
    return { ok: false, code: 'empty_frontmatter', message: 'Frontmatter block is empty' };
  }

  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    return {
      ok: false,
      code: 'frontmatter_not_mapping',
      message: `Frontmatter must be a YAML mapping, got ${Array.isArray(loaded) ? 'a list' : typeof loaded}`,
    };
  }

  return {
    ok: true,
    value: {
      raw,
      data: loaded as Record<string, unknown>,
      body,
      headerLines: closingIndex + 1,
    },
  };
}
