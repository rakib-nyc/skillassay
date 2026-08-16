import path from 'node:path';
import type { Finding, SkillRecord } from '../types.js';

/**
 * Conformance to the Agent Skills specification.
 *
 * Every other rule in this analyzer answers "is this skill costly, redundant or
 * ambiguous?". These answer something more basic and more urgent: **will this
 * skill load at all?**
 *
 * The specification states hard constraints on `name` and `description`. A skill
 * that breaks them is not merely suboptimal — no compliant client will register
 * it, so the author's work is invisible and the failure is silent. That makes
 * these the highest-confidence findings the tool produces: unlike a judgement
 * about redundancy, "this name contains an uppercase letter" is decidable.
 *
 * Source: https://agentskills.io/specification
 */

/** Maximum `name` length, from the specification. */
const NAME_MAX = 64;
/** Maximum `description` length, from the specification. */
const DESCRIPTION_MAX = 1024;
/** Recommended `SKILL.md` body ceilings, from the specification. */
const BODY_MAX_TOKENS = 5000;
const BODY_MAX_LINES = 500;

/**
 * The full legal-name test, spelled out rather than compressed into one regex,
 * so a violation can say precisely which clause failed.
 */
export interface NameViolation {
  readonly clause: string;
  readonly detail: string;
}

export function checkName(name: string): NameViolation | null {
  if (name.length === 0) {
    return { clause: 'must be 1-64 characters', detail: 'name is empty' };
  }
  if (name.length > NAME_MAX) {
    return {
      clause: `must be 1-${NAME_MAX} characters`,
      detail: `name is ${name.length} characters`,
    };
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    return {
      clause: 'must not start or end with a hyphen',
      detail: `name is "${name}"`,
    };
  }
  if (name.includes('--')) {
    return {
      clause: 'must not contain consecutive hyphens',
      detail: `name is "${name}"`,
    };
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    const offending = [...new Set([...name].filter((c) => !/[a-z0-9-]/.test(c)))];
    return {
      clause: 'may only contain lowercase letters, digits and hyphens',
      detail: `name contains ${offending.map((c) => `"${c}"`).join(', ')}`,
    };
  }
  return null;
}

const SPEC_URL = 'https://agentskills.io/specification';

export function analyzeSpecConformance(skills: readonly SkillRecord[]): Finding[] {
  const findings: Finding[] = [];

  for (const record of skills) {
    const { skill, artifact } = record;
    const location = { path: artifact.relPath };

    // --- name format -------------------------------------------------------
    const violation = checkName(skill.name);
    if (violation) {
      findings.push({
        ruleId: 'SPEC-NAME-INVALID',
        severity: 'error',
        locations: [location],
        summary: `Skill name "${truncate(skill.name, 40)}" is invalid: ${violation.clause}`,
        evidence: {
          name: truncate(skill.name, 80),
          clause: violation.clause,
          detail: violation.detail,
          specification: SPEC_URL,
        },
        suggestion:
          `Rename to satisfy the specification: 1-${NAME_MAX} characters, lowercase letters, ` +
          'digits and single hyphens, not starting or ending with one. Until then no compliant ' +
          'client will load this skill.',
        alwaysOnSavings: 0,
      });
    }

    /*
     * The name must match the parent directory. Skipped when the name was
     * inferred *from* that directory, where the comparison is circular.
     */
    if (!skill.nameInferred && violation === null) {
      const parent = path.basename(path.dirname(artifact.relPath));
      if (parent.length > 0 && parent !== skill.name) {
        findings.push({
          ruleId: 'SPEC-NAME-DIR-MISMATCH',
          severity: 'error',
          locations: [location],
          summary: `Skill name "${skill.name}" does not match its directory "${parent}"`,
          evidence: { name: skill.name, directory: parent, specification: SPEC_URL },
          suggestion:
            `Rename the directory to "${skill.name}", or change \`name\` to "${parent}". The ` +
            'specification requires them to match, and clients that key on the directory will ' +
            'not find this skill under the name it declares.',
          alwaysOnSavings: 0,
        });
      }
    }

    // --- description length ------------------------------------------------
    if (skill.description.length > DESCRIPTION_MAX) {
      findings.push({
        ruleId: 'SPEC-DESCRIPTION-TOO-LONG',
        severity: 'error',
        locations: [location],
        summary: `Description is ${skill.description.length} characters, over the ${DESCRIPTION_MAX} limit`,
        evidence: {
          characters: skill.description.length,
          limit: DESCRIPTION_MAX,
          excess: skill.description.length - DESCRIPTION_MAX,
          specification: SPEC_URL,
        },
        suggestion:
          `Shorten by at least ${skill.description.length - DESCRIPTION_MAX} characters. The ` +
          'description is always-on context for every session, so brevity is not only a ' +
          'conformance matter.',
        alwaysOnSavings: 0,
      });
    }

    // --- body size ---------------------------------------------------------
    const bodyLines = skill.body.split('\n').length;
    const bodyTokens = record.bodyCost.value;
    if (bodyTokens > BODY_MAX_TOKENS || bodyLines > BODY_MAX_LINES) {
      const over: string[] = [];
      if (bodyTokens > BODY_MAX_TOKENS) over.push(`${bodyTokens} tokens (limit ${BODY_MAX_TOKENS})`);
      if (bodyLines > BODY_MAX_LINES) over.push(`${bodyLines} lines (limit ${BODY_MAX_LINES})`);

      findings.push({
        ruleId: 'SPEC-BODY-TOO-LARGE',
        // A recommendation, not a hard constraint: the skill still loads.
        severity: 'warn',
        locations: [location],
        summary: `Skill body exceeds the recommended ceiling — ${over.join(', ')}`,
        evidence: {
          bodyTokens,
          bodyLines,
          tokenLimit: BODY_MAX_TOKENS,
          lineLimit: BODY_MAX_LINES,
          note: 'Conditional cost — loaded when the skill triggers, not always-on.',
          specification: SPEC_URL,
        },
        suggestion:
          'Move detailed reference material into `references/` and link to it from the body. ' +
          'The specification recommends the body carry only the instructions needed on every ' +
          'run; supporting files load on demand.',
        alwaysOnSavings: 0,
      });
    }
  }

  findings.sort((a, b) => {
    const pa = a.locations[0]?.path ?? '';
    const pb = b.locations[0]?.path ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });

  return findings;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
