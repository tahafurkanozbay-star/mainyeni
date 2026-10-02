import {
  hashFingerprint,
  normalizeSearchText,
  stableSerialize,
} from './normalization';
import {
  analyzeTextQuery,
  type TextQueryAnalysis,
  type TextQueryClause,
  type TextQueryClauseKind,
  type TextQueryField,
} from './textQueryAnalysisRuntime';
import {
  FuzzyLexiconRuntimeV8,
  type FuzzyLookupResultV8,
  type FuzzySuggestionV8,
} from './fuzzyLexiconRuntimeV8';
import {
  SynonymRegistryRuntimeV8,
  type SynonymExpansionV8,
  type SynonymScopeV8,
} from './synonymRegistryRuntimeV8';

export const QUERY_CORRECTION_VERSION_V8 = 'search-correction-v8' as const;

export interface QueryCorrectionPolicyV8 {
  readonly maximumCorrections?: number;
  readonly maximumAlternativesPerTerm?: number;
  readonly maximumExpandedTerms?: number;
  readonly minimumAutoApplyScore?: number;
  readonly minimumAutoApplyMargin?: number;
  readonly maximumAutoEditDistance?: number;
  readonly minimumTokenLength?: number;
  readonly correctRequiredTerms?: boolean;
  readonly correctOptionalTerms?: boolean;
  readonly correctFieldTerms?: boolean;
  readonly correctExcludedTerms?: boolean;
  readonly expandSynonyms?: boolean;
  readonly preserveKnownTerms?: boolean;
}

export type QueryCorrectionDecisionV8 =
  | 'known'
  | 'corrected'
  | 'ambiguous'
  | 'unknown'
  | 'preserved';

export interface QueryCorrectionAlternativeV8 {
  readonly value: string;
  readonly score: number;
  readonly editDistance: number;
  readonly gramSimilarity: number;
  readonly frequency: number;
}

export interface QueryCorrectionTermV8 {
  readonly ordinal: number;
  readonly kind: TextQueryClauseKind;
  readonly field: TextQueryField;
  readonly input: string;
  readonly canonical: string;
  readonly output: string;
  readonly decision: QueryCorrectionDecisionV8;
  readonly applied: boolean;
  readonly score: number;
  readonly margin: number;
  readonly editDistance: number | null;
  readonly alternatives: readonly QueryCorrectionAlternativeV8[];
  readonly synonymExpansions: readonly SynonymExpansionV8[];
}

export interface QueryCorrectionDiagnosticsV8 {
  readonly inputTerms: number;
  readonly evaluatedTerms: number;
  readonly knownTerms: number;
  readonly correctedTerms: number;
  readonly ambiguousTerms: number;
  readonly unknownTerms: number;
  readonly preservedTerms: number;
  readonly correctionBudgetReached: boolean;
  readonly expansionBudgetReached: boolean;
  readonly malformedQuotes: boolean;
  readonly inputTruncated: boolean;
}

export interface QueryCorrectionResultV8 {
  readonly version: typeof QUERY_CORRECTION_VERSION_V8;
  readonly original: string;
  readonly originalAnalysis: TextQueryAnalysis;
  readonly correctedQuery: string;
  readonly correctedAnalysis: TextQueryAnalysis;
  readonly changed: boolean;
  readonly terms: readonly QueryCorrectionTermV8[];
  readonly expandedTerms: readonly string[];
  readonly diagnostics: QueryCorrectionDiagnosticsV8;
  readonly fingerprint: string;
}

export interface QueryCorrectionSnapshotV8 {
  readonly version: typeof QUERY_CORRECTION_VERSION_V8;
  readonly corrections: number;
  readonly changedQueries: number;
  readonly autoAppliedTerms: number;
  readonly ambiguousTerms: number;
  readonly unknownTerms: number;
  readonly synonymExpansions: number;
  readonly fingerprint: string;
}

interface NormalizedCorrectionPolicyV8 {
  readonly maximumCorrections: number;
  readonly maximumAlternativesPerTerm: number;
  readonly maximumExpandedTerms: number;
  readonly minimumAutoApplyScore: number;
  readonly minimumAutoApplyMargin: number;
  readonly maximumAutoEditDistance: number;
  readonly minimumTokenLength: number;
  readonly correctRequiredTerms: boolean;
  readonly correctOptionalTerms: boolean;
  readonly correctFieldTerms: boolean;
  readonly correctExcludedTerms: boolean;
  readonly expandSynonyms: boolean;
  readonly preserveKnownTerms: boolean;
}

interface MutableCorrectionStatsV8 {
  corrections: number;
  changedQueries: number;
  autoAppliedTerms: number;
  ambiguousTerms: number;
  unknownTerms: number;
  synonymExpansions: number;
}

interface CorrectionContextV8 {
  readonly lexicon: FuzzyLexiconRuntimeV8;
  readonly synonyms: SynonymRegistryRuntimeV8 | null;
  readonly policy: NormalizedCorrectionPolicyV8;
}

const DEFAULT_POLICY_V8: NormalizedCorrectionPolicyV8 = Object.freeze({
  maximumCorrections: 8,
  maximumAlternativesPerTerm: 4,
  maximumExpandedTerms: 32,
  minimumAutoApplyScore: 175,
  minimumAutoApplyMargin: 18,
  maximumAutoEditDistance: 2,
  minimumTokenLength: 3,
  correctRequiredTerms: true,
  correctOptionalTerms: true,
  correctFieldTerms: true,
  correctExcludedTerms: false,
  expandSynonyms: true,
  preserveKnownTerms: true,
});

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const boundedFinite = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: QueryCorrectionPolicyV8 = {}): NormalizedCorrectionPolicyV8 => Object.freeze({
  maximumCorrections: boundedInteger(
    input.maximumCorrections,
    DEFAULT_POLICY_V8.maximumCorrections,
    0,
    64,
    'maximumCorrections',
  ),
  maximumAlternativesPerTerm: boundedInteger(
    input.maximumAlternativesPerTerm,
    DEFAULT_POLICY_V8.maximumAlternativesPerTerm,
    1,
    32,
    'maximumAlternativesPerTerm',
  ),
  maximumExpandedTerms: boundedInteger(
    input.maximumExpandedTerms,
    DEFAULT_POLICY_V8.maximumExpandedTerms,
    1,
    256,
    'maximumExpandedTerms',
  ),
  minimumAutoApplyScore: boundedFinite(
    input.minimumAutoApplyScore,
    DEFAULT_POLICY_V8.minimumAutoApplyScore,
    0,
    100_000,
    'minimumAutoApplyScore',
  ),
  minimumAutoApplyMargin: boundedFinite(
    input.minimumAutoApplyMargin,
    DEFAULT_POLICY_V8.minimumAutoApplyMargin,
    0,
    100_000,
    'minimumAutoApplyMargin',
  ),
  maximumAutoEditDistance: boundedInteger(
    input.maximumAutoEditDistance,
    DEFAULT_POLICY_V8.maximumAutoEditDistance,
    0,
    8,
    'maximumAutoEditDistance',
  ),
  minimumTokenLength: boundedInteger(
    input.minimumTokenLength,
    DEFAULT_POLICY_V8.minimumTokenLength,
    1,
    32,
    'minimumTokenLength',
  ),
  correctRequiredTerms: input.correctRequiredTerms ?? DEFAULT_POLICY_V8.correctRequiredTerms,
  correctOptionalTerms: input.correctOptionalTerms ?? DEFAULT_POLICY_V8.correctOptionalTerms,
  correctFieldTerms: input.correctFieldTerms ?? DEFAULT_POLICY_V8.correctFieldTerms,
  correctExcludedTerms: input.correctExcludedTerms ?? DEFAULT_POLICY_V8.correctExcludedTerms,
  expandSynonyms: input.expandSynonyms ?? DEFAULT_POLICY_V8.expandSynonyms,
  preserveKnownTerms: input.preserveKnownTerms ?? DEFAULT_POLICY_V8.preserveKnownTerms,
});

const correctionAllowedForKind = (
  kind: TextQueryClauseKind,
  policy: NormalizedCorrectionPolicyV8,
): boolean => {
  if (kind === 'required') return policy.correctRequiredTerms;
  if (kind === 'optional') return policy.correctOptionalTerms;
  if (kind === 'field') return policy.correctFieldTerms;
  if (kind === 'excluded') return policy.correctExcludedTerms;
  return false;
};

const synonymScopeForField = (field: TextQueryField): SynonymScopeV8 => {
  if (field === 'title') return 'title';
  if (field === 'category') return 'category';
  if (field === 'type') return 'type';
  if (field === 'district') return 'district';
  if (field === 'neighborhood') return 'neighborhood';
  if (field === 'street') return 'street';
  if (field === 'address') return 'address';
  return 'any';
};

const alternativeFromSuggestion = (value: FuzzySuggestionV8): QueryCorrectionAlternativeV8 => Object.freeze({
  value: value.term,
  score: value.score,
  editDistance: value.editDistance,
  gramSimilarity: value.gramSimilarity,
  frequency: value.frequency,
});

const boundedAlternatives = (
  lookup: FuzzyLookupResultV8,
  maximum: number,
): readonly QueryCorrectionAlternativeV8[] => Object.freeze(
  lookup.suggestions.slice(0, maximum).map(alternativeFromSuggestion),
);

const synonymExpansions = (
  value: string,
  field: TextQueryField,
  context: CorrectionContextV8,
): readonly SynonymExpansionV8[] => {
  if (!context.policy.expandSynonyms || !context.synonyms) return Object.freeze([]);
  return context.synonyms.expand(value, synonymScopeForField(field)).expansions;
};

const knownTermResult = (
  clause: TextQueryClause,
  context: CorrectionContextV8,
): QueryCorrectionTermV8 => Object.freeze({
  ordinal: clause.ordinal,
  kind: clause.kind,
  field: clause.field,
  input: clause.raw,
  canonical: clause.canonical,
  output: clause.canonical,
  decision: 'known',
  applied: false,
  score: Number.POSITIVE_INFINITY,
  margin: Number.POSITIVE_INFINITY,
  editDistance: 0,
  alternatives: Object.freeze([]),
  synonymExpansions: synonymExpansions(clause.canonical, clause.field, context),
});

const preservedTermResult = (
  clause: TextQueryClause,
  context: CorrectionContextV8,
): QueryCorrectionTermV8 => Object.freeze({
  ordinal: clause.ordinal,
  kind: clause.kind,
  field: clause.field,
  input: clause.raw,
  canonical: clause.canonical,
  output: clause.canonical,
  decision: 'preserved',
  applied: false,
  score: 0,
  margin: 0,
  editDistance: null,
  alternatives: Object.freeze([]),
  synonymExpansions: synonymExpansions(clause.canonical, clause.field, context),
});

const correctionDecision = (
  clause: TextQueryClause,
  lookup: FuzzyLookupResultV8,
  context: CorrectionContextV8,
  correctionBudgetAvailable: boolean,
): QueryCorrectionTermV8 => {
  const alternatives = boundedAlternatives(lookup, context.policy.maximumAlternativesPerTerm);
  const first = lookup.suggestions[0] ?? null;
  const second = lookup.suggestions[1] ?? null;
  if (!first) {
    return Object.freeze({
      ordinal: clause.ordinal,
      kind: clause.kind,
      field: clause.field,
      input: clause.raw,
      canonical: clause.canonical,
      output: clause.canonical,
      decision: 'unknown',
      applied: false,
      score: 0,
      margin: 0,
      editDistance: null,
      alternatives,
      synonymExpansions: synonymExpansions(clause.canonical, clause.field, context),
    });
  }
  const margin = second ? first.score - second.score : first.score;
  const canApply = correctionBudgetAvailable
    && !first.exact
    && first.score >= context.policy.minimumAutoApplyScore
    && margin >= context.policy.minimumAutoApplyMargin
    && first.editDistance <= context.policy.maximumAutoEditDistance;
  const decision: QueryCorrectionDecisionV8 = canApply
    ? 'corrected'
    : first.exact
      ? 'known'
      : alternatives.length > 1
        ? 'ambiguous'
        : 'unknown';
  const output = canApply ? first.term : clause.canonical;
  return Object.freeze({
    ordinal: clause.ordinal,
    kind: clause.kind,
    field: clause.field,
    input: clause.raw,
    canonical: clause.canonical,
    output,
    decision,
    applied: canApply,
    score: first.score,
    margin,
    editDistance: first.editDistance,
    alternatives,
    synonymExpansions: synonymExpansions(output, clause.field, context),
  });
};

const correctClause = (
  clause: TextQueryClause,
  context: CorrectionContextV8,
  correctionBudgetAvailable: boolean,
): QueryCorrectionTermV8 => {
  if (clause.kind === 'phrase' || !correctionAllowedForKind(clause.kind, context.policy)) {
    return preservedTermResult(clause, context);
  }
  if (clause.canonical.length < context.policy.minimumTokenLength) {
    return preservedTermResult(clause, context);
  }
  if (context.policy.preserveKnownTerms && context.lexicon.has(clause.canonical)) {
    return knownTermResult(clause, context);
  }
  return correctionDecision(
    clause,
    context.lexicon.lookup(clause.canonical, context.policy.maximumAlternativesPerTerm),
    context,
    correctionBudgetAvailable,
  );
};

const queryClauseText = (clause: TextQueryClause, correction: QueryCorrectionTermV8): string => {
  if (clause.kind === 'phrase') return `"${clause.canonical.replace(/"/g, '')}"`;
  if (clause.kind === 'field') return `${clause.field}:${correction.output}`;
  if (clause.kind === 'required') return `+${correction.output}`;
  if (clause.kind === 'excluded') return `-${correction.output}`;
  return correction.output;
};

const rebuildQuery = (
  analysis: TextQueryAnalysis,
  corrections: readonly QueryCorrectionTermV8[],
): string => {
  const byOrdinal = new Map<number, QueryCorrectionTermV8>();
  for (const correction of corrections) byOrdinal.set(correction.ordinal, correction);
  const values: string[] = [];
  for (const clause of analysis.clauses) {
    const correction = byOrdinal.get(clause.ordinal);
    if (!correction) continue;
    values.push(queryClauseText(clause, correction));
  }
  return values.join(' ').trim();
};

const appendExpansionTokens = (
  values: Set<string>,
  expansion: SynonymExpansionV8,
  maximum: number,
): boolean => {
  for (const token of expansion.tokens) {
    if (values.size >= maximum) return true;
    values.add(token);
  }
  return values.size >= maximum;
};

const appendSynonymExpansionTokens = (
  values: Set<string>,
  expansions: readonly SynonymExpansionV8[],
  maximum: number,
): boolean => {
  for (const expansion of expansions) {
    if (appendExpansionTokens(values, expansion, maximum)) return true;
  }
  return false;
};

const collectExpandedTerms = (
  corrections: readonly QueryCorrectionTermV8[],
  maximum: number,
): Readonly<{ values: readonly string[]; truncated: boolean }> => {
  const values = new Set<string>();
  let truncated = false;
  for (const correction of corrections) {
    if (correction.kind === 'excluded' || correction.kind === 'phrase') continue;
    values.add(correction.output);
    if (appendSynonymExpansionTokens(values, correction.synonymExpansions, maximum)) {
      truncated = true;
      break;
    }
  }
  return Object.freeze({ values: Object.freeze(Array.from(values).slice(0, maximum)), truncated });
};

const diagnosticCounts = (
  corrections: readonly QueryCorrectionTermV8[],
): Readonly<{
  evaluated: number;
  known: number;
  corrected: number;
  ambiguous: number;
  unknown: number;
  preserved: number;
}> => {
  let evaluated = 0;
  let known = 0;
  let corrected = 0;
  let ambiguous = 0;
  let unknown = 0;
  let preserved = 0;
  for (const item of corrections) {
    if (item.decision === 'preserved') preserved += 1;
    else evaluated += 1;
    if (item.decision === 'known') known += 1;
    else if (item.decision === 'corrected') corrected += 1;
    else if (item.decision === 'ambiguous') ambiguous += 1;
    else if (item.decision === 'unknown') unknown += 1;
  }
  return Object.freeze({ evaluated, known, corrected, ambiguous, unknown, preserved });
};

const resultFingerprint = (
  original: TextQueryAnalysis,
  corrected: TextQueryAnalysis,
  corrections: readonly QueryCorrectionTermV8[],
  expandedTerms: readonly string[],
): string => hashFingerprint(stableSerialize({
  version: QUERY_CORRECTION_VERSION_V8,
  original: original.signature,
  corrected: corrected.signature,
  corrections: corrections.map(item => [
    item.ordinal,
    item.kind,
    item.field,
    item.canonical,
    item.output,
    item.decision,
    item.applied,
  ]),
  expandedTerms,
}));

export class QueryCorrectionRuntimeV8 {
  readonly #lexicon: FuzzyLexiconRuntimeV8;
  readonly #synonyms: SynonymRegistryRuntimeV8 | null;
  readonly #policy: NormalizedCorrectionPolicyV8;
  readonly #stats: MutableCorrectionStatsV8 = {
    corrections: 0,
    changedQueries: 0,
    autoAppliedTerms: 0,
    ambiguousTerms: 0,
    unknownTerms: 0,
    synonymExpansions: 0,
  };

  constructor(
    lexicon: FuzzyLexiconRuntimeV8,
    synonyms: SynonymRegistryRuntimeV8 | null = null,
    policyInput: QueryCorrectionPolicyV8 = {},
  ) {
    this.#lexicon = lexicon;
    this.#synonyms = synonyms;
    this.#policy = normalizePolicy(policyInput);
  }

  policy(): QueryCorrectionPolicyV8 {
    return Object.freeze({ ...this.#policy });
  }

  correct(input: unknown): QueryCorrectionResultV8 {
    this.#stats.corrections += 1;
    const original = input === null || input === undefined ? '' : String(input);
    const analysis = analyzeTextQuery(original);
    const context: CorrectionContextV8 = Object.freeze({
      lexicon: this.#lexicon,
      synonyms: this.#synonyms,
      policy: this.#policy,
    });
    const corrections: QueryCorrectionTermV8[] = [];
    let appliedCount = 0;
    for (const clause of analysis.clauses) {
      const correction = correctClause(
        clause,
        context,
        appliedCount < this.#policy.maximumCorrections,
      );
      if (correction.applied) appliedCount += 1;
      corrections.push(correction);
    }
    const correctedQuery = rebuildQuery(analysis, corrections);
    const correctedAnalysis = analyzeTextQuery(correctedQuery);
    const expanded = collectExpandedTerms(corrections, this.#policy.maximumExpandedTerms);
    const counts = diagnosticCounts(corrections);
    const changed = appliedCount > 0 && normalizeSearchText(correctedQuery) !== normalizeSearchText(original);
    if (changed) this.#stats.changedQueries += 1;
    this.#stats.autoAppliedTerms += counts.corrected;
    this.#stats.ambiguousTerms += counts.ambiguous;
    this.#stats.unknownTerms += counts.unknown;
    let expansionCount = 0;
    for (const correction of corrections) expansionCount += correction.synonymExpansions.length;
    this.#stats.synonymExpansions += expansionCount;
    const diagnostics: QueryCorrectionDiagnosticsV8 = Object.freeze({
      inputTerms: analysis.clauses.length,
      evaluatedTerms: counts.evaluated,
      knownTerms: counts.known,
      correctedTerms: counts.corrected,
      ambiguousTerms: counts.ambiguous,
      unknownTerms: counts.unknown,
      preservedTerms: counts.preserved,
      correctionBudgetReached: appliedCount >= this.#policy.maximumCorrections
        && corrections.some(item => item.decision === 'ambiguous' || item.decision === 'unknown'),
      expansionBudgetReached: expanded.truncated,
      malformedQuotes: analysis.diagnostics.malformedQuotes,
      inputTruncated: analysis.diagnostics.truncated,
    });
    const frozenCorrections = Object.freeze(corrections);
    return Object.freeze({
      version: QUERY_CORRECTION_VERSION_V8,
      original,
      originalAnalysis: analysis,
      correctedQuery,
      correctedAnalysis,
      changed,
      terms: frozenCorrections,
      expandedTerms: expanded.values,
      diagnostics,
      fingerprint: resultFingerprint(analysis, correctedAnalysis, frozenCorrections, expanded.values),
    });
  }

  snapshot(): QueryCorrectionSnapshotV8 {
    return Object.freeze({
      version: QUERY_CORRECTION_VERSION_V8,
      corrections: this.#stats.corrections,
      changedQueries: this.#stats.changedQueries,
      autoAppliedTerms: this.#stats.autoAppliedTerms,
      ambiguousTerms: this.#stats.ambiguousTerms,
      unknownTerms: this.#stats.unknownTerms,
      synonymExpansions: this.#stats.synonymExpansions,
      fingerprint: hashFingerprint(stableSerialize({
        version: QUERY_CORRECTION_VERSION_V8,
        lexicon: this.#lexicon.snapshot().fingerprint,
        synonyms: this.#synonyms?.snapshot().fingerprint ?? null,
        policy: this.#policy,
        stats: this.#stats,
      })),
    });
  }
}

export const createQueryCorrectionRuntimeV8 = (
  lexicon: FuzzyLexiconRuntimeV8,
  synonyms: SynonymRegistryRuntimeV8 | null = null,
  policy: QueryCorrectionPolicyV8 = {},
): QueryCorrectionRuntimeV8 => new QueryCorrectionRuntimeV8(lexicon, synonyms, policy);
