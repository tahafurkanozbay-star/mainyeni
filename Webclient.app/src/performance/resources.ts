import type {
  ResourceCategory,
  ResourceTimingDependencies,
  ResourceTimingSample,
  ResourceTimingSummary,
} from './contracts';
import {
  classifyResourceCategory,
  classifyResourceOrigin,
  isRenderBlockingResource,
  nonNegativeNumber,
  safeRatio,
  stableUnique,
} from './normalization';
import { summarizeNumbers } from './statistics';

const EMPTY_CATEGORY_COUNTS: Readonly<Record<ResourceCategory, number>> = Object.freeze({
  script: 0,
  style: 0,
  image: 0,
  font: 0,
  fetch: 0,
  xmlhttprequest: 0,
  navigation: 0,
  worker: 0,
  other: 0,
});

const isResourceTiming = (entry: PerformanceEntry): entry is PerformanceResourceTiming =>
  typeof (entry as PerformanceResourceTiming).initiatorType === 'string';

const locationOrigin = (): string | null => {
  try {
    return typeof location !== 'undefined' ? location.origin : null;
  } catch {
    return null;
  }
};

export const normalizeResourceTiming = (
  entry: PerformanceEntry,
  currentOrigin: string | null,
): ResourceTimingSample | null => {
  if (!isResourceTiming(entry)) return null;
  const category = classifyResourceCategory(entry.initiatorType);
  const origin = classifyResourceOrigin(entry.name, currentOrigin);
  const transferBytes = nonNegativeNumber(entry.transferSize, 0);
  const encodedBytes = nonNegativeNumber(entry.encodedBodySize, 0);
  const decodedBytes = nonNegativeNumber(entry.decodedBodySize, 0);

  return Object.freeze({
    category,
    originKind: origin.kind,
    origin: origin.origin,
    durationMs: nonNegativeNumber(entry.duration, 0),
    transferBytes,
    encodedBytes,
    decodedBytes,
    cacheLike: transferBytes === 0 && decodedBytes > 0,
    renderBlocking: isRenderBlockingResource(category, entry.initiatorType),
  });
};

export const summarizeResourceTimings = (
  samples: readonly ResourceTimingSample[],
): ResourceTimingSummary => {
  const categoryCounts: Record<ResourceCategory, number> = { ...EMPTY_CATEGORY_COUNTS };
  let sameOriginCount = 0;
  let crossOriginCount = 0;
  let opaqueCount = 0;
  let transferBytes = 0;
  let encodedBytes = 0;
  let decodedBytes = 0;
  let cacheLikeCount = 0;
  let renderBlockingCount = 0;
  const durations: number[] = [];
  const transfers: number[] = [];
  const origins: string[] = [];

  for (const sample of samples) {
    categoryCounts[sample.category] += 1;
    if (sample.originKind === 'same-origin') sameOriginCount += 1;
    else if (sample.originKind === 'cross-origin') crossOriginCount += 1;
    else if (sample.originKind === 'opaque') opaqueCount += 1;

    transferBytes += sample.transferBytes;
    encodedBytes += sample.encodedBytes;
    decodedBytes += sample.decodedBytes;
    if (sample.cacheLike) cacheLikeCount += 1;
    if (sample.renderBlocking) renderBlockingCount += 1;
    durations.push(sample.durationMs);
    transfers.push(sample.transferBytes);
    if (sample.originKind === 'cross-origin' && sample.origin) origins.push(sample.origin);
  }

  return Object.freeze({
    count: samples.length,
    sameOriginCount,
    crossOriginCount,
    opaqueCount,
    transferBytes,
    encodedBytes,
    decodedBytes,
    cacheLikeCount,
    cacheLikeRatio: samples.length > 0 ? safeRatio(cacheLikeCount, samples.length) : null,
    renderBlockingCount,
    duration: summarizeNumbers(durations),
    transfer: summarizeNumbers(transfers),
    categoryCounts: Object.freeze(categoryCounts),
    crossOriginOrigins: Object.freeze(stableUnique(origins)),
  });
};

export const collectResourceTimings = (
  dependencies: ResourceTimingDependencies = {},
): ResourceTimingSummary => {
  const performanceRef = dependencies.performanceRef === undefined
    ? (typeof performance !== 'undefined' ? performance : null)
    : dependencies.performanceRef;
  const currentOrigin = dependencies.locationOrigin === undefined
    ? locationOrigin()
    : dependencies.locationOrigin;

  if (!performanceRef?.getEntriesByType) return summarizeResourceTimings([]);

  const samples = performanceRef
    .getEntriesByType('resource')
    .map(entry => normalizeResourceTiming(entry, currentOrigin ?? null))
    .filter((sample): sample is ResourceTimingSample => sample !== null);

  return summarizeResourceTimings(samples);
};
