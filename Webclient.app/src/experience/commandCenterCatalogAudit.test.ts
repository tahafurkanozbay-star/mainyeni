import { describe, expect, test } from 'vitest';
import {
  assertCommandCenterCatalog,
  auditCommandCenterCatalog,
  type CommandCenterCatalogEntry,
} from './commandCenterCatalogAudit';

const entry = (
  id: string,
  overrides: Partial<CommandCenterCatalogEntry> = {},
): CommandCenterCatalogEntry => ({
  id,
  label: `Komut ${id}`,
  group: 'Harita',
  description: `${id} açıklaması`,
  target: `${id}-window`,
  ...overrides,
});

describe('commandCenterCatalogAudit', () => {
  test('accepts a valid mixed target/event catalog', () => {
    const report = auditCommandCenterCatalog([
      entry('search', { shortcut: 'Ctrl K' }),
      entry('layers', { target: undefined, event: 'layers', shortcut: 'L' }),
      entry('help', { target: undefined, event: 'help', shortcut: '?' }),
    ]);
    expect(report.valid).toBe(true);
    expect(report.commandCount).toBe(3);
    expect(report.enabledCount).toBe(3);
    expect(report.disabledCount).toBe(0);
    expect(report.actionableCount).toBe(3);
    expect(report.shortcutCount).toBe(3);
    expect(report.issues).toEqual([]);
  });

  test('rejects blank ids', () => {
    const report = auditCommandCenterCatalog([entry(' ', { label: 'Kimliksiz' })]);
    expect(report.valid).toBe(false);
    expect(report.issues.some(issue => issue.code === 'blank-id' && issue.severity === 'error')).toBe(true);
  });

  test('rejects duplicate ids deterministically', () => {
    const report = auditCommandCenterCatalog([
      entry('search'),
      entry('search', { target: 'other-window' }),
    ]);
    expect(report.valid).toBe(false);
    expect(report.issues.filter(issue => issue.code === 'duplicate-id')).toHaveLength(1);
  });

  test('rejects blank labels and groups', () => {
    const report = auditCommandCenterCatalog([
      entry('broken', { label: ' ', group: ' ' }),
    ]);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'blank-label', 'blank-group',
    ]));
    expect(report.valid).toBe(false);
  });

  test('treats missing description as warning rather than runtime blocker', () => {
    const report = auditCommandCenterCatalog([
      entry('search', { description: ' ' }),
    ]);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: 'blank-description', severity: 'warning' }),
    ]);
  });

  test('rejects enabled commands without a target or event', () => {
    const report = auditCommandCenterCatalog([
      entry('noop', { target: undefined, event: undefined }),
    ]);
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: 'missing-action', commandId: 'noop' }),
    ]);
  });

  test('allows disabled informational commands without an action', () => {
    const report = auditCommandCenterCatalog([
      entry('coming-soon', {
        target: undefined,
        event: undefined,
        disabled: true,
      }),
    ]);
    expect(report.valid).toBe(true);
    expect(report.enabledCount).toBe(0);
    expect(report.disabledCount).toBe(1);
    expect(report.actionableCount).toBe(0);
  });

  test('warns when a command intentionally has both target and event', () => {
    const report = auditCommandCenterCatalog([
      entry('combined', { event: 'combined-event' }),
    ]);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: 'ambiguous-action', severity: 'warning' }),
    ]);
  });

  test('rejects duplicate shortcut hints across commands', () => {
    const report = auditCommandCenterCatalog([
      entry('first', { shortcut: 'Ctrl K' }),
      entry('second', { shortcut: '  ctrl   k  ' }),
    ]);
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: 'duplicate-shortcut', commandId: 'second' }),
    ]);
  });

  test('does not count blank shortcuts', () => {
    const report = auditCommandCenterCatalog([
      entry('first', { shortcut: ' ' }),
      entry('second'),
    ]);
    expect(report.shortcutCount).toBe(0);
    expect(report.valid).toBe(true);
  });

  test('normalizes unicode whitespace before duplicate shortcut comparison', () => {
    const report = auditCommandCenterCatalog([
      entry('first', { shortcut: 'Ctrl K' }),
      entry('second', { shortcut: 'ctrl k' }),
    ]);
    expect(report.valid).toBe(false);
    expect(report.issues.some(issue => issue.code === 'duplicate-shortcut')).toBe(true);
  });

  test('preserves every catalog issue for diagnostics', () => {
    const report = auditCommandCenterCatalog([
      entry('', {
        label: '',
        group: '',
        description: '',
        target: undefined,
        event: undefined,
      }),
    ]);
    expect(report.issues.map(issue => issue.code)).toEqual([
      'blank-id',
      'blank-label',
      'blank-group',
      'blank-description',
      'missing-action',
    ]);
  });

  test('counts actionable disabled commands separately from enabled commands', () => {
    const report = auditCommandCenterCatalog([
      entry('enabled'),
      entry('disabled', { disabled: true }),
    ]);
    expect(report.enabledCount).toBe(1);
    expect(report.disabledCount).toBe(1);
    expect(report.actionableCount).toBe(2);
  });

  test('freezes report and issue collection', () => {
    const report = auditCommandCenterCatalog([
      entry('broken', { description: '' }),
    ]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.issues)).toBe(true);
    expect(Object.isFrozen(report.issues[0])).toBe(true);
  });

  test('assert returns the report when catalog is valid', () => {
    const report = assertCommandCenterCatalog([
      entry('search', { shortcut: 'Ctrl K' }),
    ]);
    expect(report.valid).toBe(true);
    expect(report.commandCount).toBe(1);
  });

  test('assert throws a bounded summary for invalid catalogs', () => {
    expect(() => assertCommandCenterCatalog([
      entry('one', { target: undefined, event: undefined }),
      entry('one', { shortcut: 'X' }),
      entry('two', { shortcut: 'x' }),
    ])).toThrow(/Command center catalog contract failed/);
  });

  test('assert summary includes issue codes and relevant ids', () => {
    expect(() => assertCommandCenterCatalog([
      entry('broken', { target: undefined, event: undefined }),
    ])).toThrow('missing-action:broken');
  });

  test('validity depends only on errors, not warnings', () => {
    const report = auditCommandCenterCatalog([
      entry('warn-one', { description: '' }),
      entry('warn-two', { event: 'extra' }),
    ]);
    expect(report.issues.every(issue => issue.severity === 'warning')).toBe(true);
    expect(report.valid).toBe(true);
  });
});