import type { RefObject } from 'react';

export interface ManagedWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void;
  readonly OnClose: () => void;
}

export interface WindowManagerLike {
  readonly ShowWindow: (windowId: string, query?: unknown) => void;
  readonly HideWindow?: (windowId: string) => void;
  readonly RegisterWindow: (windowRef: RefObject<ManagedWindowHandle | null>) => void;
  readonly UnregisterWindow?: (windowId: string, windowRef: RefObject<ManagedWindowHandle | null>) => void;
}

