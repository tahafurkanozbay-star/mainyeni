import type { OfflineReplayCandidate, OfflineReplayDecision } from './offlineReplayPolicy';
import { OfflineReplayPolicy } from './offlineReplayPolicy';

export interface OfflineReplayBatchOptions {
  readonly policy: OfflineReplayPolicy;
  readonly maxCandidates?: number;
  readonly maxAllowed?: number;
}

export interface OfflineReplayBatchResult {
  readonly decisions: readonly Readonly<OfflineReplayDecision>[];
  readonly allowedIndexes: readonly number[];
  readonly rejectedIndexes: readonly number[];
  readonly truncated: boolean;
}

const bounded = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
};

/**
 * Applies replay admission to a bounded queue window without allocating work
 * for an unbounded durable snapshot. The result contains indexes only; payloads,
 * URLs and headers are intentionally excluded from diagnostics.
 */
export class OfflineReplayBatch {
  readonly #policy: OfflineReplayPolicy;
  readonly maxCandidates: number;
  readonly maxAllowed: number;

  constructor(options: OfflineReplayBatchOptions) {
    if (!options?.policy) throw new TypeError('policy is required');
    this.#policy = options.policy;
    this.maxCandidates = bounded('maxCandidates', options.maxCandidates ?? 256, 1, 4096);
    this.maxAllowed = bounded('maxAllowed', options.maxAllowed ?? this.maxCandidates, 1, this.maxCandidates);
  }

  evaluate(candidates: readonly OfflineReplayCandidate[]): Readonly<OfflineReplayBatchResult> {
    if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
    const count = Math.min(candidates.length, this.maxCandidates);
    const decisions: Readonly<OfflineReplayDecision>[] = [];
    const allowedIndexes: number[] = [];
    const rejectedIndexes: number[] = [];

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      if (allowedIndexes.length >= this.maxAllowed) {
        rejectedIndexes.push(index);
        continue;
      }
      const decision = this.#policy.evaluate(candidate);
      decisions.push(decision);
      if (decision.allowed) allowedIndexes.push(index);
      else rejectedIndexes.push(index);
    }

    return Object.freeze({
      decisions: Object.freeze(decisions),
      allowedIndexes: Object.freeze(allowedIndexes),
      rejectedIndexes: Object.freeze(rejectedIndexes),
      truncated: candidates.length > count || allowedIndexes.length >= this.maxAllowed && count < candidates.length,
    });
  }
}
