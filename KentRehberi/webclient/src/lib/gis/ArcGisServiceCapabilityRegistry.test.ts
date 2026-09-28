import { describe, expect, it } from 'vitest';
import {
  ArcGisServiceCapabilityRegistry,
  type ArcGisServiceCapabilityRegistryPolicy,
  type ArcGisServiceCapabilitySnapshot,
} from './ArcGisServiceCapabilityRegistry';

const policy: ArcGisServiceCapabilityRegistryPolicy = {
  maxServices: 3,
  maxServiceKeyLength: 64,
  maxRevisionLength: 40,
  maxCapabilities: 14,
  maxQueryFormats: 3,
  maxLayerIds: 8,
  maxTableIds: 4,
  maxRecordCount: 20_000,
  retentionMs: 10_000,
  maxClockSkewMs: 50,
};

const make = () => new ArcGisServiceCapabilityRegistry(policy);

const metadata = (
  serviceKey: string,
  observedAtMs = 100,
  overrides: Partial<ArcGisServiceCapabilitySnapshot> = {},
): ArcGisServiceCapabilitySnapshot => ({
  serviceKey,
  serviceKind: 'feature',
  revision: 'rev-1',
  observedAtMs,
  currentVersion: 11.3,
  maxRecordCount: 2_000,
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  capabilities: ['editing', 'order-by', 'pagination', 'query', 'statistics', 'sync', 'time'],
  queryFormats: ['geojson', 'json', 'pbf'],
  layerIds: [0, 2, 4],
  tableIds: [7],
  supportsPagination: true,
  supportsOrderBy: true,
  supportsStatistics: true,
  supportsEditing: true,
  supportsSync: true,
  timeAware: true,
  ...overrides,
});

describe('ArcGisServiceCapabilityRegistry', () => {
  it('normalizes verified service metadata into deterministic immutable snapshots', () => {
    const registry = make();
    const result = registry.observe(metadata('parcels', 100, {
      capabilities: ['time', 'query', 'editing', 'pagination', 'statistics', 'order-by', 'sync'],
      queryFormats: ['pbf', 'json', 'geojson'],
      layerIds: [4, 0, 2],
    }));

    expect(result.status).toBe('inserted');
    expect(result.compatible).toBe(true);
    expect(result.entry.metadata.capabilities).toEqual(['editing', 'order-by', 'pagination', 'query', 'statistics', 'sync', 'time']);
    expect(result.entry.metadata.queryFormats).toEqual(['geojson', 'json', 'pbf']);
    expect(result.entry.metadata.layerIds).toEqual([0, 2, 4]);
    expect(Object.isFrozen(result.entry)).toBe(true);
    expect(Object.isFrozen(result.entry.metadata)).toBe(true);
    expect(Object.isFrozen(result.entry.metadata.layerIds)).toBe(true);
  });

  it('reports unchanged metadata without advancing service sequence', () => {
    const registry = make();
    const first = registry.observe(metadata('roads', 100));
    const second = registry.observe(metadata('roads', 150));
    expect(second.status).toBe('unchanged');
    expect(second.entry.sequence).toBe(first.entry.sequence);
    expect(second.generation).toBe(first.generation);
    expect(second.entry.lastAccessedAtMs).toBe(150);
  });

  it('detects capability shrink and lower ArcGIS maxRecordCount as breaking changes', () => {
    const registry = make();
    registry.observe(metadata('roads', 100));
    const result = registry.observe(metadata('roads', 200, {
      revision: 'rev-2',
      maxRecordCount: 500,
      capabilities: ['query', 'time'],
      queryFormats: ['json'],
      layerIds: [0, 2],
      tableIds: [],
      supportsPagination: false,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsEditing: false,
      supportsSync: false,
    }));

    expect(result.status).toBe('updated');
    expect(result.compatible).toBe(false);
    expect(result.breakingChanges).toEqual(expect.arrayContaining([
      'max-record-count-decreased',
      'pagination-disabled',
      'order-by-disabled',
      'statistics-disabled',
      'editing-disabled',
      'sync-disabled',
      'capability-removed:editing',
      'query-format-removed:geojson',
      'layer-removed:4',
      'table-removed:7',
    ]));
  });

  it('rejects service-kind identity rebinding unless explicitly approved', () => {
    const registry = make();
    registry.observe(metadata('city', 100));
    const rebound = metadata('city', 200, { serviceKind: 'map', revision: 'rev-2' });
    expect(() => registry.observe(rebound)).toThrow('identity rebind requires explicit approval');
    const accepted = registry.observe(rebound, { allowIdentityRebind: true });
    expect(accepted.breakingChanges).toContain('service-kind-changed');
  });

  it('rejects spatial-reference rebinding unless explicitly approved', () => {
    const registry = make();
    registry.observe(metadata('city', 100));
    const rebound = metadata('city', 200, {
      revision: 'rev-2',
      spatialReference: { wkid: 4326, latestWkid: null },
    });
    expect(() => registry.observe(rebound)).toThrow('identity rebind requires explicit approval');
    const accepted = registry.observe(rebound, { allowIdentityRebind: true });
    expect(accepted.breakingChanges).toContain('spatial-reference-changed');
  });

  it('accepts additive capability expansion without a breaking change', () => {
    const registry = make();
    registry.observe(metadata('readonly', 100, {
      capabilities: ['query'],
      queryFormats: ['json'],
      supportsPagination: false,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsEditing: false,
      supportsSync: false,
      timeAware: false,
    }));
    const result = registry.observe(metadata('readonly', 150, {
      revision: 'rev-2',
      capabilities: ['order-by', 'pagination', 'query', 'statistics'],
      queryFormats: ['geojson', 'json'],
      supportsPagination: true,
      supportsOrderBy: true,
      supportsStatistics: true,
      supportsEditing: false,
      supportsSync: false,
      timeAware: false,
    }));
    expect(result.compatible).toBe(true);
    expect(result.breakingChanges).toEqual([]);
  });

  it('rejects stale observations for an existing service', () => {
    const registry = make();
    registry.observe(metadata('roads', 200));
    expect(() => registry.observe(metadata('roads', 199, { revision: 'rev-2' }))).toThrow('stale service metadata observation');
  });

  it('rejects duplicate capabilities, formats and ArcGIS layer identities', () => {
    const registry = make();
    expect(() => registry.observe(metadata('a', 100, { capabilities: ['query', 'query'] }))).toThrow('duplicate service capability');
    expect(() => registry.observe(metadata('a', 100, { queryFormats: ['json', 'json'] }))).toThrow('duplicate query format');
    expect(() => registry.observe(metadata('a', 100, { layerIds: [1, 1] }))).toThrow('duplicate layer IDs');
    expect(() => registry.observe(metadata('a', 100, { tableIds: [7, 7] }))).toThrow('duplicate table IDs');
  });

  it('rejects cross-boundary layer/table ID aliasing', () => {
    const registry = make();
    expect(() => registry.observe(metadata('a', 100, { layerIds: [0, 7], tableIds: [7] }))).toThrow('layer and table IDs must be disjoint');
  });

  it('requires query capability for query-derived service flags and formats', () => {
    const registry = make();
    expect(() => registry.observe(metadata('a', 100, {
      capabilities: ['time'],
      queryFormats: [],
      supportsPagination: true,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsEditing: false,
      supportsSync: false,
    }))).toThrow('pagination requires query capability');
    expect(() => registry.observe(metadata('b', 100, {
      capabilities: ['time'],
      queryFormats: ['json'],
      supportsPagination: false,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsEditing: false,
      supportsSync: false,
    }))).toThrow('query formats require query capability');
  });

  it('requires matching editing, sync and time capabilities for advertised flags', () => {
    const registry = make();
    expect(() => registry.observe(metadata('edit', 100, { capabilities: ['query'], supportsEditing: true, supportsSync: false, timeAware: false }))).toThrow('editing flag requires editing capability');
    expect(() => registry.observe(metadata('sync', 100, { capabilities: ['query'], supportsEditing: false, supportsSync: true, timeAware: false }))).toThrow('sync flag requires sync capability');
    expect(() => registry.observe(metadata('time', 100, { capabilities: ['query'], supportsEditing: false, supportsSync: false, timeAware: true }))).toThrow('time-aware flag requires time capability');
  });

  it('enforces configured count and maxRecordCount budgets', () => {
    const registry = new ArcGisServiceCapabilityRegistry({ ...policy, maxLayerIds: 2, maxTableIds: 1, maxCapabilities: 2, maxQueryFormats: 1, maxRecordCount: 1_000 });
    expect(() => registry.observe(metadata('layers', 100, { layerIds: [0, 1, 2] }))).toThrow('layer IDs exceed registry policy');
    expect(() => registry.observe(metadata('tables', 100, { tableIds: [5, 6] }))).toThrow('table IDs exceed registry policy');
    expect(() => registry.observe(metadata('caps', 100))).toThrow('capability count exceeds registry policy');
    expect(() => registry.observe(metadata('limit', 100, { maxRecordCount: 1_001, capabilities: ['query'], queryFormats: ['json'], layerIds: [], tableIds: [], supportsPagination: false, supportsOrderBy: false, supportsStatistics: false, supportsEditing: false, supportsSync: false, timeAware: false }))).toThrow('maxRecordCount exceeds registry policy');
  });

  it('bounds service capacity with deterministic least-recently-accessed eviction', () => {
    const registry = make();
    registry.observe(metadata('b', 100));
    registry.observe(metadata('a', 100));
    registry.observe(metadata('c', 100));
    expect(registry.get('b', 120)).not.toBeNull();
    registry.observe(metadata('d', 130));
    expect(registry.get('a', 130)).toBeNull();
    expect(registry.get('b', 130)).not.toBeNull();
    expect(registry.snapshot(130).entries.map((entry) => entry.metadata.serviceKey)).toEqual(['b', 'c', 'd']);
  });

  it('prunes metadata after the bounded retention horizon', () => {
    const registry = make();
    registry.observe(metadata('a', 100));
    expect(registry.prune(10_100)).toBe(0);
    expect(registry.prune(10_101)).toBe(1);
    expect(registry.get('a', 10_101)).toBeNull();
  });

  it('expires a single get after retention without leaking stale service metadata', () => {
    const registry = make();
    registry.observe(metadata('a', 100));
    expect(registry.get('a', 10_101)).toBeNull();
    expect(registry.snapshot(10_101).entries).toHaveLength(0);
  });

  it('invalidates a single service without disturbing other metadata', () => {
    const registry = make();
    registry.observe(metadata('a', 100));
    registry.observe(metadata('b', 100));
    expect(registry.invalidate('a')).toBe(true);
    expect(registry.invalidate('a')).toBe(false);
    expect(registry.get('b', 100)?.metadata.serviceKey).toBe('b');
  });

  it('restores a valid snapshot atomically and preserves deterministic ordering', () => {
    const source = make();
    source.observe(metadata('z', 100));
    source.observe(metadata('a', 110));
    const snapshot = source.snapshot(120);
    const target = make();
    target.restore(snapshot, 120);
    expect(target.snapshot(120).entries.map((entry) => entry.metadata.serviceKey)).toEqual(['a', 'z']);
    expect(target.get('a', 120)?.metadata.layerIds).toEqual([0, 2, 4]);
  });

  it('rejects duplicate restore identities without mutating current state', () => {
    const registry = make();
    registry.observe(metadata('safe', 100));
    const before = registry.snapshot(100);
    const entry = before.entries[0]!;
    expect(() => registry.restore({ entries: [entry, entry] }, 100)).toThrow('duplicate service metadata entry');
    expect(registry.snapshot(100).entries).toEqual(before.entries);
  });

  it('rejects future and inverted restore chronology', () => {
    const registry = make();
    const source = make();
    source.observe(metadata('a', 200));
    const future = source.snapshot(200).entries[0]!;
    expect(() => registry.restore({ entries: [future] }, 100)).toThrow('future service metadata timestamp');

    const normal = make();
    normal.observe(metadata('b', 100));
    const entry = normal.snapshot(100).entries[0]!;
    expect(() => registry.restore({ entries: [{ ...entry, lastAccessedAtMs: 99 }] }, 100)).toThrow('invalid service metadata chronology');
  });

  it('rejects malformed service identities, revisions, service kinds and spatial references', () => {
    const registry = make();
    expect(() => registry.observe(metadata('\0bad', 100))).toThrow();
    expect(() => registry.observe(metadata('a', 100, { revision: ' ' }))).toThrow();
    expect(() => registry.observe(metadata('a', 100, { serviceKind: 'wfs' as never }))).toThrow('unsupported ArcGIS REST service kind');
    expect(() => registry.observe(metadata('a', 100, { spatialReference: { wkid: 0, latestWkid: null } }))).toThrow();
  });

  it('rejects unsupported capabilities and query formats fail-closed', () => {
    const registry = make();
    expect(() => registry.observe(metadata('a', 100, { capabilities: ['query', 'wfs' as never] }))).toThrow('unsupported ArcGIS service capability');
    expect(() => registry.observe(metadata('a', 100, { queryFormats: ['json', 'xml' as never] }))).toThrow('unsupported ArcGIS query format');
  });

  it('rejects invalid versions, unsafe IDs and stale registry clocks', () => {
    const registry = make();
    expect(() => registry.observe(metadata('a', 100, { currentVersion: Number.NaN }))).toThrow();
    expect(() => registry.observe(metadata('a', 100, { currentVersion: 101 }))).toThrow('currentVersion outside configured bounds');
    expect(() => registry.observe(metadata('a', 100, { layerIds: [Number.MAX_SAFE_INTEGER + 1] }))).toThrow();
    registry.observe(metadata('clock', 200));
    expect(() => registry.snapshot(100)).toThrow('stale service metadata clock');
  });

  it('does not expose mutable aliases from caller-owned arrays', () => {
    const registry = make();
    const layerIds = [0, 2];
    const capabilities: ArcGisServiceCapabilitySnapshot['capabilities'] = ['query'];
    registry.observe(metadata('safe', 100, {
      layerIds,
      capabilities,
      queryFormats: ['json'],
      tableIds: [],
      supportsPagination: false,
      supportsOrderBy: false,
      supportsStatistics: false,
      supportsEditing: false,
      supportsSync: false,
      timeAware: false,
    }));
    layerIds.push(99);
    expect(registry.get('safe', 100)?.metadata.layerIds).toEqual([0, 2]);
  });

  it('disposes idempotently and rejects later use', () => {
    const registry = make();
    registry.observe(metadata('a', 100));
    registry.dispose();
    registry.dispose();
    expect(() => registry.snapshot(100)).toThrow('disposed');
  });
});
