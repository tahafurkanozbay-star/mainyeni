import type { RefObject } from 'react';

/**
 * Structural window handle shared by Experience surfaces and the canonical
 * WindowManager. Legacy windows do not all expose visibility/lifecycle fields,
 * so consumers must treat those capabilities as optional instead of narrowing
 * the manager's accepted registration shape.
 */
export interface ManagedWindowHandle {
  readonly id: string;
  readonly visible?: boolean;
  readonly minimized?: boolean;
  readonly OnShow?: () => void;
  readonly OnClose?: () => void;
  readonly [key: string]: unknown;
}

export interface WindowManagerLike {
  readonly ShowWindow: (windowId: string, query?: unknown) => void;
  readonly HideWindow?: (windowId: string) => void;
  readonly RegisterWindow: (windowRef: RefObject<ManagedWindowHandle | null>) => void;
  readonly UnregisterWindow?: (windowId: string, windowRef: RefObject<ManagedWindowHandle | null>) => void;
}
