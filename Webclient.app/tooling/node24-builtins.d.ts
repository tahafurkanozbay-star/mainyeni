/**
 * Narrow Node 24 type surface for build tooling.
 *
 * The browser TypeScript program intentionally does not install or expose the
 * full @types/node ambient environment. These declarations cover only the
 * stable built-ins used by moduleResolutionGuard.ts so browser source cannot
 * accidentally acquire Node globals or server-only module types.
 */
declare module 'node:fs' {
  interface FileStats {
    isFile(): boolean;
  }

  export function existsSync(path: string): boolean;
  export function statSync(path: string): FileStats;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function resolve(...paths: readonly string[]): string;
}
