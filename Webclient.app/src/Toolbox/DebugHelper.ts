import { DatetimeHelper } from './DatetimeHelper';
import { runtimeConfig } from '../platform/config/runtimeConfig';

const isDebugEnabled = (): boolean => {
  if (runtimeConfig.features.debugLogging) return true;

  const env = import.meta.env as Readonly<Record<string, unknown>>;
  const candidate = env.VITE_ENV_DEBUG ?? env.DEV ?? false;
  if (typeof candidate === 'boolean') return candidate;

  const normalized = String(candidate ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
};

export const DebugHelper = Object.freeze({
  Log: (message: unknown): void => {
    if (!isDebugEnabled()) return;
    console.debug(` --- [DEBUG-LOG] --- ${DatetimeHelper.GetFormatted(new Date())}`);
    console.debug(message);
  },
});
