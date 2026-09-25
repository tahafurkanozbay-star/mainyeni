export interface DependencyEvidenceLedgerPolicy {
  readonly maxDependencies: number;
  readonly maxEntriesPerDependency: number;
  readonly maxEvidenceAgeMs: number;
}

export interface DependencyEvidenceRecord {
  readonly dependency: string;
  readonly source: string;
  readonly sequence: number;
  readonly healthy: boolean;
  readonly observedAt: number;
}

export interface DependencyEvidenceSnapshot {
  readonly dependency: string;
  readonly latestSequence: number | undefined;
  readonly latestObservedAt: number | undefined;
  readonly entries: readonly DependencyEvidenceRecord[];
}

const DEFAULT_POLICY: DependencyEvidenceLedgerPolicy = {
  maxDependencies: 256,
  maxEntriesPerDependency: 64,
  maxEvidenceAgeMs: 300_000,
};

const positiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
};

const nonBlank = (value: string, name: string): void => {
  if (value.trim().length === 0) throw new Error(`${name} must not be blank`);
};

export class RuntimeDependencyEvidenceLedger {
  readonly #policy: DependencyEvidenceLedgerPolicy;
  readonly #entries = new Map<string, DependencyEvidenceRecord[]>();

  constructor(policy: Partial<DependencyEvidenceLedgerPolicy> = {}) {
    this.#policy = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(this.#policy.maxDependencies, 'maxDependencies');
    positiveInteger(this.#policy.maxEntriesPerDependency, 'maxEntriesPerDependency');
    positiveInteger(this.#policy.maxEvidenceAgeMs, 'maxEvidenceAgeMs');
  }

  append(record: DependencyEvidenceRecord): void {
    this.#validate(record);
    let entries = this.#entries.get(record.dependency);
    if (!entries) {
      if (this.#entries.size >= this.#policy.maxDependencies) throw new Error('dependency evidence capacity exceeded');
      entries = [];
      this.#entries.set(record.dependency, entries);
    }
    const latest = entries.at(-1);
    if (latest && record.sequence <= latest.sequence) throw new Error('dependency evidence sequence must increase');
    if (latest && record.observedAt < latest.observedAt) throw new Error('dependency evidence timestamp must be monotonic');
    entries.push({ ...record });
    if (entries.length > this.#policy.maxEntriesPerDependency) entries.splice(0, entries.length - this.#policy.maxEntriesPerDependency);
  }

  snapshot(dependency: string): DependencyEvidenceSnapshot | undefined {
    const entries = this.#entries.get(dependency);
    if (!entries) return undefined;
    const latest = entries.at(-1);
    return {
      dependency,
      latestSequence: latest?.sequence,
      latestObservedAt: latest?.observedAt,
      entries: entries.map((entry) => ({ ...entry })),
    };
  }

  fresh(dependency: string, evaluatedAt: number): readonly DependencyEvidenceRecord[] {
    nonBlank(dependency, 'dependency');
    if (!Number.isFinite(evaluatedAt)) throw new Error('evaluatedAt must be finite');
    const entries = this.#entries.get(dependency) ?? [];
    return entries.filter((entry) => {
      const age = evaluatedAt - entry.observedAt;
      return age >= 0 && age <= this.#policy.maxEvidenceAgeMs;
    }).map((entry) => ({ ...entry }));
  }

  remove(dependency: string): boolean {
    nonBlank(dependency, 'dependency');
    return this.#entries.delete(dependency);
  }

  dependencies(): readonly string[] {
    return [...this.#entries.keys()].sort();
  }

  #validate(record: DependencyEvidenceRecord): void {
    nonBlank(record.dependency, 'dependency');
    nonBlank(record.source, 'source');
    positiveInteger(record.sequence, 'sequence');
    if (!Number.isFinite(record.observedAt)) throw new Error('observedAt must be finite');
  }
}
