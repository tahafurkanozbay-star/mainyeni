import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeSearchToken,
  stableSerialize,
  tokenizeSearchText,
} from './normalization';
import {
  analyzeTextQuery,
  type TextQueryAnalysis,
  type TextQueryAnalysisPolicy,
} from './textQueryAnalysisRuntime';
import {
  TermLexiconRuntimeV8,
  type TermSuggestionV8,
} from './termLexiconRuntimeV8';

export type QueryRewriteModeV8 = 'disabled' | 'suggest' | 'fallback';

export type QueryRewriteBlockReasonV8 =
  | 'disabled'
  | 'empty-query'
  | 'query-truncated'
  | 'malformed-quotes'
  | 'syntax-sensitive'
  | 'term-budget-exceeded'
  | 'no-misspellings'
  | 'correction-budget-exceeded'
  | 'low-confidence'
  | 'ambiguous-correction';

export interface QueryRewritePolicyV8 {
  readonly mode?: QueryRewriteModeV8;
  readonly maximumTerms?: number;
  readonly maximumCorrections?: number;
  readonly minimumTermLength?: number;
  readonly minimumConfidence?: number;
  readonly minimumScoreGap?: number;
  readonly maximumDistance?: number;
  readonly minimumDocumentFrequency?: number;
  readonly analyzer?: Partial<TextQueryAnalysisPolicy>;
}

export interface QueryRewriteTermDecisionV8 {
  readonly ordinal: number;
  readonly original: string;
  readonly canonical: string;
  readonly exactInLexicon: boolean;
  readonly replacement: string | null;
  readonly distance: number | null;
  readonly confidence: number;
  readonly documentFrequency: number;
  readonly ambiguous: boolean;
  readonly accepted: boolean;
}

export interface QueryRewritePlanV8 {
  readonly version: 8;
  readonly mode: QueryRewriteModeV8;
  readonly eligible: boolean;
  readonly originalQuery: string;
  readonly canonicalQuery: string;
  readonly rewrittenQuery: string;
  readonly changed: boolean;
  readonly correctionCount: number;
  readonly blockReason: QueryRewriteBlockReasonV8 | null;
  readonly decisions: readonly QueryRewriteTermDecisionV8[];
  readonly analysis: TextQueryAnalysis;
  readonly signature: string;
}

export interface QueryRewriteSnapshotV8 {
  readonly version: 8;
  readonly plans: number;
  readonly eligiblePlans: number;
  readonly changedPlans: number;
  readonly acceptedCorrections: number;
  readonly rejectedLowConfidence: number;
  readonly rejectedAmbiguous: number;
  readonly blockedSyntax: number;
  readonly blockedBudget: number;
}

interface NormalizedPolicyV8 {
  readonly mode: QueryRewriteModeV8;
  readonly maximumTerms: number;
  readonly maximumCorrections: number;
  readonly minimumTermLength: number;
  readonly minimumConfidence: number;
  readonly minimumScoreGap: number;
  readonly maximumDistance: number;
  readonly minimumDocumentFrequency: number;
  readonly analyzer: Partial<TextQueryAnalysisPolicy>;
}

interface MutableStatsV8 {
  plans: number;
  eligiblePlans: number;
  changedPlans: number;
  acceptedCorrections: number;
  rejectedLowConfidence: number;
  rejectedAmbiguous: number;
  blockedSyntax: number;
  blockedBudget: number;
}

const VERSION = 8 as const;

const normalizeFinite = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`rewrite policy number must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizePolicy = (input: QueryRewritePolicyV8 = {}): NormalizedPolicyV8 => Object.freeze({
  mode: input.mode ?? 'fallback',
  maximumTerms: normalizeInteger(input.maximumTerms, { min: 1, max: 64, fallback: 12 }),
  maximumCorrections: normalizeInteger(input.maximumCorrections, { min: 1, max: 16, fallback: 3 }),
  minimumTermLength: normalizeInteger(input.minimumTermLength, { min: 1, max: 64, fallback: 3 }),
  minimumConfidence: normalizeFinite(input.minimumConfidence, 0.76, 0, 1),
  minimumScoreGap: normalizeFinite(input.minimumScoreGap, 0.035, 0, 1),
  maximumDistance: normalizeInteger(input.maximumDistance, { min: 0, max: 4, fallback: 2 }),
  minimumDocumentFrequency: normalizeInteger(input.minimumDocumentFrequency, { min: 1, max: 100_000, fallback: 1 }),
  analyzer: Object.freeze({ ...input.analyzer }),
});

const syntaxSensitive = (analysis: TextQueryAnalysis): boolean => {
  if (analysis.requiredTerms.length > 0 || analysis.excludedTerms.length > 0) return true;
  if (analysis.phrases.length > 0) return true;
  return analysis.clauses.some(clause => clause.kind === 'field' || clause.kind === 'required' || clause.kind === 'excluded' || clause.kind === 'phrase');
};

const emptyDecision = (
  ordinal: number,
  original: string,
  canonical: string,
  exactInLexicon: boolean,
): QueryRewriteTermDecisionV8 => Object.freeze({
  ordinal,
  original,
  canonical,
  exactInLexicon,
  replacement: null,
  distance: null,
  confidence: exactInLexicon ? 1 : 0,
  documentFrequency: 0,
  ambiguous: false,
  accepted: false,
});

const secondScore = (suggestions: readonly TermSuggestionV8[]): number => suggestions[1]?.score ?? 0;

const acceptedSuggestion = (
  suggestions: readonly TermSuggestionV8[],
  policy: NormalizedPolicyV8,
): TermSuggestionV8 | null => {
  const best = suggestions[0];
  if (!best) return null;
  if (best.distance > policy.maximumDistance) return null;
  if (best.documentFrequency < policy.minimumDocumentFrequency) return null;
  if (best.score < policy.minimumConfidence) return null;
  if (best.ambiguous) return null;
  if (best.score - secondScore(suggestions) < policy.minimumScoreGap && suggestions.length > 1) return null;
  return best;
};

const termDecision = (
  lexicon: TermLexiconRuntimeV8,
  raw: string,
  ordinal: number,
  policy: NormalizedPolicyV8,
): QueryRewriteTermDecisionV8 => {
  const canonical = normalizeSearchToken(raw);
  const exact = lexicon.entry(canonical);
  if (exact) {
    return Object.freeze({
      ordinal,
      original: raw,
      canonical,
      exactInLexicon: true,
      replacement: null,
      distance: 0,
      confidence: 1,
      documentFrequency: exact.documentFrequency,
      ambiguous: false,
      accepted: false,
    });
  }
  if (!canonical || canonical.length < policy.minimumTermLength) {
    return emptyDecision(ordinal, raw, canonical, false);
  }
  const suggestionResult = lexicon.suggest(canonical, 4);
  const best = suggestionResult.suggestions[0] ?? null;
  const accepted = acceptedSuggestion(suggestionResult.suggestions, policy);
  return Object.freeze({
    ordinal,
    original: raw,
    canonical,
    exactInLexicon: false,
    replacement: accepted?.term ?? null,
    distance: best?.distance ?? null,
    confidence: best?.score ?? 0,
    documentFrequency: best?.documentFrequency ?? 0,
    ambiguous: best?.ambiguous ?? false,
    accepted: Boolean(accepted),
  });
};

const decisionsForTokens = (
  lexicon: TermLexiconRuntimeV8,
  tokens: readonly string[],
  policy: NormalizedPolicyV8,
): readonly QueryRewriteTermDecisionV8[] => Object.freeze(
  tokens.map((token, ordinal) => termDecision(lexicon, token, ordinal, policy)),
);

const acceptedCount = (decisions: readonly QueryRewriteTermDecisionV8[]): number =>
  decisions.reduce((total, decision) => total + (decision.accepted ? 1 : 0), 0);

const hasLowConfidenceMiss = (
  decisions: readonly QueryRewriteTermDecisionV8[],
  policy: NormalizedPolicyV8,
): boolean => decisions.some(decision => !decision.exactInLexicon
  && !decision.accepted
  && !decision.ambiguous
  && decision.confidence > 0
  && decision.confidence < policy.minimumConfidence);

const hasAmbiguousMiss = (decisions: readonly QueryRewriteTermDecisionV8[]): boolean =>
  decisions.some(decision => !decision.exactInLexicon && !decision.accepted && decision.ambiguous);

const rewrittenTokens = (decisions: readonly QueryRewriteTermDecisionV8[]): readonly string[] => Object.freeze(
  decisions.map(decision => decision.accepted && decision.replacement
    ? decision.replacement
    : decision.canonical || normalizeSearchToken(decision.original)),
);

const planSignature = (
  originalQuery: string,
  rewrittenQuery: string,
  analysis: TextQueryAnalysis,
  decisions: readonly QueryRewriteTermDecisionV8[],
  mode: QueryRewriteModeV8,
): string => hashFingerprint(stableSerialize({
  version: VERSION,
  mode,
  originalQuery: normalizeSearchText(originalQuery),
  rewrittenQuery,
  analysis: analysis.signature,
  decisions: decisions.map(decision => [
    decision.canonical,
    decision.replacement,
    decision.distance,
    decision.confidence,
    decision.accepted,
  ]),
}));

const blockedPlan = (
  mode: QueryRewriteModeV8,
  originalQuery: string,
  analysis: TextQueryAnalysis,
  reason: QueryRewriteBlockReasonV8,
  decisions: readonly QueryRewriteTermDecisionV8[] = Object.freeze([]),
): QueryRewritePlanV8 => {
  const canonicalQuery = analysis.normalized;
  return Object.freeze({
    version: VERSION,
    mode,
    eligible: false,
    originalQuery,
    canonicalQuery,
    rewrittenQuery: canonicalQuery,
    changed: false,
    correctionCount: 0,
    blockReason: reason,
    decisions,
    analysis,
    signature: planSignature(originalQuery, canonicalQuery, analysis, decisions, mode),
  });
};

export class QueryRewriteRuntimeV8 {
  readonly #lexicon: TermLexiconRuntimeV8;
  readonly #policy: NormalizedPolicyV8;
  readonly #stats: MutableStatsV8 = {
    plans: 0,
    eligiblePlans: 0,
    changedPlans: 0,
    acceptedCorrections: 0,
    rejectedLowConfidence: 0,
    rejectedAmbiguous: 0,
    blockedSyntax: 0,
    blockedBudget: 0,
  };

  constructor(
    lexicon: TermLexiconRuntimeV8,
    policy: QueryRewritePolicyV8 = {},
  ) {
    this.#lexicon = lexicon;
    this.#policy = normalizePolicy(policy);
  }

  plan(input: unknown): QueryRewritePlanV8 {
    const originalQuery = input === null || input === undefined ? '' : String(input);
    const analysis = analyzeTextQuery(originalQuery, this.#policy.analyzer);
    this.#stats.plans += 1;
    if (this.#policy.mode === 'disabled') {
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'disabled');
    }
    if (analysis.diagnostics.empty) {
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'empty-query');
    }
    if (analysis.diagnostics.truncated) {
      this.#stats.blockedBudget += 1;
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'query-truncated');
    }
    if (analysis.diagnostics.malformedQuotes) {
      this.#stats.blockedSyntax += 1;
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'malformed-quotes');
    }
    if (syntaxSensitive(analysis)) {
      this.#stats.blockedSyntax += 1;
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'syntax-sensitive');
    }
    const tokens = tokenizeSearchText(analysis.boundedRaw);
    if (tokens.length > this.#policy.maximumTerms) {
      this.#stats.blockedBudget += 1;
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'term-budget-exceeded');
    }
    const decisions = decisionsForTokens(this.#lexicon, tokens, this.#policy);
    const corrections = acceptedCount(decisions);
    if (corrections === 0) {
      if (hasAmbiguousMiss(decisions)) {
        this.#stats.rejectedAmbiguous += 1;
        return blockedPlan(this.#policy.mode, originalQuery, analysis, 'ambiguous-correction', decisions);
      }
      if (hasLowConfidenceMiss(decisions, this.#policy)) {
        this.#stats.rejectedLowConfidence += 1;
        return blockedPlan(this.#policy.mode, originalQuery, analysis, 'low-confidence', decisions);
      }
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'no-misspellings', decisions);
    }
    if (corrections > this.#policy.maximumCorrections) {
      this.#stats.blockedBudget += 1;
      return blockedPlan(this.#policy.mode, originalQuery, analysis, 'correction-budget-exceeded', decisions);
    }
    const rewrittenQuery = rewrittenTokens(decisions).join(' ').trim();
    const changed = Boolean(rewrittenQuery && rewrittenQuery !== analysis.normalized);
    this.#stats.eligiblePlans += 1;
    if (changed) {
      this.#stats.changedPlans += 1;
      this.#stats.acceptedCorrections += corrections;
    }
    return Object.freeze({
      version: VERSION,
      mode: this.#policy.mode,
      eligible: true,
      originalQuery,
      canonicalQuery: analysis.normalized,
      rewrittenQuery,
      changed,
      correctionCount: corrections,
      blockReason: null,
      decisions,
      analysis,
      signature: planSignature(originalQuery, rewrittenQuery, analysis, decisions, this.#policy.mode),
    });
  }

  snapshot(): QueryRewriteSnapshotV8 {
    return Object.freeze({
      version: VERSION,
      plans: this.#stats.plans,
      eligiblePlans: this.#stats.eligiblePlans,
      changedPlans: this.#stats.changedPlans,
      acceptedCorrections: this.#stats.acceptedCorrections,
      rejectedLowConfidence: this.#stats.rejectedLowConfidence,
      rejectedAmbiguous: this.#stats.rejectedAmbiguous,
      blockedSyntax: this.#stats.blockedSyntax,
      blockedBudget: this.#stats.blockedBudget,
    });
  }
}

export const createQueryRewriteRuntimeV8 = (
  lexicon: TermLexiconRuntimeV8,
  policy: QueryRewritePolicyV8 = {},
): QueryRewriteRuntimeV8 => new QueryRewriteRuntimeV8(lexicon, policy);
