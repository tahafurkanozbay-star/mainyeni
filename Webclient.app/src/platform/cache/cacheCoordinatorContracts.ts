import type { CachePolicyInput } from './cachePolicy';
import type { CacheKeyRequest } from './cacheKey';

export interface CacheLoadContext {
  readonly signal: AbortSignal;
  readonly key: string;
  readonly namespace: string;
}

export interface CacheReadThroughRequest<T> {
  readonly key: CacheKeyRequest;
  readonly policy: CachePolicyInput;
  readonly signal?: AbortSignal;
  readonly tags?: readonly string[];
  readonly byteSize?: number;
  readonly loader: (context: CacheLoadContext) => Promise<T>;
}

export type CacheResolutionSource =
  | 'fresh-cache'
  | 'stale-cache'
  | 'shared-loader'
  | 'network-only';

export type CacheRevalidationOutcome =
  | Readonly<{ status: 'updated'; cached: boolean }>
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'failed'; errorName: string }>;

export interface CacheResolution<T> {
  readonly value: T;
  readonly source: CacheResolutionSource;
  readonly cached: boolean;
  readonly key: string;
  readonly revalidation?: Promise<CacheRevalidationOutcome>;
  readonly cacheWriteIssue?: string;
}

export interface CacheCoordinatorSnapshot {
  readonly reads: number;
  readonly freshHits: number;
  readonly staleHits: number;
  readonly misses: number;
  readonly networkOnly: number;
  readonly loads: number;
  readonly sharedLoads: number;
  readonly writes: number;
  readonly writeIssues: number;
  readonly revalidationFailures: number;
  readonly invalidatedWrites: number;
}
