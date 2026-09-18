import type { PartialPerformanceBudget, PerformanceBudget } from './contracts';
import { boundedInteger, boundedNumber } from './normalization';

export const DEFAULT_PERFORMANCE_BUDGET: PerformanceBudget = Object.freeze({
  vitals: Object.freeze({
    lcpGoodMs: 2_500,
    lcpBlockMs: 4_000,
    clsGood: 0.1,
    clsBlock: 0.25,
    inpGoodMs: 200,
    inpBlockMs: 500,
    fcpWarningMs: 1_800,
    fcpBlockMs: 3_000,
    ttfbWarningMs: 800,
    ttfbBlockMs: 1_800,
  }),
  startup: Object.freeze({
    firstRenderWarningMs: 1_200,
    firstRenderBlockMs: 2_500,
    domContentLoadedWarningMs: 2_000,
    domContentLoadedBlockMs: 4_000,
    loadWarningMs: 4_000,
    loadBlockMs: 8_000,
  }),
  longTasks: Object.freeze({
    countWarning: 4,
    countBlock: 12,
    maxDurationWarningMs: 120,
    maxDurationBlockMs: 300,
    totalBlockingWarningMs: 300,
    totalBlockingBlockMs: 1_000,
  }),
  resources: Object.freeze({
    countWarning: 180,
    countBlock: 350,
    transferWarningBytes: 4 * 1024 * 1024,
    transferBlockBytes: 8 * 1024 * 1024,
    decodedWarningBytes: 16 * 1024 * 1024,
    decodedBlockBytes: 32 * 1024 * 1024,
    crossOriginWarningCount: 4,
    crossOriginBlockCount: 12,
    minimumCacheLikeRatio: 0,
  }),
  memory: Object.freeze({
    utilizationWarning: 0.7,
    utilizationBlock: 0.9,
    usedWarningBytes: 256 * 1024 * 1024,
    usedBlockBytes: 512 * 1024 * 1024,
  }),
  evidence: Object.freeze({
    minimumVitalSamples: 1,
    requireLcp: true,
    requireCls: true,
    requireInp: false,
  }),
});

const numeric = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => boundedNumber(value, minimum, maximum, fallback);

const integer = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => boundedInteger(value, minimum, maximum, fallback);

export const normalizePerformanceBudget = (
  input: PartialPerformanceBudget | null | undefined = {},
): PerformanceBudget => {
  const value = input ?? {};
  const vitals = value.vitals ?? {};
  const startup = value.startup ?? {};
  const longTasks = value.longTasks ?? {};
  const resources = value.resources ?? {};
  const memory = value.memory ?? {};
  const evidence = value.evidence ?? {};
  const defaults = DEFAULT_PERFORMANCE_BUDGET;

  const lcpGoodMs = numeric(vitals.lcpGoodMs, 250, 20_000, defaults.vitals.lcpGoodMs);
  const lcpBlockMs = Math.max(
    lcpGoodMs,
    numeric(vitals.lcpBlockMs, 250, 30_000, defaults.vitals.lcpBlockMs),
  );
  const clsGood = numeric(vitals.clsGood, 0, 2, defaults.vitals.clsGood);
  const clsBlock = Math.max(
    clsGood,
    numeric(vitals.clsBlock, 0, 4, defaults.vitals.clsBlock),
  );
  const inpGoodMs = numeric(vitals.inpGoodMs, 25, 5_000, defaults.vitals.inpGoodMs);
  const inpBlockMs = Math.max(
    inpGoodMs,
    numeric(vitals.inpBlockMs, 25, 10_000, defaults.vitals.inpBlockMs),
  );

  return Object.freeze({
    vitals: Object.freeze({
      lcpGoodMs,
      lcpBlockMs,
      clsGood,
      clsBlock,
      inpGoodMs,
      inpBlockMs,
      fcpWarningMs: numeric(vitals.fcpWarningMs, 100, 20_000, defaults.vitals.fcpWarningMs),
      fcpBlockMs: numeric(vitals.fcpBlockMs, 100, 30_000, defaults.vitals.fcpBlockMs),
      ttfbWarningMs: numeric(vitals.ttfbWarningMs, 50, 10_000, defaults.vitals.ttfbWarningMs),
      ttfbBlockMs: numeric(vitals.ttfbBlockMs, 50, 20_000, defaults.vitals.ttfbBlockMs),
    }),
    startup: Object.freeze({
      firstRenderWarningMs: numeric(
        startup.firstRenderWarningMs,
        50,
        20_000,
        defaults.startup.firstRenderWarningMs,
      ),
      firstRenderBlockMs: numeric(
        startup.firstRenderBlockMs,
        50,
        30_000,
        defaults.startup.firstRenderBlockMs,
      ),
      domContentLoadedWarningMs: numeric(
        startup.domContentLoadedWarningMs,
        100,
        30_000,
        defaults.startup.domContentLoadedWarningMs,
      ),
      domContentLoadedBlockMs: numeric(
        startup.domContentLoadedBlockMs,
        100,
        60_000,
        defaults.startup.domContentLoadedBlockMs,
      ),
      loadWarningMs: numeric(startup.loadWarningMs, 100, 60_000, defaults.startup.loadWarningMs),
      loadBlockMs: numeric(startup.loadBlockMs, 100, 120_000, defaults.startup.loadBlockMs),
    }),
    longTasks: Object.freeze({
      countWarning: integer(longTasks.countWarning, 0, 10_000, defaults.longTasks.countWarning),
      countBlock: integer(longTasks.countBlock, 0, 20_000, defaults.longTasks.countBlock),
      maxDurationWarningMs: numeric(
        longTasks.maxDurationWarningMs,
        50,
        10_000,
        defaults.longTasks.maxDurationWarningMs,
      ),
      maxDurationBlockMs: numeric(
        longTasks.maxDurationBlockMs,
        50,
        30_000,
        defaults.longTasks.maxDurationBlockMs,
      ),
      totalBlockingWarningMs: numeric(
        longTasks.totalBlockingWarningMs,
        0,
        60_000,
        defaults.longTasks.totalBlockingWarningMs,
      ),
      totalBlockingBlockMs: numeric(
        longTasks.totalBlockingBlockMs,
        0,
        120_000,
        defaults.longTasks.totalBlockingBlockMs,
      ),
    }),
    resources: Object.freeze({
      countWarning: integer(resources.countWarning, 0, 10_000, defaults.resources.countWarning),
      countBlock: integer(resources.countBlock, 0, 20_000, defaults.resources.countBlock),
      transferWarningBytes: integer(
        resources.transferWarningBytes,
        0,
        512 * 1024 * 1024,
        defaults.resources.transferWarningBytes,
      ),
      transferBlockBytes: integer(
        resources.transferBlockBytes,
        0,
        1024 * 1024 * 1024,
        defaults.resources.transferBlockBytes,
      ),
      decodedWarningBytes: integer(
        resources.decodedWarningBytes,
        0,
        1024 * 1024 * 1024,
        defaults.resources.decodedWarningBytes,
      ),
      decodedBlockBytes: integer(
        resources.decodedBlockBytes,
        0,
        2 * 1024 * 1024 * 1024,
        defaults.resources.decodedBlockBytes,
      ),
      crossOriginWarningCount: integer(
        resources.crossOriginWarningCount,
        0,
        1_000,
        defaults.resources.crossOriginWarningCount,
      ),
      crossOriginBlockCount: integer(
        resources.crossOriginBlockCount,
        0,
        2_000,
        defaults.resources.crossOriginBlockCount,
      ),
      minimumCacheLikeRatio: numeric(
        resources.minimumCacheLikeRatio,
        0,
        1,
        defaults.resources.minimumCacheLikeRatio,
      ),
    }),
    memory: Object.freeze({
      utilizationWarning: numeric(
        memory.utilizationWarning,
        0,
        1,
        defaults.memory.utilizationWarning,
      ),
      utilizationBlock: numeric(
        memory.utilizationBlock,
        0,
        1,
        defaults.memory.utilizationBlock,
      ),
      usedWarningBytes: integer(
        memory.usedWarningBytes,
        0,
        4 * 1024 * 1024 * 1024,
        defaults.memory.usedWarningBytes,
      ),
      usedBlockBytes: integer(
        memory.usedBlockBytes,
        0,
        8 * 1024 * 1024 * 1024,
        defaults.memory.usedBlockBytes,
      ),
    }),
    evidence: Object.freeze({
      minimumVitalSamples: integer(
        evidence.minimumVitalSamples,
        0,
        100,
        defaults.evidence.minimumVitalSamples,
      ),
      requireLcp: evidence.requireLcp ?? defaults.evidence.requireLcp,
      requireCls: evidence.requireCls ?? defaults.evidence.requireCls,
      requireInp: evidence.requireInp ?? defaults.evidence.requireInp,
    }),
  });
};
