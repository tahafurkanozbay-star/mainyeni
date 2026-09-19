import { cacheInteger, cacheKey, cacheNamespace } from './cacheContracts';
import {
  evaluateCachePressure,
  type CachePressureDecision,
  type CachePressureInput,
} from './cachePressurePolicy';

export interface CacheWarmupCandidate {
  readonly key: string;
  readonly namespace: string;
  readonly estimatedBytes: number;
  readonly expectedReuse: number;
  readonly loadCost: number;
  readonly priority?: number;
}

export interface CacheWarmupPlannerOptions {
  readonly maxCandidates?: number;
  readonly maxSelected?: number;
  readonly maxWarmupBytes?: number;
  readonly maxPerNamespace?: number;
}

export interface CacheWarmupPlan {
  readonly pressure: CachePressureDecision;
  readonly selected: readonly CacheWarmupCandidate[];
  readonly rejected: number;
  readonly estimatedBytes: number;
  readonly suppressed: boolean;
}

interface RankedCandidate {
  readonly candidate: CacheWarmupCandidate;
  readonly score: number;
}

export class CacheWarmupPlanner {
  readonly #maxCandidates: number;
  readonly #maxSelected: number;
  readonly #maxWarmupBytes: number;
  readonly #maxPerNamespace: number;

  constructor(options: CacheWarmupPlannerOptions = {}) {
    this.#maxCandidates = cacheInteger('maxCandidates', options.maxCandidates ?? 256, 1, 10000);
    this.#maxSelected = cacheInteger('maxSelected', options.maxSelected ?? 32, 1, 1024);
    this.#maxWarmupBytes = cacheInteger(
      'maxWarmupBytes',
      options.maxWarmupBytes ?? 8388608,
      1,
      268435456,
    );
    this.#maxPerNamespace = cacheInteger(
      'maxPerNamespace',
      options.maxPerNamespace ?? Math.min(8, this.#maxSelected),
      1,
      this.#maxSelected,
    );
  }

  plan(
    pressureInput: CachePressureInput,
    candidates: readonly CacheWarmupCandidate[],
  ): CacheWarmupPlan {
    if (candidates.length > this.#maxCandidates) {
      throw new RangeError('cache warmup candidate capacity exceeded');
    }
    const pressure = evaluateCachePressure(pressureInput);
    if (pressure.suppressWarmup) {
      return Object.freeze({
        pressure,
        selected: Object.freeze([]),
        rejected: candidates.length,
        estimatedBytes: 0,
        suppressed: true,
      });
    }

    const ranked = candidates.map((candidate) => this.#rank(candidate));
    ranked.sort((left, right) =>
      right.score - left.score
      || (right.candidate.priority ?? 0) - (left.candidate.priority ?? 0)
      || left.candidate.key.localeCompare(right.candidate.key));

    const selected: CacheWarmupCandidate[] = [];
    const namespaces = new Map<string, number>();
    const seen = new Set<string>();
    let bytes = 0;
    let rejected = 0;

    for (const item of ranked) {
      if (selected.length >= this.#maxSelected) {
        rejected += 1;
        continue;
      }
      const identity = item.candidate.namespace + '|' + item.candidate.key;
      if (seen.has(identity)) {
        rejected += 1;
        continue;
      }
      const namespaceCount = namespaces.get(item.candidate.namespace) ?? 0;
      if (namespaceCount >= this.#maxPerNamespace) {
        rejected += 1;
        continue;
      }
      if (bytes + item.candidate.estimatedBytes > this.#maxWarmupBytes) {
        rejected += 1;
        continue;
      }
      seen.add(identity);
      selected.push(item.candidate);
      namespaces.set(item.candidate.namespace, namespaceCount + 1);
      bytes += item.candidate.estimatedBytes;
    }

    return Object.freeze({
      pressure,
      selected: Object.freeze([...selected]),
      rejected,
      estimatedBytes: bytes,
      suppressed: false,
    });
  }

  #rank(candidate: CacheWarmupCandidate): RankedCandidate {
    const key = cacheKey(candidate.key);
    const namespace = cacheNamespace(candidate.namespace);
    const estimatedBytes = positiveInteger('estimatedBytes', candidate.estimatedBytes, 268435456);
    const expectedReuse = boundedRatio('expectedReuse', candidate.expectedReuse);
    const loadCost = boundedRatio('loadCost', candidate.loadCost);
    const priority = candidate.priority ?? 0;
    if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
      throw new RangeError('priority must be between -100 and 100');
    }

    const normalized: CacheWarmupCandidate = Object.freeze({
      key,
      namespace,
      estimatedBytes,
      expectedReuse,
      loadCost,
      priority,
    });
    const sizePenalty = Math.log2(Math.max(2, estimatedBytes)) / 32;
    const score = (expectedReuse * 0.65) + (loadCost * 0.25) + (priority / 1000) - sizePenalty;
    return Object.freeze({ candidate: normalized, score });
  }
}

const boundedRatio = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(name + ' must be between 0 and 1');
  }
  return value;
};

const positiveInteger = (name: string, value: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(name + ' must be between 1 and ' + maximum);
  }
  return value;
};
