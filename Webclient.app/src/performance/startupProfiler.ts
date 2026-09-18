import { boundedInteger, finiteNumber, safeText } from './normalization';

export interface StartupPhase {
  readonly name: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly durationMs: number | null;
}

export interface StartupProfiler {
  readonly begin: (name: string, atMs?: unknown) => boolean;
  readonly end: (name: string, atMs?: unknown) => StartupPhase | null;
  readonly mark: (name: string, durationMs: unknown) => StartupPhase;
  readonly snapshot: () => readonly StartupPhase[];
  readonly clear: () => number;
}

interface MutablePhase {
  name: string;
  startedAtMs: number;
  completedAtMs: number | null;
}

export const createStartupProfiler = (
  maxPhasesValue: unknown = 64,
  now: () => number = () => performance.now(),
): StartupProfiler => {
  const maxPhases = boundedInteger(maxPhasesValue, 1, 512, 64);
  const phases = new Map<string, MutablePhase>();

  const trim = (): void => {
    while (phases.size > maxPhases) {
      const oldest = phases.keys().next().value;
      if (oldest === undefined) break;
      phases.delete(oldest);
    }
  };

  const toSnapshot = (phase: MutablePhase): StartupPhase => Object.freeze({
    name: phase.name,
    startedAtMs: phase.startedAtMs,
    completedAtMs: phase.completedAtMs,
    durationMs: phase.completedAtMs === null
      ? null
      : Math.max(0, phase.completedAtMs - phase.startedAtMs),
  });

  return Object.freeze({
    begin(rawName: string, atMs: unknown = now()) {
      const name = safeText(rawName, 120);
      if (!name || phases.has(name)) return false;
      phases.set(name, {
        name,
        startedAtMs: Math.max(0, finiteNumber(atMs, now()) ?? now()),
        completedAtMs: null,
      });
      trim();
      return true;
    },

    end(rawName: string, atMs: unknown = now()) {
      const name = safeText(rawName, 120);
      const phase = phases.get(name);
      if (!phase) return null;
      phase.completedAtMs = Math.max(
        phase.startedAtMs,
        finiteNumber(atMs, now()) ?? now(),
      );
      return toSnapshot(phase);
    },

    mark(rawName: string, durationMs: unknown) {
      const name = safeText(rawName, 120) || 'anonymous';
      const duration = Math.max(0, finiteNumber(durationMs, 0) ?? 0);
      const completedAtMs = now();
      const phase: MutablePhase = {
        name,
        startedAtMs: Math.max(0, completedAtMs - duration),
        completedAtMs,
      };
      phases.set(name, phase);
      trim();
      return toSnapshot(phase);
    },

    snapshot: () => Object.freeze(
      Array.from(phases.values())
        .map(toSnapshot)
        .sort((left, right) => left.startedAtMs - right.startedAtMs),
    ),

    clear() {
      const count = phases.size;
      phases.clear();
      return count;
    },
  });
};

export const startupProfiler = createStartupProfiler();
