import { describe, expect, it } from 'vitest';
import {
  createArcGisResultWorkspaceStatusAccessibilityContract,
  resolveArcGisResultWorkspaceStatusAccessibilityKey,
} from './ArcGisResultWorkspaceStatusAccessibilityExperiencePolicy';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

const workspace = (
  status: string,
  resultIds: string[] = [],
  overrides: Partial<ResultWorkspaceSnapshot> = {},
): ResultWorkspaceSnapshot => ({
  model: { status, heading: 'Sonuçlar' },
  interaction: {
    resultIds,
    selectedIds: [],
    focusedId: resultIds[0] ?? null,
    activeId: null,
    detailOpen: false,
    filterOpen: false,
    viewport: 'desktop',
  },
  presentation: { panel: 'collection', collectionVisible: true, mapVisible: true, splitView: true, filtersOverlay: false },
  accessibility: { minimumTargetSize: 44, reducedMotion: false, forcedColors: false, mapLabel: 'Harita' },
  modality: 'keyboard',
  revision: 0,
  ...overrides,
} as ResultWorkspaceSnapshot);

describe('ArcGisResultWorkspaceStatusAccessibilityExperiencePolicy', () => {
  it('exposes polite busy semantics while results are loading', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('loading'), {
      queryLabel: 'park',
      previousStatus: 'idle',
    });
    expect(contract.role).toBe('status');
    expect(contract.ariaLive).toBe('polite');
    expect(contract.ariaAtomic).toBe(true);
    expect(contract.busy).toBe(true);
    expect(contract.tone).toBe('progress');
    expect(contract.message).toContain('park');
    expect(contract.focusAction).toBe('none');
  });

  it('announces ready result count and moves keyboard focus to the collection after transition', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('ready', ['a', 'b', 'c']), {
      previousStatus: 'loading',
    });
    expect(contract.message).toBe('3 sonuç hazır.');
    expect(contract.tone).toBe('success');
    expect(contract.focusAction).toBe('focus-collection');
    expect(contract.focusTarget).toBe('results-collection');
  });

  it('uses singular Turkish copy for one result', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('ready', ['a']), {
      previousStatus: 'loading',
    });
    expect(contract.message).toBe('1 sonuç hazır.');
  });

  it('keeps pointer users in place when ready state arrives', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('ready', ['a'], {
      modality: 'pointer',
    } as Partial<ResultWorkspaceSnapshot>), { previousStatus: 'loading' });
    expect(contract.focusVisible).toBe(false);
    expect(contract.focusAction).toBe('none');
    expect(contract.focusTarget).toBeNull();
  });

  it('exposes actionable empty guidance without pretending it is an error', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('ready'), {
      queryLabel: 'erişilebilir park',
      previousStatus: 'loading',
    });
    expect(contract.role).toBe('status');
    expect(contract.ariaLive).toBe('polite');
    expect(contract.tone).toBe('warning');
    expect(contract.message).toContain('erişilebilir park');
    expect(contract.description).toContain('Filtreleri');
    expect(contract.recoveryVisible).toBe(false);
    expect(contract.focusTarget).toBe('results-collection');
  });

  it('uses assertive semantics and recovery focus for a new error', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      errorMessage: 'Sunucu yanıt vermedi.',
      recoveryAvailable: true,
      previousStatus: 'loading',
    });
    expect(contract.role).toBe('alert');
    expect(contract.ariaLive).toBe('assertive');
    expect(contract.tone).toBe('danger');
    expect(contract.recoveryVisible).toBe(true);
    expect(contract.focusAction).toBe('focus-recovery');
    expect(contract.focusTarget).toBe('results-status-recovery');
  });

  it('does not steal focus when an error remains unchanged', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      previousStatus: 'error',
      errorMessage: 'Hata sürüyor',
    });
    expect(contract.focusAction).toBe('none');
    expect(contract.focusTarget).toBeNull();
  });

  it('can suppress recovery when retry is not available', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('failed'), {
      recoveryAvailable: false,
      previousStatus: 'loading',
    });
    expect(contract.recoveryVisible).toBe(false);
    expect(contract.focusAction).toBe('none');
  });

  it('bounds hostile error and query strings before exposing live-region copy', () => {
    const error = `\u0000\u0001 ${'x'.repeat(500)}`;
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      errorMessage: error,
      queryLabel: 'q'.repeat(500),
      previousStatus: 'loading',
    });
    expect(contract.message.length).toBeLessThanOrEqual(240);
    expect(contract.message).not.toContain('\u0000');
    expect(contract.message).not.toContain('\u0001');
  });

  it('sanitizes scope ids and keeps deterministic semantic ids', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('idle'), {
      scopeId: ' Unsafe Scope\u0000/../../ ',
    });
    expect(contract.scopeId).toBe('unsafe-scope');
    expect(contract.containerId).toBe('unsafe-scope-status');
    expect(contract.headingId).toBe('unsafe-scope-status-heading');
    expect(contract.descriptionId).toBe('unsafe-scope-status-description');
    expect(contract.recoveryId).toBe('unsafe-scope-status-recovery');
  });

  it('inherits touch target and user accessibility preferences from workspace authority', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('idle', [], {
      accessibility: { minimumTargetSize: 48, reducedMotion: true, forcedColors: true, mapLabel: 'Harita' },
    } as Partial<ResultWorkspaceSnapshot>));
    expect(contract.minimumTargetSize).toBe(48);
    expect(contract.reducedMotion).toBe(true);
    expect(contract.forcedColors).toBe(true);
  });

  it('clamps explicit result count to the workspace admission ceiling', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('ready', ['a']), {
      resultCount: Number.MAX_SAFE_INTEGER,
      previousStatus: 'loading',
    });
    expect(contract.message).toBe('20.000 sonuç hazır.');
  });

  it('treats negative explicit counts as zero', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('ready', ['a']), {
      resultCount: -20,
      previousStatus: 'loading',
    });
    expect(contract.tone).toBe('warning');
    expect(contract.message).toContain('sonuç bulunamadı');
  });

  it('does not increment revision for an equivalent derived contract', () => {
    const snapshot = workspace('loading');
    const first = createArcGisResultWorkspaceStatusAccessibilityContract(snapshot, { previousStatus: 'idle' });
    const second = createArcGisResultWorkspaceStatusAccessibilityContract(snapshot, { previousStatus: 'idle' }, first);
    expect(second.revision).toBe(first.revision);
  });

  it('increments revision when status-derived semantics change', () => {
    const first = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('loading'), { previousStatus: 'idle' });
    const second = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      previousStatus: 'loading',
      errorMessage: 'Hata',
    }, first);
    expect(second.revision).toBe(first.revision + 1);
  });

  it.each(['Enter', ' '])('maps %j to retry while recovery is available', (key) => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      previousStatus: 'loading',
    });
    expect(resolveArcGisResultWorkspaceStatusAccessibilityKey(contract, { key })).toEqual({
      handled: true,
      preventDefault: true,
      action: 'retry',
      focusTarget: 'results-status-recovery',
    });
  });

  it('maps Escape from recovery state back to result collection', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      previousStatus: 'loading',
    });
    expect(resolveArcGisResultWorkspaceStatusAccessibilityKey(contract, { key: 'Escape' })).toEqual({
      handled: true,
      preventDefault: true,
      action: 'focus-results',
      focusTarget: 'results-collection',
    });
  });

  it('does not consume retry keys when recovery is unavailable', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      recoveryAvailable: false,
      previousStatus: 'loading',
    });
    expect(resolveArcGisResultWorkspaceStatusAccessibilityKey(contract, { key: 'Enter' }).handled).toBe(false);
  });

  it('fails closed for editable, IME, repeat, prevented and modified key contexts', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      previousStatus: 'loading',
    });
    const events = [
      { key: 'Enter', editable: true },
      { key: 'Enter', composing: true },
      { key: 'Enter', repeat: true },
      { key: 'Enter', defaultPrevented: true },
      { key: 'Enter', altKey: true },
      { key: 'Enter', ctrlKey: true },
      { key: 'Enter', metaKey: true },
    ];
    for (const event of events) {
      expect(resolveArcGisResultWorkspaceStatusAccessibilityKey(contract, event)).toEqual({
        handled: false,
        preventDefault: false,
        action: 'none',
        focusTarget: null,
      });
    }
  });

  it('does not consume unrelated keys', () => {
    const contract = createArcGisResultWorkspaceStatusAccessibilityContract(workspace('error'), {
      previousStatus: 'loading',
    });
    expect(resolveArcGisResultWorkspaceStatusAccessibilityKey(contract, { key: 'ArrowDown' }).handled).toBe(false);
  });
});
