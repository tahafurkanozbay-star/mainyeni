import { describe, expect, it } from 'vitest';
import { createArcGisResultWorkspaceAccessibilityContract } from './ArcGisResultWorkspaceAccessibilityExperiencePolicy';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import {
  applyArcGisResultWorkspaceFilterAction,
  createArcGisResultWorkspaceFilterExperience,
  dismissArcGisResultWorkspaceFilter,
  reconcileArcGisResultWorkspaceFilterEnvironment,
} from './ArcGisResultWorkspaceFilterExperiencePolicy';
import {
  createArcGisResultWorkspaceFilterAccessibilityContract,
  resolveArcGisResultWorkspaceFilterAccessibilityFocus,
  shouldTrapArcGisResultWorkspaceFilterFocus,
} from './ArcGisResultWorkspaceFilterAccessibilityExperiencePolicy';
import type { ResultFilterDefinition } from './ArcGisResultFilterExperiencePolicy';

const definitions: readonly ResultFilterDefinition[] = [
  { id: 'name', label: 'Ad', kind: 'text', operators: ['contains', 'equals'] },
  { id: 'population', label: 'Nüfus', kind: 'number', operators: ['equals', 'greater-than', 'between'] },
  { id: 'date', label: 'Tarih', kind: 'date', operators: ['equals', 'between'] },
];

const workspace = (modality: ResultWorkspaceSnapshot['modality'] = 'keyboard'): ResultWorkspaceSnapshot => ({
  model: { status: 'ready', heading: 'Sonuçlar' },
  interaction: { resultIds: ['row-1', 'row-2'], selectedIds: [], focusedId: 'row-1' },
  presentation: { panel: 'collection', collectionVisible: true, mapVisible: true, splitView: true },
  accessibility: { minimumTargetSize: 44, reducedMotion: false, forcedColors: false, mapLabel: 'Harita' },
  modality,
  revision: 0,
} as ResultWorkspaceSnapshot);

const a11y = (value = workspace()) => createArcGisResultWorkspaceAccessibilityContract(value);

describe('ArcGisResultWorkspaceFilterAccessibilityExperiencePolicy', () => {
  it('derives desktop region semantics without focus trapping', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: 1280 });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), filter);
    expect(contract.role).toBe('region');
    expect(contract.modal).toBe(false);
    expect(contract.hidden).toBe(false);
    expect(contract.describedBy).toContain(contract.statusId);
    expect(shouldTrapArcGisResultWorkspaceFilterFocus(filter)).toBe(false);
  });

  it('derives modal dialog semantics for an opened phone filter', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions, panelOpen: true }, { viewportWidth: 390, coarsePointer: true });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), filter);
    expect(contract.role).toBe('dialog');
    expect(contract.modal).toBe(true);
    expect(contract.hidden).toBe(false);
    expect(contract.minimumTargetSize).toBe(44);
    expect(filter.trigger.touchTargetPx).toBe(48);
    expect(shouldTrapArcGisResultWorkspaceFilterFocus(filter)).toBe(true);
  });

  it('restores focus to the trigger when a phone dialog is closed', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions, panelOpen: true }, { viewportWidth: 390 });
    const dismissed = dismissArcGisResultWorkspaceFilter(filter, 'escape');
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), dismissed.next, null, dismissed);
    expect(contract.reason).toBe('cancelled');
    expect(contract.restoreFocusId).toBe(filter.trigger.id);
    expect(resolveArcGisResultWorkspaceFilterAccessibilityFocus(contract)).toBe(filter.trigger.id);
  });

  it('keeps desktop restore focus on the active result instead of inventing another authority', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: 1280 });
    const workspaceA11y = a11y();
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), workspaceA11y, filter);
    expect(contract.restoreFocusId).toBe(workspaceA11y.activeDescendant);
  });

  it('exposes invalid fields with aria-invalid, described-by and bounded error copy', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({
      definitions,
      draftClauses: [{ id: 'population-clause', filterId: 'population', operator: 'equals', value: 'not-a-number' }],
    }, { viewportWidth: 1280 });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), filter);
    expect(contract.invalidCount).toBe(1);
    expect(contract.firstInvalidId).toBe(filter.fields[0]?.id);
    expect(contract.fields[0]?.ariaInvalid).toBe(true);
    expect(contract.fields[0]?.ariaDescribedBy).toBe(filter.fields[0]?.errorId);
    expect(contract.fields[0]?.errorMessage).toBe('Geçerli bir sayı girin.');
    expect(resolveArcGisResultWorkspaceFilterAccessibilityFocus(contract)).toBe(filter.fields[0]?.id);
  });

  it('uses assertive live semantics when validation errors become active', () => {
    const valid = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: 1280 });
    const previous = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), valid);
    const invalid = createArcGisResultWorkspaceFilterExperience({
      definitions,
      draftClauses: [{ id: 'bad-date', filterId: 'date', operator: 'equals', value: 'bad' }],
    }, { viewportWidth: 1280 });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), invalid, previous);
    expect(contract.reason).toBe('validation-error');
    expect(contract.liveRegion.role).toBe('alert');
    expect(contract.liveRegion.ariaLive).toBe('assertive');
    expect(contract.liveRegion.message).toContain('1 filtre alanında hata var');
  });

  it('announces validation recovery politely', () => {
    const invalid = createArcGisResultWorkspaceFilterExperience({
      definitions,
      draftClauses: [{ id: 'bad-date', filterId: 'date', operator: 'equals', value: 'bad' }],
    }, { viewportWidth: 1280 });
    const previous = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), invalid);
    const valid = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: 1280 });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), valid, previous);
    expect(contract.reason).toBe('validation-cleared');
    expect(contract.liveRegion.ariaLive).toBe('polite');
    expect(contract.liveRegion.message).toBe('Filtre hataları giderildi.');
  });

  it('preserves explicit apply lifecycle and focus target', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({
      definitions,
      draftClauses: [{ id: 'name-clause', filterId: 'name', operator: 'contains', value: 'park' }],
      panelOpen: true,
    }, { viewportWidth: 390 });
    const applied = applyArcGisResultWorkspaceFilterAction(filter, { type: 'apply' });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), applied.next, null, applied);
    expect(contract.reason).toBe('applied');
    expect(contract.liveRegion.message.length).toBeGreaterThan(0);
    expect(contract.focusTargetId).toBe(filter.trigger.id);
  });

  it('preserves cancel lifecycle and bounded keyboard guidance', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions, panelOpen: true }, { viewportWidth: 390 });
    const cancelled = applyArcGisResultWorkspaceFilterAction(filter, { type: 'cancel' });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), cancelled.next, null, cancelled);
    expect(contract.reason).toBe('cancelled');
    expect(contract.keyboardHint).toContain('Escape');
    expect(contract.keyboardHint.length).toBeLessThanOrEqual(240);
  });

  it('reports viewport reconciliation when responsive layout closes the dialog', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions, panelOpen: true }, { viewportWidth: 390 });
    const reconciled = reconcileArcGisResultWorkspaceFilterEnvironment(filter, { viewportWidth: 1280 });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), reconciled.next, null, reconciled);
    expect(contract.reason).toBe('viewport-reconciled');
    expect(contract.role).toBe('region');
    expect(contract.modal).toBe(false);
  });

  it('inherits keyboard focus-visible, reduced-motion and forced-colors from workspace authority', () => {
    const value = {
      ...workspace('keyboard'),
      accessibility: { ...workspace().accessibility, reducedMotion: true, forcedColors: true, minimumTargetSize: 48 },
    } as ResultWorkspaceSnapshot;
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: 1280 });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(value, a11y(value), filter);
    expect(contract.focusVisible).toBe(true);
    expect(contract.reducedMotion).toBe(true);
    expect(contract.forcedColors).toBe(true);
    expect(contract.minimumTargetSize).toBe(48);
  });

  it('hides focus-visible treatment for pointer modality', () => {
    const value = workspace('pointer');
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: 1280 }, 'pointer');
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(value, a11y(value), filter);
    expect(contract.focusVisible).toBe(false);
  });

  it('sanitizes upstream live text and bounds it to 240 characters', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({ definitions }, { viewportWidth: 1280 });
    const transition = {
      next: filter,
      changed: true,
      announcement: `bad\u0000 ${'x'.repeat(400)}`,
      focusTarget: filter.focusTarget,
    } as const;
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), filter, null, transition);
    expect(contract.liveRegion.message.length).toBeLessThanOrEqual(240);
    expect(contract.liveRegion.message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('keeps field and contract inventories immutable', () => {
    const filter = createArcGisResultWorkspaceFilterExperience({
      definitions,
      draftClauses: [{ id: 'name-clause', filterId: 'name', operator: 'contains', value: 'park' }],
    });
    const contract = createArcGisResultWorkspaceFilterAccessibilityContract(workspace(), a11y(), filter);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.fields)).toBe(true);
    expect(Object.isFrozen(contract.fields[0])).toBe(true);
    expect(Object.isFrozen(contract.liveRegion)).toBe(true);
  });
});
