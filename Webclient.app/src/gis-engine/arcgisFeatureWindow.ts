export interface FeatureWindowPage<T> {
  readonly features: readonly T[];
  readonly exceededTransferLimit: boolean;
  readonly nextOffset?: number;
}

export interface FeatureWindowOptions<T> {
  readonly pageSize: number;
  readonly maxFeatures: number;
  readonly maxPages: number;
  readonly identity: (feature: T) => string | number | undefined;
  readonly fetchPage: (offset: number, limit: number, signal: AbortSignal) => Promise<FeatureWindowPage<T>>;
}

export interface FeatureWindowResult<T> {
  readonly features: readonly T[];
  readonly pages: number;
  readonly complete: boolean;
  readonly duplicateCount: number;
  readonly truncated: boolean;
  readonly lastOffset: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The ArcGIS feature window was aborted.', 'AbortError');
}

/**
 * Reads a bounded ArcGIS feature window without guessing server capabilities.
 * The caller owns the verified ArcGIS transport/query contract; this runtime
 * only enforces progress, identity integrity, cancellation and memory bounds.
 */
export async function readArcgisFeatureWindow<T>(
  options: FeatureWindowOptions<T>,
  signal: AbortSignal,
): Promise<FeatureWindowResult<T>> {
  const pageSize = positiveInteger(options.pageSize, 'pageSize');
  const maxFeatures = positiveInteger(options.maxFeatures, 'maxFeatures');
  const maxPages = positiveInteger(options.maxPages, 'maxPages');
  const output: T[] = [];
  const identities = new Set<string>();
  let duplicateCount = 0;
  let offset = 0;
  let pages = 0;
  let complete = false;

  while (pages < maxPages && output.length < maxFeatures) {
    if (signal.aborted) throw abortError(signal.reason);
    const remaining = maxFeatures - output.length;
    const limit = Math.min(pageSize, remaining);
    const page = await options.fetchPage(offset, limit, signal);
    if (signal.aborted) throw abortError(signal.reason);
    pages += 1;

    for (const feature of page.features) {
      const rawIdentity = options.identity(feature);
      if (rawIdentity === undefined || rawIdentity === null || rawIdentity === '') {
        output.push(feature);
      } else {
        const identity = `${typeof rawIdentity}:${String(rawIdentity)}`;
        if (identities.has(identity)) {
          duplicateCount += 1;
          continue;
        }
        identities.add(identity);
        output.push(feature);
      }
      if (output.length >= maxFeatures) break;
    }

    if (!page.exceededTransferLimit) {
      complete = true;
      break;
    }

    const candidate = page.nextOffset ?? offset + page.features.length;
    if (!Number.isSafeInteger(candidate) || candidate <= offset) {
      throw new Error('ArcGIS pagination did not make forward progress.');
    }
    offset = candidate;
  }

  return Object.freeze({
    features: Object.freeze(output.slice()),
    pages,
    complete,
    duplicateCount,
    truncated: !complete,
    lastOffset: offset,
  });
}
