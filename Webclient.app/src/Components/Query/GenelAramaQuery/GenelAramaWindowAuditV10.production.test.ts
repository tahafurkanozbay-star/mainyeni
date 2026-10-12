import { describe, expect, it } from 'vitest';
import { normalizeSearchCollection } from '../_Common/QuerySearchRuntime';
import type { GeneralSearchWindowSnapshotV10 } from './GenelAramaWindowContractsV10';
import {
  assertGeneralSearchWindowSnapshotV10,
  auditGeneralSearchWindowSnapshotV10,
} from './GenelAramaWindowAuditV10';
import { createGenelAramaWindowRuntimeV10 } from './GenelAramaWindowRuntimeV10';

const records = normalizeSearchCollection(Array.from({ length: 40 }, (_, index) => ({
  ObjectId: index + 1,
  Title: `Kayıt ${index + 1}`,
  Address: index % 2 === 0 ? 'Çankaya Ankara' : 'Altındağ Ankara',
  Category: index % 3 === 0 ? 'Park' : index % 3 === 1 ? 'Müze' : 'Kültür Merkezi',
  Type: index % 2 === 0 ? 'Açık Alan' : 'Kültür',
})));

const createRuntime = () => createGenelAramaWindowRuntimeV10(records, {
  renderWindowSize: 12,
  renderOverscan: 2,
  maxSelectedFacets: 4,
  maxFacetBuckets: 10,
});

const mutateSnapshot = (
  snapshot: GeneralSearchWindowSnapshotV10,
  patch: Partial<GeneralSearchWindowSnapshotV10>,
): GeneralSearchWindowSnapshotV10 => Object.freeze({ ...snapshot, ...patch });

describe('GenelAramaWindowAuditV10', () => {
  it('accepts a normal runtime snapshot', () => {
    const runtime = createRuntime();
    const audit = auditGeneralSearchWindowSnapshotV10(runtime.snapshot(), runtime.policy());
    expect(audit.valid).toBe(true);
    expect(audit.errors).toBe(0);
  });

  it('accepts a filtered and sorted snapshot', () => {
    const runtime = createRuntime();
    runtime.setRefinement('ankara');
    runtime.toggleFacet('category', 'Park');
    runtime.setSortMode('title');
    runtime.moveActive('next');
    const audit = auditGeneralSearchWindowSnapshotV10(runtime.snapshot(), runtime.policy());
    expect(audit.valid).toBe(true);
  });

  it('accepts a local-empty snapshot', () => {
    const runtime = createRuntime();
    runtime.setRefinement('bulunamaz');
    const audit = auditGeneralSearchWindowSnapshotV10(runtime.snapshot(), runtime.policy());
    expect(audit.valid).toBe(true);
    expect(runtime.snapshot().activeIndex).toBe(-1);
  });

  it('assert helper returns valid snapshots', () => {
    const runtime = createRuntime();
    expect(assertGeneralSearchWindowSnapshotV10(runtime.snapshot(), runtime.policy()))
      .toBe(runtime.snapshot());
  });

  it('flags item count mismatch', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, { matchedCount: snapshot.matchedCount + 1 });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'items-count-mismatch')).toBe(true);
    expect(audit.valid).toBe(false);
  });

  it('flags matched count larger than total', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, { matchedCount: snapshot.totalCount + 1 });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'matched-count-exceeds-total')).toBe(true);
  });

  it('flags duplicate item identities', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const duplicate = snapshot.items[0];
    expect(duplicate).toBeDefined();
    const brokenItems = Object.freeze([duplicate!, duplicate!, ...snapshot.items.slice(2)]);
    const broken = mutateSnapshot(snapshot, { items: brokenItems });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'duplicate-identity')).toBe(true);
  });

  it('flags an active index outside result bounds', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, { activeIndex: 9_999 });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'active-index-out-of-range')).toBe(true);
  });

  it('flags active identity mismatch', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, { activeIdentity: 'not-the-active-item' });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'active-identity-mismatch')).toBe(true);
  });

  it('flags active results outside visible window', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(20);
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, { visibleItems: Object.freeze([]) });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'active-result-not-visible')).toBe(true);
  });

  it('flags visible windows larger than policy', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, {
      visibleItems: Object.freeze(snapshot.items.slice(0, runtime.policy().renderWindowSize + 1)),
    });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'visible-window-budget-exceeded')).toBe(true);
  });

  it('flags render window count mismatch', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, { visibleItems: Object.freeze([]) });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'visible-window-count-mismatch')).toBe(true);
  });

  it('flags invalid render window ranges', () => {
    const runtime = createRuntime();
    const snapshot = runtime.snapshot();
    const broken = mutateSnapshot(snapshot, {
      renderWindow: Object.freeze({
        ...snapshot.renderWindow,
        startIndex: -1,
        endIndexExclusive: snapshot.matchedCount + 10,
      }),
    });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'render-window-range-invalid')).toBe(true);
  });

  it('flags empty assistive announcement', () => {
    const runtime = createRuntime();
    const broken = mutateSnapshot(runtime.snapshot(), { announcement: '' });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'announcement-empty')).toBe(true);
  });

  it('flags empty guidance text', () => {
    const runtime = createRuntime();
    const broken = mutateSnapshot(runtime.snapshot(), {
      guidance: Object.freeze({ tone: 'neutral', title: '', detail: '', actionLabel: null }),
    });
    const audit = auditGeneralSearchWindowSnapshotV10(broken, runtime.policy());
    expect(audit.findings.some(item => item.code === 'guidance-empty')).toBe(true);
  });

  it('throws from assert helper when required integrity fails', () => {
    const runtime = createRuntime();
    const broken = mutateSnapshot(runtime.snapshot(), { announcement: '' });
    expect(() => assertGeneralSearchWindowSnapshotV10(broken, runtime.policy()))
      .toThrow(/announcement-empty/);
  });

  it('reports deterministic audit fingerprint for equivalent state', () => {
    const first = createRuntime();
    const second = createRuntime();
    const firstAudit = auditGeneralSearchWindowSnapshotV10(first.snapshot(), first.policy());
    const secondAudit = auditGeneralSearchWindowSnapshotV10(second.snapshot(), second.policy());
    expect(firstAudit.fingerprint).toBe(secondAudit.fingerprint);
  });

  it('keeps large bounded snapshots valid', () => {
    const large = normalizeSearchCollection(Array.from({ length: 5_000 }, (_, index) => ({
      ObjectId: index,
      Title: `Büyük sonuç ${index}`,
      Category: `Kategori ${index % 20}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(large, {
      renderWindowSize: 36,
      maxFacetBuckets: 10,
    });
    runtime.setActiveIndex(4_500);
    const audit = auditGeneralSearchWindowSnapshotV10(runtime.snapshot(), runtime.policy());
    expect(audit.valid).toBe(true);
    expect(runtime.snapshot().visibleItems).toHaveLength(36);
  });
});
