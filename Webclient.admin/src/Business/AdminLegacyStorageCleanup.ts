/**
 * One-way migration hygiene for older Admin bundles.
 *
 * The active authenticated state is managed only inside the currently
 * running JavaScript module. Older browser-stored copies are deleted, never
 * loaded or interpreted. Individual operations are guarded because browsers
 * can reject access in private, embedded, or policy-constrained contexts.
 */
export function purgeLegacyAdminStorage(key: string): void {
  try {
    globalThis.sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; the active session remains memory-only.
  }
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // Do not block a fresh login when prior storage is inaccessible.
  }
}
