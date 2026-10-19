import { describe, expect, it } from 'vitest';
import {
  applyArcGisResultWorkspaceFilterAction,
  createArcGisResultWorkspaceFilterExperience,
  dismissArcGisResultWorkspaceFilter,
  reconcileArcGisResultWorkspaceFilterEnvironment,
  resolveWorkspaceFilterActionOrder,
  resolveWorkspaceFilterEscape,
  resolveWorkspaceFilterFieldError,
  shouldSuppressWorkspaceFilterShortcut,
} from './ArcGisResultWorkspaceFilterExperiencePolicy';
import type { ResultFilterDefinition } from './ArcGisResultFilterExperiencePolicy';

const definitions: readonly ResultFilterDefinition[] = [
  { id: 'name', label: 'Ad', kind: 'text' },
  { id: 'population', label: 'Nüfus', kind: 'number' },
  { id: 'date', label: 'Tarih', kind: 'date' },
  {
    id: 'district',
    label: 'İlçe',
    kind: 'choice',
    options: [
      { value: 'cankaya', label: 'Çankaya', count: 12 },
      { value: 'kecioren', label: 'Keçiören', count: 8 },
    ],
  },
];

const desktop = { viewportWidth: 1440, viewportHeight: 900 };
const phone = { viewportWidth: 390, viewportHeight: 740, coarsePointer: true };

const create = (environment = desktop) =>
  createArcGisResultWorkspaceFilterExperience({ definitions }, environment, 'keyboard', 'kent-results');

describe('ArcGisResultWorkspaceFilterExperiencePolicy', () => {
  it('keeps desktop filters persistently visible as a region', () => {
    const snapshot = create();
    expect(snapshot.panel.role).toBe('region');
    expect(snapshot.panel.hidden).toBe(false);
    expect(snapshot.panel.modal).toBe(false);
    expect(snapshot.panel.trapFocus).toBe(false);
  });

  it('uses an initially closed dialog contract on phone', () => {
    const snapshot = create(phone);
    expect(snapshot.panel.role).toBe('dialog');
    expect(snapshot.panel.hidden).toBe(true);
    expect(snapshot.panel.modal).toBe(false);
    expect(snapshot.trigger.hasPopup).toBe('dialog');
    expect(snapshot.trigger.expanded).toBe(false);
  });

  it('opens phone filters as a modal focus trap', () => {
    const opened = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    expect(opened.panel.hidden).toBe(false);
    expect(opened.panel.modal).toBe(true);
    expect(opened.panel.trapFocus).toBe(true);
    expect(opened.focusTarget).toBe('panel');
  });

  it('uses 48px targets for coarse pointers', () => {
    const snapshot = create(phone);
    expect(snapshot.trigger.touchTargetPx).toBe(48);
  });

  it('uses a 44px baseline target for fine pointers', () => {
    expect(create().trigger.touchTargetPx).toBe(44);
  });

  it('removes motion when reduced motion is requested', () => {
    const snapshot = create({ ...phone, reducedMotion: true });
    expect(snapshot.motionDurationMs).toBe(0);
  });

  it('uses bounded motion otherwise', () => {
    expect(create().motionDurationMs).toBe(160);
  });

  it('preserves forced-colors state for the renderer', () => {
    expect(create({ ...desktop, forcedColors: true }).forcedColors).toBe(true);
  });

  it('creates deterministic scoped ids', () => {
    const snapshot = create();
    expect(snapshot.panel.id).toBe('kent-results-filter-panel');
    expect(snapshot.trigger.id).toBe('kent-results-filter-trigger');
    expect(snapshot.trigger.controls).toBe(snapshot.panel.id);
  });

  it('sanitizes hostile scope identifiers', () => {
    const snapshot = createArcGisResultWorkspaceFilterExperience({ definitions }, desktop, 'keyboard', '  KENT\u0000 / Results  ');
    expect(snapshot.panel.id).not.toContain('\u0000');
    expect(snapshot.panel.id).not.toContain('/');
  });

  it('bounds scope identifiers', () => {
    const snapshot = createArcGisResultWorkspaceFilterExperience({ definitions }, desktop, 'keyboard', 'x'.repeat(500));
    expect(snapshot.panel.id.length).toBeLessThan(100);
  });

  it('creates a text clause field contract', () => {
    const next = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    expect(next.fields).toHaveLength(1);
    expect(next.fields[0].inputMode).toBe('text');
    expect(next.fields[0].label).toBe('Ad');
  });

  it('creates a decimal input contract for number filters', () => {
    const next = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'population-1', filterId: 'population', operator: 'equals', value: '100' },
    }).next;
    expect(next.fields[0].inputMode).toBe('decimal');
  });

  it('creates a non-text input contract for choice filters', () => {
    const next = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'district-1', filterId: 'district', operator: 'equals', value: 'cankaya' },
    }).next;
    expect(next.fields[0].inputMode).toBe('none');
  });

  it('marks malformed number clauses invalid', () => {
    const next = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'population-1', filterId: 'population', operator: 'equals', value: 'not-a-number' },
    }).next;
    expect(next.fields[0].invalid).toBe(true);
    expect(next.fields[0].describedBy).toBe(next.fields[0].errorId);
    expect(next.canApply).toBe(false);
  });

  it('moves focus to the first invalid clause', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'population-1', filterId: 'population', operator: 'equals', value: 'oops' },
    }).next;
    const applied = applyArcGisResultWorkspaceFilterAction(invalid, { type: 'apply' });
    expect(applied.focusTarget).toBe('first-invalid');
    expect(applied.focusTargetId).toContain('population-1');
  });

  it('does not apply invalid draft clauses', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'date-1', filterId: 'date', operator: 'equals', value: 'yesterday' },
    }).next;
    const applied = applyArcGisResultWorkspaceFilterAction(invalid, { type: 'apply' }).next;
    expect(applied.state.clauses).toHaveLength(0);
    expect(applied.state.draftClauses).toHaveLength(1);
  });

  it('exposes a useful date error', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'date-1', filterId: 'date', operator: 'equals', value: 'nope' },
    }).next;
    expect(resolveWorkspaceFilterFieldError(invalid, 'date-1')).toBe('Geçerli bir tarih girin.');
  });

  it('exposes a useful number error', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'population-1', filterId: 'population', operator: 'equals', value: 'nope' },
    }).next;
    expect(resolveWorkspaceFilterFieldError(invalid, 'population-1')).toBe('Geçerli bir sayı girin.');
  });

  it('exposes a useful choice error', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'district-1', filterId: 'district', operator: 'equals', value: 'unknown' },
    }).next;
    expect(resolveWorkspaceFilterFieldError(invalid, 'district-1')).toBe('Listeden geçerli bir seçenek belirleyin.');
  });

  it('returns no error for valid fields', () => {
    const valid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    expect(resolveWorkspaceFilterFieldError(valid, 'name-1')).toBe('');
  });

  it('enables apply only for dirty valid state', () => {
    const next = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    expect(next.dirty).toBe(true);
    expect(next.canApply).toBe(true);
  });

  it('announces pending filter changes', () => {
    const transition = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    });
    expect(transition.announcement).toContain('uygulanmayı bekliyor');
  });

  it('applies valid clauses and clears dirty state', () => {
    const dirty = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    const edited = applyArcGisResultWorkspaceFilterAction(dirty, {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    const applied = applyArcGisResultWorkspaceFilterAction(edited, { type: 'apply' });
    expect(applied.next.state.clauses).toHaveLength(1);
    expect(applied.next.dirty).toBe(false);
    expect(applied.next.state.panelOpen).toBe(false);
    expect(applied.dismissReason).toBe('apply');
    expect(applied.focusTarget).toBe('trigger');
  });

  it('keeps desktop focus in the persistent panel after apply', () => {
    const edited = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    const applied = applyArcGisResultWorkspaceFilterAction(edited, { type: 'apply' });
    expect(applied.focusTarget).toBe('panel');
  });

  it('cancels mobile draft changes and restores trigger focus', () => {
    const opened = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    const edited = applyArcGisResultWorkspaceFilterAction(opened, {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    const cancelled = applyArcGisResultWorkspaceFilterAction(edited, { type: 'cancel' });
    expect(cancelled.next.state.draftClauses).toHaveLength(0);
    expect(cancelled.next.state.panelOpen).toBe(false);
    expect(cancelled.focusTarget).toBe('trigger');
    expect(cancelled.dismissReason).toBe('cancel');
  });

  it('clears committed and draft filters together', () => {
    const seeded = createArcGisResultWorkspaceFilterExperience({
      definitions,
      clauses: [{ id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' }],
    }, desktop);
    const cleared = applyArcGisResultWorkspaceFilterAction(seeded, { type: 'clear' }).next;
    expect(cleared.state.clauses).toHaveLength(0);
    expect(cleared.state.draftClauses).toHaveLength(0);
  });

  it('enables clear when committed filters exist', () => {
    const seeded = createArcGisResultWorkspaceFilterExperience({
      definitions,
      clauses: [{ id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' }],
    }, desktop);
    expect(seeded.canClear).toBe(true);
  });

  it('enables clear when only a draft exists', () => {
    const dirty = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    expect(dirty.canClear).toBe(true);
  });

  it('disables clear for pristine state', () => {
    expect(create().canClear).toBe(false);
  });

  it('escape cancels dirty phone changes', () => {
    const opened = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    const dirty = applyArcGisResultWorkspaceFilterAction(opened, {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    const dismissed = resolveWorkspaceFilterEscape(dirty);
    expect(dismissed.dismissReason).toBe('escape');
    expect(dismissed.next.state.draftClauses).toHaveLength(0);
    expect(dismissed.announcement).toContain('iptal');
  });

  it('outside dismissal closes without discarding the draft model', () => {
    const opened = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    const dirty = applyArcGisResultWorkspaceFilterAction(opened, {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    const dismissed = dismissArcGisResultWorkspaceFilter(dirty, 'outside');
    expect(dismissed.next.state.panelOpen).toBe(false);
    expect(dismissed.next.state.draftClauses).toHaveLength(1);
  });

  it('does not dismiss the persistent desktop panel', () => {
    const dismissed = dismissArcGisResultWorkspaceFilter(create(), 'outside');
    expect(dismissed.changed).toBe(false);
  });

  it('suppresses keyboard shortcuts in editable controls', () => {
    expect(shouldSuppressWorkspaceFilterShortcut('keyboard', { editable: true })).toBe(true);
  });

  it('suppresses keyboard shortcuts during IME composition', () => {
    expect(shouldSuppressWorkspaceFilterShortcut('keyboard', { composing: true })).toBe(true);
  });

  it('suppresses already prevented keyboard events', () => {
    expect(shouldSuppressWorkspaceFilterShortcut('keyboard', { defaultPrevented: true })).toBe(true);
  });

  it('suppresses disabled surfaces', () => {
    expect(shouldSuppressWorkspaceFilterShortcut('keyboard', { disabled: true })).toBe(true);
  });

  it('suppresses non-keyboard shortcut dispatch', () => {
    expect(shouldSuppressWorkspaceFilterShortcut('touch')).toBe(true);
    expect(shouldSuppressWorkspaceFilterShortcut('pointer')).toBe(true);
  });

  it('allows ordinary keyboard shortcut dispatch', () => {
    expect(shouldSuppressWorkspaceFilterShortcut('keyboard')).toBe(false);
  });

  it('does not escape while editing', () => {
    const opened = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    const result = resolveWorkspaceFilterEscape(opened, { editable: true });
    expect(result.changed).toBe(false);
    expect(result.next.state.panelOpen).toBe(true);
  });

  it('reconciles phone state to desktop persistent presentation', () => {
    const opened = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    const reconciled = reconcileArcGisResultWorkspaceFilterEnvironment(opened, desktop);
    expect(reconciled.next.state.viewport).toBe('desktop');
    expect(reconciled.next.panel.role).toBe('region');
    expect(reconciled.next.panel.hidden).toBe(false);
  });

  it('reconciles desktop state to a closed phone overlay', () => {
    const reconciled = reconcileArcGisResultWorkspaceFilterEnvironment(create(), phone);
    expect(reconciled.next.state.viewport).toBe('phone');
    expect(reconciled.next.panel.hidden).toBe(true);
  });

  it('keeps draft clauses while viewport changes', () => {
    const dirty = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    const reconciled = reconcileArcGisResultWorkspaceFilterEnvironment(dirty, phone);
    expect(reconciled.next.state.draftClauses).toHaveLength(1);
    expect(reconciled.next.dirty).toBe(true);
  });

  it('preserves committed clauses while viewport changes', () => {
    const seeded = createArcGisResultWorkspaceFilterExperience({
      definitions,
      clauses: [{ id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' }],
    }, desktop);
    const reconciled = reconcileArcGisResultWorkspaceFilterEnvironment(seeded, phone);
    expect(reconciled.next.state.clauses).toHaveLength(1);
  });

  it('handles non-finite viewport dimensions defensively', () => {
    const snapshot = createArcGisResultWorkspaceFilterExperience({ definitions }, {
      viewportWidth: Number.NaN,
      viewportHeight: Number.POSITIVE_INFINITY,
    });
    expect(snapshot.state.viewport).toBe('desktop');
    expect(snapshot.environment.viewportHeight).toBe(800);
  });

  it('clamps negative viewport dimensions', () => {
    const snapshot = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: -100, viewportHeight: -1 });
    expect(snapshot.environment.viewportWidth).toBe(0);
    expect(snapshot.environment.viewportHeight).toBe(0);
    expect(snapshot.state.viewport).toBe('phone');
  });

  it('keeps live output free of control characters', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'population-1', filterId: 'population', operator: 'equals', value: '\u0000bad' },
    }).next;
    expect(invalid.live.message).not.toContain('\u0000');
  });

  it('returns a deterministic action order for pristine desktop', () => {
    expect(resolveWorkspaceFilterActionOrder(create())).toEqual(['panel']);
  });

  it('adds clear and apply actions for valid dirty state', () => {
    const dirty = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' },
    }).next;
    expect(resolveWorkspaceFilterActionOrder(dirty)).toEqual(['panel', 'clear', 'apply']);
  });

  it('prioritizes invalid fields in action order', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'population-1', filterId: 'population', operator: 'equals', value: 'bad' },
    }).next;
    expect(resolveWorkspaceFilterActionOrder(invalid)[1]).toBe('first-invalid');
  });

  it('includes trigger in mobile action order', () => {
    expect(resolveWorkspaceFilterActionOrder(create(phone))).toContain('trigger');
  });

  it('keeps field inventory bounded by the underlying authority', () => {
    const clauses = Array.from({ length: 100 }, (_, index) => ({
      id: `name-${index}`,
      filterId: 'name',
      operator: 'contains' as const,
      value: String(index),
    }));
    const snapshot = createArcGisResultWorkspaceFilterExperience({ definitions, draftClauses: clauses }, desktop);
    expect(snapshot.fields.length).toBeLessThanOrEqual(24);
  });

  it('keeps definition inventory bounded by the underlying authority', () => {
    const manyDefinitions = Array.from({ length: 100 }, (_, index) => ({
      id: `field-${index}`,
      label: `Field ${index}`,
      kind: 'text' as const,
    }));
    const snapshot = createArcGisResultWorkspaceFilterExperience({ definitions: manyDefinitions }, desktop);
    expect(snapshot.state.definitions.length).toBeLessThanOrEqual(32);
  });

  it('does not retain unknown clauses', () => {
    const snapshot = createArcGisResultWorkspaceFilterExperience({
      definitions,
      draftClauses: [{ id: 'unknown-1', filterId: 'unknown', operator: 'equals', value: 'x' }],
    }, desktop);
    expect(snapshot.fields).toHaveLength(0);
  });

  it('normalizes duplicate clause ids through the existing authority', () => {
    const snapshot = createArcGisResultWorkspaceFilterExperience({
      definitions,
      draftClauses: [
        { id: 'name-1', filterId: 'name', operator: 'contains', value: 'a' },
        { id: 'name-1', filterId: 'name', operator: 'contains', value: 'b' },
      ],
    }, desktop);
    expect(snapshot.fields).toHaveLength(1);
  });

  it('preserves modality across environment reconciliation', () => {
    const touch = createArcGisResultWorkspaceFilterExperience({ definitions }, phone, 'touch');
    const reconciled = reconcileArcGisResultWorkspaceFilterEnvironment(touch, desktop);
    expect(reconciled.next.modality).toBe('touch');
  });

  it('updates modality when an explicit action comes from touch', () => {
    const transition = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }, 'touch');
    expect(transition.next.modality).toBe('touch');
  });

  it('keeps panel label synchronized with active filter count', () => {
    const seeded = createArcGisResultWorkspaceFilterExperience({
      definitions,
      clauses: [{ id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' }],
    }, phone);
    expect(seeded.panel.label).toContain('1 etkin');
  });

  it('keeps desktop panel label concise', () => {
    const seeded = createArcGisResultWorkspaceFilterExperience({
      definitions,
      clauses: [{ id: 'name-1', filterId: 'name', operator: 'contains', value: 'park' }],
    }, desktop);
    expect(seeded.panel.label).toBe('Sonuç filtreleri');
  });

  it('restores trigger focus after explicit mobile close', () => {
    const opened = applyArcGisResultWorkspaceFilterAction(create(phone), { type: 'open' }).next;
    const closed = applyArcGisResultWorkspaceFilterAction(opened, { type: 'close' });
    expect(closed.focusTarget).toBe('trigger');
    expect(closed.focusTargetId).toBe(closed.next.trigger.id);
  });

  it('reports changed=false for a blocked invalid apply', () => {
    const invalid = applyArcGisResultWorkspaceFilterAction(create(), {
      type: 'upsert',
      clause: { id: 'population-1', filterId: 'population', operator: 'equals', value: 'bad' },
    }).next;
    const blocked = applyArcGisResultWorkspaceFilterAction(invalid, { type: 'apply' });
    expect(blocked.changed).toBe(false);
  });

  it('does not invent a second network or icon authority', () => {
    const snapshot = create();
    expect(Object.keys(snapshot)).not.toContain('endpoint');
    expect(Object.keys(snapshot)).not.toContain('iconResolver');
    expect(Object.keys(snapshot)).not.toContain('telemetry');
  });
});
