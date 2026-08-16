import { parseFrontmatter } from './frontmatter.js';
import type { ParsedSkill, ParseOutcome } from '../types.js';

export interface ParseSkillOptions {
  /**
   * Name to use when the frontmatter omits one — normally the containing
   * directory. See the note in `parseSkill` for why this exists.
   */
  readonly fallbackName?: string;
}

/**
 * Parse a SKILL.md.
 *
 * `description` is required: it is the routing rule, and a skill without one
 * cannot be selected.
 *
 * `name` is required by Anthropic's spec, but corpus validation found real
 * published skills that omit it and rely on the containing directory instead —
 * 8 of 1,029 files, all under `.gemini/skills/`. Rejecting them outright
 * understated the parse rate and, worse, dropped genuinely-loaded skills out of
 * the budget and out of every pairwise comparison. So when `name` is absent we
 * fall back to the directory name and record `nameInferred`, which is the more
 * accurate model of what those harnesses actually put in the system prompt.
 */
export function parseSkill(
  source: string,
  options: ParseSkillOptions = {},
): ParseOutcome<ParsedSkill> {
  const fm = parseFrontmatter(source);
  if (!fm.ok) return fm;

  const { data, body, raw } = fm.value;

  const rawName = data['name'];
  const description = data['description'];

  let name: string;
  let nameInferred = false;

  if (typeof rawName === 'string' && rawName.trim().length > 0) {
    name = rawName.trim();
  } else if (rawName !== undefined && typeof rawName !== 'string') {
    return {
      ok: false,
      code: 'invalid_name',
      message: `Frontmatter \`name\` must be a string, got ${typeof rawName}`,
    };
  } else if (options.fallbackName !== undefined && options.fallbackName.trim().length > 0) {
    name = options.fallbackName.trim();
    nameInferred = true;
  } else {
    return {
      ok: false,
      code: 'missing_name',
      message: 'Frontmatter has no `name` key and no directory name to fall back to',
    };
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    return {
      ok: false,
      code: 'missing_description',
      message:
        description === undefined
          ? 'Frontmatter has no `description` key'
          : `Frontmatter \`description\` must be a non-empty string, got ${typeof description}`,
    };
  }

  const extraKeys = Object.keys(data).filter((k) => k !== 'name' && k !== 'description');

  return {
    ok: true,
    value: {
      name,
      nameInferred,
      description: description.trim(),
      extraKeys,
      body,
      rawFrontmatter: raw,
    },
  };
}
