import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

const safeLogType = (value: unknown): string => {
  const normalized = String(value ?? 'application').trim().replace(/[^a-zA-Z0-9_.-]/gu, '').slice(0, 48);
  return normalized || 'application';
};

export const LoggingBusiness = Object.freeze({
  CreateClientLog: async (
    logType: unknown,
    _description: unknown,
  ): Promise<Readonly<{ status: 'local-only' }>> => {
    runtimeDiagnostics.record('client.log.local-only', {
      logType: safeLogType(logType),
      remoteSubmission: false,
    });
    return Object.freeze({ status: 'local-only' as const });
  },
});
