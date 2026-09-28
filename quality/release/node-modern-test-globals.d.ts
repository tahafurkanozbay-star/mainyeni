import test from 'node:test';

/**
 * Minimal Node 24 declarations used by the repository-level release QA suite.
 *
 * The Webclient lockfile intentionally does not carry the full @types/node
 * surface. Keep this bridge narrow so release tooling cannot accidentally
 * depend on unrelated ambient Node APIs while still matching the Node 24
 * runtime used by Release QA.
 */
declare module 'node:test' {
  export const describe: typeof test;
  export const it: typeof test;
}

declare global {
  const Buffer: {
    byteLength(input: string, encoding?: string): number;
  };
}

export {};
