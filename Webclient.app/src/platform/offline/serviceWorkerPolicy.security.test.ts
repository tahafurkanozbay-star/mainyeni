import { describe, expect, it } from 'vitest';
import { ServiceWorkerPolicy } from './serviceWorkerPolicy';

const controlCharacters = [
  '\u0000',
  '\u0001',
  '\u0008',
  '\u0009',
  '\u000a',
  '\u000d',
  '\u001b',
  '\u001f',
  '\u007f',
] as const;

const acceptedPaths = [
  '/',
  '/service-worker.js',
  '/assets/sw.js',
  '/app/service-worker.js',
] as const;

const rejectedPaths = [
  '',
  '   ',
  'service-worker.js',
  '//remote.example/sw.js',
  'https://remote.example/sw.js',
] as const;

describe('ServiceWorkerPolicy path security', () => {
  it.each(controlCharacters)('rejects control character %j in script path before normalization', character => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl: `/sw.js${character}` })).toThrow(/control characters/);
  });

  it.each(controlCharacters)('rejects control character %j in scope before normalization', character => {
    expect(() => new ServiceWorkerPolicy({ scope: `/app${character}` })).toThrow(/control characters/);
  });

  it.each(controlCharacters)('rejects leading control character %j instead of trimming it away', character => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl: `${character}/sw.js` })).toThrow(/control characters/);
  });

  it.each(acceptedPaths)('accepts bounded same-origin script path %s', scriptUrl => {
    const policy = new ServiceWorkerPolicy({ scriptUrl });
    expect(policy.scriptUrl).toBe(scriptUrl);
    policy.dispose();
  });

  it.each(acceptedPaths)('accepts bounded same-origin scope %s', scope => {
    const policy = new ServiceWorkerPolicy({ scope });
    expect(policy.scope).toBe(scope);
    policy.dispose();
  });

  it.each(rejectedPaths)('rejects unsafe script path %j', scriptUrl => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl })).toThrow(TypeError);
  });

  it.each(rejectedPaths)('rejects unsafe scope %j', scope => {
    expect(() => new ServiceWorkerPolicy({ scope })).toThrow(TypeError);
  });

  it('does not broaden protocol-relative paths through surrounding whitespace', () => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl: '  //remote.example/sw.js  ' })).toThrow(TypeError);
  });

  it('does not broaden absolute remote URLs through surrounding whitespace', () => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl: '  https://remote.example/sw.js  ' })).toThrow(TypeError);
  });

  it('normalizes harmless surrounding spaces only after raw control validation', () => {
    const policy = new ServiceWorkerPolicy({ scriptUrl: '  /service-worker.js  ', scope: '  /app/  ' });
    expect(policy.scriptUrl).toBe('/service-worker.js');
    expect(policy.scope).toBe('/app/');
    policy.dispose();
  });

  it('bounds script path length after normalization', () => {
    expect(() => new ServiceWorkerPolicy({ scriptUrl: `/${'a'.repeat(256)}` })).toThrow(TypeError);
  });

  it('bounds scope path length after normalization', () => {
    expect(() => new ServiceWorkerPolicy({ scope: `/${'a'.repeat(128)}` })).toThrow(TypeError);
  });

  it('keeps path validation side-effect free', () => {
    const policy = new ServiceWorkerPolicy({ scriptUrl: '/service-worker.js', scope: '/' });
    expect(policy.snapshot()).toMatchObject({
      phase: 'idle',
      supported: false,
      registered: false,
      controlled: false,
      updateAvailable: false,
      consecutiveFailures: 0,
    });
    expect(policy.history()).toEqual([]);
    policy.dispose();
  });

  it('does not expose rejected path data through diagnostics because construction fails closed', () => {
    const secretBearingPath = '/sw.js\nsecret-token';
    expect(() => new ServiceWorkerPolicy({ scriptUrl: secretBearingPath })).toThrow(TypeError);
  });
});
