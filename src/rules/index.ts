import type { Severity } from '../types.js';

/**
 * The rule registry.
 *
 * the architecture rules requires rules to be data rather than scattered conditionals, so
 * that `--explain <id>` is trivial and the citation requirement is structurally
 * enforced instead of aspirational. A finding carries only a `ruleId`; its
 * citation is looked up here. There is no way to emit a finding without one.
 *
 * Every `Citation` below was fetched and read in full while building this file
 * before use. Where a secondary summary disagreed with the primary source, the
 * primary source won; the disagreements are recorded in RESEARCH_NOTES.md.
 */

export interface Citation {
  readonly ref: string;
  readonly url: string;
  /**
   * The specific sentence relied on, quoted from the source. Quoting rather than
   * paraphrasing is deliberate: it lets a reader check in one step whether the
   * rule actually follows from the source, which is the entire point.
   */
  readonly quote: string;
}

export interface Rule {
  readonly id: string;
  readonly title: string;
  readonly defaultSeverity: Severity;
  /** Why this is a problem, in the tool's own words. */
  readonly rationale: string;
  readonly citations: readonly Citation[];
  /**
   * What the rule provably does NOT establish. Printed by `--explain` so users
   * can calibrate how much to trust each finding.
   */
  readonly limitation: string;
}

const GLOAGUEN_COST: Citation = {
  ref: 'Gloaguen, Mündler, Müller, Raychev & Vechev (2026), arXiv:2602.11988, §1',
  url: 'https://arxiv.org/abs/2602.11988',
  quote:
    'providing context files does not generally improve task success rates, while ' +
    'increasing inference cost by over 20% on average',
};

const GLOAGUEN_OVERVIEW: Citation = {
  ref: 'Gloaguen et al. (2026), arXiv:2602.11988, §4',
  url: 'https://arxiv.org/abs/2602.11988',
  quote:
    'instructions in the context files are well followed by coding agents, ' +
    'repository overviews, although popular and recommended by model providers, are not helpful',
};

const GLOAGUEN_README: Citation = {
  ref: 'Gloaguen et al. (2026), arXiv:2602.11988, §5',
  url: 'https://arxiv.org/abs/2602.11988',
  quote:
    'Human-written context files should only include instructions required for coding ' +
    'agents that are not already present in the README',
};

const GLOAGUEN_FOLLOWED: Citation = {
  ref: 'Gloaguen et al. (2026), arXiv:2602.11988, §4',
  url: 'https://arxiv.org/abs/2602.11988',
  quote: 'instructions provided in context files are well followed',
};

const LING_REDUNDANCY: Citation = {
  ref: 'Ling, Zhong & Huang (2026), arXiv:2602.08004, §3.2',
  url: 'https://arxiv.org/abs/2602.08004',
  quote:
    'Skills that appear once account for 53.7%, while skills that appear more than once ' +
    'account for 46.3%',
};

const LING_LENGTH: Citation = {
  ref: 'Ling, Zhong & Huang (2026), arXiv:2602.08004, §3.1',
  url: 'https://arxiv.org/abs/2602.08004',
  quote:
    'The top 1% of skills exceed 9,253 tokens, and the maximum reaches 116,239 tokens, ' +
    'which can consume prompt budgets and hinder reliable selection and auditing when loaded in full',
};

const SPEC_NAME: Citation = {
  ref: 'Agent Skills specification, `name` field (fetched 2026-08-16)',
  url: 'https://agentskills.io/specification',
  quote:
    'Must be 1-64 characters. May only contain unicode lowercase alphanumeric characters ' +
    '(a-z, 0-9) and hyphens (-). Must not start or end with a hyphen. Must not contain ' +
    'consecutive hyphens. Must match the parent directory name.',
};

const SPEC_DESCRIPTION: Citation = {
  ref: 'Agent Skills specification, `description` field (fetched 2026-08-16)',
  url: 'https://agentskills.io/specification',
  quote:
    'Must be 1-1024 characters. Should describe both what the skill does and when to use it.',
};

const SPEC_BODY: Citation = {
  ref: 'Agent Skills, best practices for skill creators (fetched 2026-08-16)',
  url: 'https://agentskills.io/skill-creation/best-practices',
  quote:
    'The specification recommends keeping SKILL.md under 500 lines and 5,000 tokens — just the ' +
    'core instructions the agent needs on every run. When a skill legitimately needs more ' +
    'content, move detailed reference material to separate files in references/ or similar.',
};

const ANTHROPIC_ROUTING: Citation = {
  ref: 'Anthropic, "Agent Skills" overview (fetched 2026-08-16)',
  url: 'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview',
  quote:
    'The description is what Claude matches your request against when determining whether to ' +
    'trigger the Skill, so it must say both what the Skill does and when to use it.',
};

const ANTHROPIC_DISCLOSURE: Citation = {
  ref: 'Anthropic, "Agent Skills" overview (fetched 2026-08-16)',
  url: 'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview',
  quote:
    'Claude loads this metadata at startup and includes it in the system prompt. ' +
    'until a Skill is triggered, only its name and description occupy context.',
};

export const RULES: readonly Rule[] = [
  {
    id: 'SPEC-NAME-INVALID',
    title: 'Skill name violates the Agent Skills specification',
    defaultSeverity: 'error',
    rationale:
      'The specification constrains `name` to 1-64 lowercase alphanumeric characters and ' +
      'single hyphens. A name outside that set is not a style preference: compliant clients ' +
      'reject the skill, so it never appears in the catalogue and never triggers. The failure ' +
      'is silent, which is why a linter is the only thing likely to catch it.',
    citations: [SPEC_NAME],
    limitation:
      'Checks the format the specification defines. It cannot confirm that any particular ' +
      'client enforces every clause — some may be more permissive — only that a conforming ' +
      'client is entitled to reject the skill.',
  },
  {
    id: 'SPEC-NAME-DIR-MISMATCH',
    title: 'Skill name does not match its parent directory',
    defaultSeverity: 'error',
    rationale:
      'The specification requires the declared `name` to match the directory containing ' +
      '`SKILL.md`. Clients that key on the directory will not find the skill under the name it ' +
      'advertises, and clients that key on the name will not find its resources.',
    citations: [SPEC_NAME],
    limitation:
      'Not reported when the name was inferred from the directory in the first place, where ' +
      'the comparison would be circular.',
  },
  {
    id: 'SPEC-DESCRIPTION-TOO-LONG',
    title: 'Description exceeds the specification limit',
    defaultSeverity: 'error',
    rationale:
      'The specification caps `description` at 1024 characters. Beyond it a conforming client ' +
      'may reject the skill outright, and since the description is always-on context in every ' +
      'session, an oversized one is also the most expensive kind of text in the file.',
    citations: [SPEC_DESCRIPTION, ANTHROPIC_DISCLOSURE],
    limitation:
      'Measures characters, as the specification does. It does not judge whether the ' +
      'description is well written, only whether it is legal.',
  },
  {
    id: 'SPEC-BODY-TOO-LARGE',
    title: 'Skill body exceeds the recommended size',
    defaultSeverity: 'warn',
    rationale:
      'Published guidance recommends a body under 500 lines and 5,000 tokens, with reference ' +
      'material moved to files that load on demand. This is conditional cost rather than ' +
      'always-on, so it is a recommendation rather than a hard limit — but a body this large ' +
      'is loaded in full every time the skill triggers.',
    citations: [SPEC_BODY, LING_LENGTH, ANTHROPIC_DISCLOSURE],
    limitation:
      'A recommendation, not a constraint: the skill still loads. A long body is not itself a ' +
      'defect, and some skills legitimately need one.',
  },
  {
    id: 'RED-REPO-OVERVIEW',
    title: 'Context file describes repository structure',
    defaultSeverity: 'warn',
    rationale:
      'Directory listings and repository overviews are the single context-file pattern the ' +
      'ETH Zurich study tested and found unhelpful. The agent can read the tree; the ' +
      'description costs tokens every session and goes stale silently.',
    citations: [GLOAGUEN_OVERVIEW, GLOAGUEN_COST],
    limitation:
      'The study measured that overviews do not help; it did not measure that removing an ' +
      'existing one improves success. The defensible claim is cost reduction at no measured ' +
      'benefit loss, not a success-rate gain.',
  },
  {
    id: 'RED-TECHSTACK',
    title: 'Context file restates the dependency manifest',
    defaultSeverity: 'warn',
    rationale:
      'The named dependency already appears in a manifest the agent can read. This is ' +
      'information the agent can obtain elsewhere, which the study identifies as the ' +
      'category that should not be in a context file.',
    citations: [GLOAGUEN_README, GLOAGUEN_COST],
    limitation:
      'Only fires when the exact dependency name appears in a manifest in the analysis root. ' +
      'A stack claim about tooling not listed in a manifest is not detected.',
  },
  {
    id: 'RED-GENERIC',
    title: 'Context file contains generic programming advice',
    defaultSeverity: 'warn',
    rationale:
      'Advice that would apply to any repository carries no repository-specific information, ' +
      'so it cannot be the "non-standard coding practice" the study found context files are ' +
      'good for, while still incurring the measured per-session cost.',
    citations: [GLOAGUEN_README, GLOAGUEN_COST],
    limitation:
      'Matches a fixed phrase list. It detects the clichés on that list and nothing else; a ' +
      'novel phrasing of the same empty advice will pass.',
  },
  {
    id: 'RED-LINTER',
    title: 'Context file restates a rule a linter already enforces',
    defaultSeverity: 'warn',
    rationale:
      'A formatter or linter enforces the rule mechanically on every file. Restating it as a ' +
      'prose instruction adds per-session tokens and is strictly less reliable than the tool ' +
      'that is already configured.',
    citations: [GLOAGUEN_README, GLOAGUEN_COST],
    limitation:
      'Detects that a linter config file exists and that the instruction is style-shaped. It ' +
      'does not parse the linter config, so it cannot prove that specific rule is enabled.',
  },
  {
    id: 'RED-STALE-PATH',
    title: 'Context file references a path that is not present',
    defaultSeverity: 'info',
    rationale:
      'The study measured that agents follow context-file instructions faithfully. A path ' +
      'that is not in the repository is therefore not inert: the agent is led to look ' +
      'somewhere that does not exist, spending steps and inference cost on a dead end. ' +
      'Unlike every other rule here this one is a checkable fact rather than a judgement — ' +
      'the path is either on disk or it is not.',
    citations: [GLOAGUEN_FOLLOWED, GLOAGUEN_COST],
    limitation:
      'A missing path is a fact; a *stale* path is an inference, and this rule cannot tell ' +
      'the two apart. Directories created at runtime are absent for a good reason — on the ' +
      'validation corpus that was the entire residual false-positive class. Paths listed in ' +
      '.gitignore are suppressed, as are illustrative trees whose root does not exist and ' +
      'package names that merely look path-shaped. It cannot see build-generated paths or ' +
      'paths that are correct on another branch.',
  },
  {
    id: 'AMB-DUPLICATE-NAME',
    title: 'Two skills share a canonical name',
    defaultSeverity: 'warn',
    rationale:
      'Near-identical names are the dominant redundancy pattern in the public corpus. Two ' +
      'skills with the same canonical name compete for the same routing slot, and the model ' +
      'has only the descriptions to tell them apart.',
    citations: [LING_REDUNDANCY, ANTHROPIC_ROUTING],
    limitation:
      'Name identity is evidence of duplication, not proof of mis-routing. Two identically ' +
      'named skills with genuinely disjoint descriptions may route correctly.',
  },
  {
    id: 'AMB-TRIGGER-OVERLAP',
    title: 'Two skills declare overlapping trigger conditions',
    defaultSeverity: 'warn',
    rationale:
      'The description is the routing rule. When two descriptions claim the same triggering ' +
      'conditions, the model has no documented basis for choosing between them, so which one ' +
      'loads is not determined by the library author.',
    citations: [ANTHROPIC_ROUTING, LING_REDUNDANCY],
    limitation:
      'OFF BY DEFAULT (--experimental-ambiguity). Measured precision is 62% and recall 96% ' +
      'on a 124-pair hand-labelled set, meaning roughly two in five flagged pairs are wrong. ' +
      'Nine scorer variants were tried and none exceeded 64% precision; the dominant failure ' +
      'is sibling skills that differ only by a named entity (/ar:loop vs /ar:status, ' +
      'spf13/cobra vs spf13/viper). It is lexical, and it does not observe real routing.',
  },
  {
    id: 'AMB-NO-TRIGGER',
    title: 'Skill description states no trigger condition',
    defaultSeverity: 'info',
    rationale:
      'Anthropic documents that a description must state both what the skill does and when to ' +
      'use it. A description with no "when" clause gives the router nothing to match a ' +
      'request against beyond topical resemblance.',
    citations: [ANTHROPIC_ROUTING],
    limitation:
      'Detects a trigger clause by a fixed set of lead-in phrases derived from a real corpus. ' +
      'A description that conveys its trigger through unusual phrasing will be flagged even ' +
      'though a reader would understand it.',
  },
  {
    id: 'CFL-CONTRADICTION',
    title: 'Two skills give opposed instructions on the same subject',
    defaultSeverity: 'warn',
    rationale:
      'The ETH Zurich study measured that agents follow context instructions faithfully. ' +
      'Faithful following of two opposed instructions has no defined outcome, so which one ' +
      'wins is not controlled by the author. Severity is higher when the two skills also have ' +
      'overlapping triggers, because only then can both be loaded at once.',
    citations: [GLOAGUEN_FOLLOWED, ANTHROPIC_ROUTING],
    limitation:
      'The study measured instruction-following, not conflict outcomes. That contradictions ' +
      'are harmful is an inference from that finding, not a separately measured result. ' +
      'Measured detection precision is poor: 0 findings across 1,022 corpus skills and 1 ' +
      'correct out of 3 across 33 repositories, the failures being qualified permissions read ' +
      'as prohibitions. Capped at `warn` for that reason, and it misses paraphrased conflicts ' +
      'entirely.',
  },
];

const BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

export function getRule(id: string): Rule {
  const rule = BY_ID.get(id);
  if (!rule) {
    // A finding referencing an unregistered rule is a programming error, and it
    // would produce an uncited finding — exactly what the registry prevents.
    throw new Error(`No rule registered with id "${id}"`);
  }
  return rule;
}

export function ruleIds(): string[] {
  return RULES.map((r) => r.id);
}
