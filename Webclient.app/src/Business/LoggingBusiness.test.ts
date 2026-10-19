import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LoggingBusiness } from './LoggingBusiness';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

vi.mock('../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: { record: vi.fn() },
}));

describe('LoggingBusiness', () => {
  beforeEach(() => vi.clearAllMocks());

  test('records bounded local metadata without transmitting the description', async () => {
    await expect(LoggingBusiness.CreateClientLog('UI log !!', { privateText: 'do not send' }))
      .resolves.toEqual({ status: 'local-only' });
    expect(runtimeDiagnostics.record).toHaveBeenCalledWith('client.log.local-only', {
      logType: 'UIlog',
      remoteSubmission: false,
    });
    expect(JSON.stringify(vi.mocked(runtimeDiagnostics.record).mock.calls)).not.toContain('do not send');
  });

  test('handles empty log types locally', async () => {
    await expect(LoggingBusiness.CreateClientLog('', null)).resolves.toEqual({ status: 'local-only' });
    expect(runtimeDiagnostics.record).toHaveBeenCalledWith('client.log.local-only', {
      logType: 'application',
      remoteSubmission: false,
    });
  });
});
