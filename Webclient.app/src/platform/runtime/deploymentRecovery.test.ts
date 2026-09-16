import { describe, expect, it } from 'vitest';
import {
  canAttemptDeploymentRecovery,
  isLikelyStaleDeploymentError,
} from './deploymentRecovery';

describe('deployment recovery', () => {
  it('recognizes stale dynamic-import failures without matching ordinary application errors', () => {
    expect(isLikelyStaleDeploymentError(
      new TypeError('Failed to fetch dynamically imported module: /assets/map-OLD.js'),
    )).toBe(true);
    expect(isLikelyStaleDeploymentError('Importing a module script failed.')).toBe(true);
    expect(isLikelyStaleDeploymentError(new Error('Request timed out while loading parcel data')))
      .toBe(false);
  });

  it('allows the first recovery and throttles subsequent reloads until the cooldown expires', () => {
    const now = 100_000;
    expect(canAttemptDeploymentRecovery(null, now, 60_000)).toBe(true);
    expect(canAttemptDeploymentRecovery(now - 59_999, now, 60_000)).toBe(false);
    expect(canAttemptDeploymentRecovery(now - 60_000, now, 60_000)).toBe(true);
  });

  it('fails closed for an invalid current timestamp', () => {
    expect(canAttemptDeploymentRecovery(null, Number.NaN, 60_000)).toBe(false);
  });
});
