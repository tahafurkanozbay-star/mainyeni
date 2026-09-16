declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export interface Stats {
    size: number;
    mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function statSync(path: string): Stats;
  export function lstatSync(path: string): Stats;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function realpathSync(path: string): string;
}

declare module 'node:path' {
  export const sep: string;
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function extname(path: string): string;
  export function basename(path: string, suffix?: string): string;
  export function dirname(path: string): string;
  export function normalize(path: string): string;
  export function isAbsolute(path: string): boolean;
}

declare module 'node:crypto' {
  export interface Hash {
    update(value: string): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:test' {
  type TestFunction = (name: string, fn: () => void | Promise<void>) => void;
  const test: TestFunction;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, pattern: RegExp, message?: string): void;
    rejects(fn: () => Promise<unknown>, error?: RegExp | ((error: unknown) => boolean)): Promise<void>;
    throws(fn: () => unknown, error?: RegExp | ((error: unknown) => boolean)): void;
  }
  const assert: Assert;
  export default assert;
}

declare const process: {
  argv: string[];
  cwd(): string;
  exitCode?: number;
  env: Record<string, string | undefined>;
  stdout: { write(value: string): void };
  stderr: { write(value: string): void };
};
