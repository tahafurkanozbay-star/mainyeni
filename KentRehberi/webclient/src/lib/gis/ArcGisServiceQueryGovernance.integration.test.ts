import { describe, expect, it } from 'vitest';
import { ArcGisQueryCompletenessPolicy } from './ArcGisQueryCompletenessPolicy';
import { ArcGisServicePaginationCoordinator } from './ArcGisServicePaginationCoordinator';
import { ArcGisServiceQueryIntegrityCoordinator } from './ArcGisServiceQueryIntegrityCoordinator';

const pagination = () => new ArcGisServicePaginationCoordinator({
  maxSessions: 2,
  maxSessionsPerService: 2,
  maxServiceKeyLength: 32,
  maxSessionKeyLength: 32,
  maxPages: 3,
  maxFeatures: 5,
  maxBytes: 1_000,
  maxPageSize: 3,
  maxDurationMs: 100,
  terminalRetentionMs: 20,
  maxClockSkewMs: 2,
});

const integrity = () => new ArcGisServiceQueryIntegrityCoordinator({
  maxSessions: 2,
  maxSessionsPerService: 2,
  maxServiceKeyLength: 32,
  maxSessionKeyLength: 32,
  maxIdentityLength: 32,
  maxIdentitiesPerSession: 5,
  maxPagesPerSession: 3,
  maxDiagnosticsPerSession: 2,
  maxClockSkewMs: 2,
  terminalRetentionMs: 20,
});

const completeness = () => new ArcGisQueryCompletenessPolicy({
  maxExpectedFeatures: 5,
  maxPageSize: 3,
  requireObjectIdField: true,
  allowUnknownTransferLimit: false,
});

describe('ArcGIS query governance integration', () => {
  it('keeps traversal, identity integrity and completeness budgets aligned for a valid query', () => {
    const pages = pagination();
    const ids = integrity();
    const complete = completeness();
    pages.begin('parcels', 'q1', 1);
    ids.begin('parcels', 'q1', 1);

    const firstFacts = complete.evaluate({ featureCount: 3, requestedRecordCount: 3, hasMore: true, transferLimit: 'exceeded', objectIdField: 'OBJECTID', uniqueIdentityCount: 3 }, 0);
    expect(firstFacts.accepted).toBe(true);
    ids.recordPage({ serviceKey: 'parcels', sessionKey: 'q1', timestampMs: 2, page: 1, identities: [1, 2, 3], hasMore: true });
    pages.recordPage({ serviceKey: 'parcels', sessionKey: 'q1', timestampMs: 2, featureCount: 3, byteCount: 300, nextOffset: 3, hasMore: true });

    const secondFacts = complete.evaluate({ featureCount: 2, requestedRecordCount: 3, hasMore: false, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 2 }, firstFacts.observedFeatures);
    expect(secondFacts).toMatchObject({ accepted: true, terminal: true, observedFeatures: 5, remainingFeatureBudget: 0 });
    expect(ids.recordPage({ serviceKey: 'parcels', sessionKey: 'q1', timestampMs: 3, page: 2, identities: [4, 5], hasMore: false }).state).toBe('complete');
    expect(pages.recordPage({ serviceKey: 'parcels', sessionKey: 'q1', timestampMs: 3, featureCount: 2, byteCount: 200, nextOffset: 5, hasMore: false }).state).toBe('complete');
  });

  it('detects identity replay independently of pagination offset progress', () => {
    const pages = pagination();
    const ids = integrity();
    pages.begin('roads', 'q2', 1);
    ids.begin('roads', 'q2', 1);
    pages.recordPage({ serviceKey: 'roads', sessionKey: 'q2', timestampMs: 2, featureCount: 2, byteCount: 100, nextOffset: 2, hasMore: true });
    ids.recordPage({ serviceKey: 'roads', sessionKey: 'q2', timestampMs: 2, page: 1, identities: [10, 11], hasMore: true });
    expect(pages.recordPage({ serviceKey: 'roads', sessionKey: 'q2', timestampMs: 3, featureCount: 2, byteCount: 100, nextOffset: 4, hasMore: true }).state).toBe('active');
    const replay = ids.recordPage({ serviceKey: 'roads', sessionKey: 'q2', timestampMs: 3, page: 2, identities: [11, 12], hasMore: true });
    expect(replay.state).toBe('failed');
    expect(replay.diagnostics[0]?.code).toBe('duplicate-identity');
  });

  it('rejects contradictory transfer-limit metadata before advancing either state authority', () => {
    const pages = pagination();
    const ids = integrity();
    pages.begin('buildings', 'q3', 1);
    ids.begin('buildings', 'q3', 1);
    const decision = completeness().evaluate({ featureCount: 3, requestedRecordCount: 3, hasMore: true, transferLimit: 'clear', objectIdField: 'OBJECTID', uniqueIdentityCount: 3 }, 0);
    expect(decision).toMatchObject({ accepted: false, reason: 'contradictory-transfer-limit' });
    expect(pages.snapshot(2).sessions[0]).toMatchObject({ pages: 0, features: 0 });
    expect(ids.snapshot(2).sessions[0]).toMatchObject({ pages: 0, identities: [] });
  });
});
