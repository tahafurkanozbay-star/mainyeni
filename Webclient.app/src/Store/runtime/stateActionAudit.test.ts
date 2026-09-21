import { describe, expect, it } from 'vitest';
import { auditStoreAction } from './stateActionAudit';

describe('stateActionAudit', () => {
  it('reports payload shape without retaining payload values', () => {
    const audit = auditStoreAction({
      type: 'Common/Save',
      payload: {
        token: 'secret-value',
        profile: { name: 'Taha', enabled: true },
      },
    });
    expect(audit).toMatchObject({
      actionType: 'Common/Save',
      payloadKind: 'object',
      hasSensitiveKeys: true,
      hasFunctions: false,
    });
    expect(JSON.stringify(audit)).not.toContain('secret-value');
    expect(JSON.stringify(audit)).not.toContain('Taha');
  });

  it('detects callbacks and array/object payload shapes', () => {
    expect(auditStoreAction({ type: 'x', payload: () => undefined }).hasFunctions).toBe(true);
    expect(auditStoreAction({ type: 'x', payload: [1, 2] }).payloadKind).toBe('array');
    expect(auditStoreAction({ type: 'x', payload: null }).payloadKind).toBe('primitive');
    expect(auditStoreAction({ type: 'x' }).payloadKind).toBe('none');
  });

  it('bounds traversal depth and entry counts', () => {
    const payload = {
      a: { b: { c: { d: { e: 1 } } } },
      list: Array.from({ length: 50 }, (_, index) => ({ index })),
    };
    const audit = auditStoreAction({ type: 'large', payload }, {
      maxProjectionDepth: 2,
      maxProjectionEntries: 10,
    });
    expect(audit.truncated).toBe(true);
    expect(audit.estimatedEntries).toBeLessThanOrEqual(11);
  });

  it('normalizes malformed action types without throwing', () => {
    expect(auditStoreAction(null).actionType).toBe('unknown');
    expect(auditStoreAction({ type: 5 }).actionType).toBe('unknown');
  });
});
