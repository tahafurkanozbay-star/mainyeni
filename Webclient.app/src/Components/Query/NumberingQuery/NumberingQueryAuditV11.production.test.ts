import { describe, expect, it } from 'vitest';
import {
  NUMBERING_QUERY_VERSION_V11,
  emptyNumberingPathV11,
  type NumberingRuntimeSnapshotV11,
} from './NumberingQueryContractsV11';
import { auditNumberingSnapshotV11 } from './NumberingQueryAuditV11';
import {
  createNumberingStepPresentationV11,
  createNumberingWorkspacePresentationV11,
  numberingFilterDisabledV11,
  numberingSelectionValueV11,
  numberingStepDisabledV11,
} from './NumberingQueryPresentationV11';

const level = (name: 'district' | 'neighborhood' | 'street' | 'door') => Object.freeze({
  level: name,
  status: 'idle' as const,
  filter: '',
  optionCount: 0,
  visibleOptionCount: 0,
  truncated: false,
  selected: null,
  options: Object.freeze([]),
  message: '',
  error: '',
  generation: 0,
});

const snapshot = (
  override: Partial<NumberingRuntimeSnapshotV11> = {},
): NumberingRuntimeSnapshotV11 => Object.freeze({
  version: NUMBERING_QUERY_VERSION_V11,
  disposed: false,
  initialized: true,
  sequence: 0,
  path: emptyNumberingPathV11(),
  levels: Object.freeze({
    district: level('district'),
    neighborhood: level('neighborhood'),
    street: level('street'),
    door: level('door'),
  }),
  activeLevel: null,
  busy: false,
  complete: false,
  canReset: false,
  pathLabel: '',
  history: Object.freeze([]),
  metrics: Object.freeze({
    requests: 0,
    successes: 0,
    failures: 0,
    staleResponses: 0,
    cancellations: 0,
    focusRequests: 0,
    observerFailures: 0,
    optionTruncations: 0,
  }),
  ...override,
});

describe('NumberingQueryAuditV11 healthy snapshot', () => {
  it('accepts a clean empty snapshot', () => {
    const report = auditNumberingSnapshotV11(snapshot());
    expect(report.valid).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.findings[0]?.code).toBe('snapshot-consistent');
  });

  it('returns deterministic fingerprint', () => {
    expect(auditNumberingSnapshotV11(snapshot()).fingerprint)
      .toBe(auditNumberingSnapshotV11(snapshot()).fingerprint);
  });

  it('freezes findings', () => {
    const report = auditNumberingSnapshotV11(snapshot());
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.findings)).toBe(true);
  });
});

describe('NumberingQueryAuditV11 hierarchy integrity', () => {
  it('rejects neighborhood without district', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      path: Object.freeze({
        ...base.path,
        neighborhood: Object.freeze({ value: '2', label: 'Kızılay' }),
      }),
      levels: Object.freeze({
        ...base.levels,
        neighborhood: Object.freeze({
          ...base.levels.neighborhood,
          selected: Object.freeze({ value: '2', label: 'Kızılay' }),
        }),
      }),
    }));
    expect(report.valid).toBe(false);
    expect(report.findings.some(item => item.code === 'hierarchy-parent-missing')).toBe(true);
  });

  it('rejects street without neighborhood', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      path: Object.freeze({
        district: Object.freeze({ value: '1', label: 'Çankaya' }),
        neighborhood: null,
        street: Object.freeze({ value: '3', label: 'Atatürk' }),
        door: null,
      }),
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({
          ...base.levels.district,
          selected: Object.freeze({ value: '1', label: 'Çankaya' }),
        }),
        street: Object.freeze({
          ...base.levels.street,
          selected: Object.freeze({ value: '3', label: 'Atatürk' }),
        }),
      }),
    }));
    expect(report.findings.some(item => item.code === 'hierarchy-parent-missing')).toBe(true);
  });

  it('rejects completion mismatch', () => {
    const report = auditNumberingSnapshotV11(snapshot({ complete: true }));
    expect(report.findings.some(item => item.code === 'completion-mismatch')).toBe(true);
  });

  it('rejects busy state without active level', () => {
    const report = auditNumberingSnapshotV11(snapshot({ busy: true }));
    expect(report.findings.some(item => item.code === 'busy-without-active-level')).toBe(true);
  });

  it('rejects active level without busy state', () => {
    const report = auditNumberingSnapshotV11(snapshot({ activeLevel: 'street' }));
    expect(report.findings.some(item => item.code === 'active-level-without-busy')).toBe(true);
  });
});

describe('NumberingQueryAuditV11 option integrity', () => {
  it('rejects visible count greater than total count', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({
          ...base.levels.district,
          visibleOptionCount: 2,
          optionCount: 1,
          options: Object.freeze([
            Object.freeze({ value: '1', label: 'A', searchLabel: 'a', sourceIndex: 0 }),
            Object.freeze({ value: '2', label: 'B', searchLabel: 'b', sourceIndex: 1 }),
          ]),
        }),
      }),
    }));
    expect(report.findings.some(item => item.code === 'visible-count-exceeds-source')).toBe(true);
  });

  it('rejects duplicate visible options', () => {
    const base = snapshot();
    const duplicate = Object.freeze({ value: '1', label: 'A', searchLabel: 'a', sourceIndex: 0 });
    const report = auditNumberingSnapshotV11(snapshot({
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({
          ...base.levels.district,
          visibleOptionCount: 2,
          optionCount: 2,
          options: Object.freeze([duplicate, duplicate]),
        }),
      }),
    }));
    expect(report.findings.some(item => item.code === 'duplicate-visible-option')).toBe(true);
  });

  it('rejects empty option identity', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({
          ...base.levels.district,
          visibleOptionCount: 1,
          optionCount: 1,
          options: Object.freeze([
            Object.freeze({ value: '', label: 'A', searchLabel: 'a', sourceIndex: 0 }),
          ]),
        }),
      }),
    }));
    expect(report.findings.some(item => item.code === 'empty-option-id')).toBe(true);
  });

  it('flags empty labels as warning', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({
          ...base.levels.district,
          visibleOptionCount: 1,
          optionCount: 1,
          options: Object.freeze([
            Object.freeze({ value: '1', label: '', searchLabel: '', sourceIndex: 0 }),
          ]),
        }),
      }),
    }));
    expect(report.warningCount).toBeGreaterThan(0);
    expect(report.findings.some(item => item.code === 'empty-option-label')).toBe(true);
  });

  it('rejects visible option length mismatch', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({
          ...base.levels.district,
          visibleOptionCount: 1,
          optionCount: 1,
          options: Object.freeze([]),
        }),
      }),
    }));
    expect(report.findings.some(item => item.code === 'visible-count-mismatch')).toBe(true);
  });
});

describe('NumberingQueryAuditV11 lifecycle integrity', () => {
  it('rejects disposed snapshot retaining options', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      disposed: true,
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({
          ...base.levels.district,
          optionCount: 1,
          visibleOptionCount: 1,
          options: Object.freeze([
            Object.freeze({ value: '1', label: 'A', searchLabel: 'a', sourceIndex: 0 }),
          ]),
        }),
      }),
    }));
    expect(report.findings.some(item => item.code === 'disposed-retains-options')).toBe(true);
  });

  it('rejects stale response counter exceeding requests', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      metrics: Object.freeze({
        ...base.metrics,
        requests: 1,
        staleResponses: 2,
      }),
    }));
    expect(report.findings.some(item => item.code === 'stale-count-exceeds-requests')).toBe(true);
  });

  it('rejects settled count exceeding requests', () => {
    const base = snapshot();
    const report = auditNumberingSnapshotV11(snapshot({
      metrics: Object.freeze({
        ...base.metrics,
        requests: 1,
        successes: 1,
        failures: 1,
      }),
    }));
    expect(report.findings.some(item => item.code === 'settled-count-exceeds-requests')).toBe(true);
  });
});

describe('NumberingQueryPresentationV11', () => {
  it('creates four steps', () => {
    expect(createNumberingWorkspacePresentationV11(snapshot()).steps).toHaveLength(4);
  });

  it('enables only district initially', () => {
    const workspace = createNumberingWorkspacePresentationV11(snapshot());
    expect(workspace.steps.map(step => [step.level, step.enabled])).toEqual([
      ['district', true],
      ['neighborhood', false],
      ['street', false],
      ['door', false],
    ]);
  });

  it('enables neighborhood after district selection', () => {
    const base = snapshot();
    const selected = Object.freeze({ value: '1', label: 'Çankaya' });
    const next = snapshot({
      path: Object.freeze({ ...base.path, district: selected }),
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({ ...base.levels.district, selected }),
      }),
      canReset: true,
      pathLabel: 'Çankaya',
    });
    expect(createNumberingStepPresentationV11(next, 'neighborhood').enabled).toBe(true);
    expect(numberingStepDisabledV11(next, 'neighborhood')).toBe(false);
  });

  it('disables a busy step', () => {
    const base = snapshot();
    const next = snapshot({
      busy: true,
      activeLevel: 'district',
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({ ...base.levels.district, status: 'loading' as const }),
      }),
    });
    expect(numberingStepDisabledV11(next, 'district')).toBe(true);
  });

  it('disables filter when there are no options', () => {
    expect(numberingFilterDisabledV11(snapshot(), 'district')).toBe(true);
  });

  it('reads selected value', () => {
    const base = snapshot();
    const selected = Object.freeze({ value: '1', label: 'Çankaya' });
    const next = snapshot({
      path: Object.freeze({ ...base.path, district: selected }),
      levels: Object.freeze({
        ...base.levels,
        district: Object.freeze({ ...base.levels.district, selected }),
      }),
    });
    expect(numberingSelectionValueV11(next, 'district')).toBe('1');
  });

  it('announces completion', () => {
    const selected = Object.freeze({ value: '1', label: 'A' });
    const base = snapshot();
    const next = snapshot({
      complete: true,
      pathLabel: 'A / B / C / D',
      path: Object.freeze({
        district: selected,
        neighborhood: Object.freeze({ value: '2', label: 'B' }),
        street: Object.freeze({ value: '3', label: 'C' }),
        door: Object.freeze({ value: '4', label: 'D' }),
      }),
      levels: Object.freeze({
        district: Object.freeze({ ...base.levels.district, selected }),
        neighborhood: Object.freeze({
          ...base.levels.neighborhood,
          selected: Object.freeze({ value: '2', label: 'B' }),
        }),
        street: Object.freeze({
          ...base.levels.street,
          selected: Object.freeze({ value: '3', label: 'C' }),
        }),
        door: Object.freeze({
          ...base.levels.door,
          selected: Object.freeze({ value: '4', label: 'D' }),
        }),
      }),
    });
    expect(createNumberingWorkspacePresentationV11(next).liveStatus)
      .toContain('Adres seçimi tamamlandı');
  });
});
