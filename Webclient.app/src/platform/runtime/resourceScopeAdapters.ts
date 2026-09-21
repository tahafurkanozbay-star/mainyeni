import type {
  ManagedResourceHandle,
  ResourceMetadata,
  ResourceScope,
} from './resourceScope';

export interface EventTargetPort {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface EventListenerBindingRequest {
  readonly owner: string;
  readonly key: string;
  readonly target: EventTargetPort;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly options?: boolean | AddEventListenerOptions;
  readonly label?: string;
  readonly metadata?: ResourceMetadata;
}

export interface SubscriptionBindingRequest {
  readonly owner: string;
  readonly key: string;
  readonly unsubscribe: () => void | Promise<void>;
  readonly label?: string;
  readonly metadata?: ResourceMetadata;
}

export interface ObserverBindingRequest<TObserver extends { disconnect(): void | Promise<void> }> {
  readonly owner: string;
  readonly key: string;
  readonly observer: TObserver;
  readonly label?: string;
  readonly metadata?: ResourceMetadata;
}

export interface AbortControllerBindingRequest {
  readonly owner: string;
  readonly key: string;
  readonly controller?: AbortController;
  readonly label?: string;
  readonly metadata?: ResourceMetadata;
  readonly reason?: unknown;
}

export interface AbortControllerBinding {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly handle: ManagedResourceHandle;
}

export interface AnimationFramePort {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export interface AnimationFrameBindingRequest {
  readonly owner: string;
  readonly key: string;
  readonly callback: FrameRequestCallback;
  readonly port?: AnimationFramePort;
  readonly label?: string;
  readonly metadata?: ResourceMetadata;
}

export interface AnimationFrameBinding {
  readonly frameId: number;
  readonly handle: ManagedResourceHandle;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const safeText = (name: string, value: string, maximum = 180): string => {
  if (typeof value !== 'string') throw new TypeError(name + ' must be a string');
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || hasControlCharacter(normalized)) {
    throw new TypeError(name + ' must contain bounded printable text');
  }
  return normalized;
};

const eventListenerRemovalOptions = (
  options: boolean | AddEventListenerOptions | undefined,
): boolean | EventListenerOptions | undefined => {
  if (typeof options === 'boolean' || options === undefined) return options;
  return { capture: options.capture === true };
};

export const bindEventListener = (
  scope: ResourceScope,
  request: EventListenerBindingRequest,
): ManagedResourceHandle => {
  const type = safeText('event type', request.type, 100);
  if (!request.target || typeof request.target.addEventListener !== 'function') {
    throw new TypeError('event target must support addEventListener');
  }
  if (typeof request.target.removeEventListener !== 'function') {
    throw new TypeError('event target must support removeEventListener');
  }

  request.target.addEventListener(type, request.listener, request.options);
  try {
    return scope.register({
      owner: request.owner,
      key: request.key,
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      cleanup: () => request.target.removeEventListener(
        type,
        request.listener,
        eventListenerRemovalOptions(request.options),
      ),
    });
  } catch (error) {
    request.target.removeEventListener(
      type,
      request.listener,
      eventListenerRemovalOptions(request.options),
    );
    throw error;
  }
};

export const bindSubscription = (
  scope: ResourceScope,
  request: SubscriptionBindingRequest,
): ManagedResourceHandle => {
  if (typeof request.unsubscribe !== 'function') {
    throw new TypeError('unsubscribe must be a function');
  }
  return scope.register({
    owner: request.owner,
    key: request.key,
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    cleanup: request.unsubscribe,
  });
};

export const bindObserver = <
  TObserver extends { disconnect(): void | Promise<void> },
>(
  scope: ResourceScope,
  request: ObserverBindingRequest<TObserver>,
): ManagedResourceHandle => {
  if (!request.observer || typeof request.observer.disconnect !== 'function') {
    throw new TypeError('observer must expose disconnect()');
  }
  return scope.register({
    owner: request.owner,
    key: request.key,
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    cleanup: () => request.observer.disconnect(),
  });
};

export const bindAbortController = (
  scope: ResourceScope,
  request: AbortControllerBindingRequest,
): AbortControllerBinding => {
  const controller = request.controller ?? new AbortController();
  if (!(controller instanceof AbortController)) {
    throw new TypeError('controller must be an AbortController');
  }
  const handle = scope.register({
    owner: request.owner,
    key: request.key,
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    cleanup: () => {
      if (!controller.signal.aborted) controller.abort(request.reason ?? 'resource-scope-closed');
    },
  });
  return Object.freeze({ controller, signal: controller.signal, handle });
};

const browserAnimationFramePort = (): AnimationFramePort => {
  if (
    typeof globalThis.requestAnimationFrame !== 'function'
    || typeof globalThis.cancelAnimationFrame !== 'function'
  ) {
    throw new TypeError('requestAnimationFrame is unavailable in this runtime');
  }
  return {
    requestAnimationFrame: (callback) => globalThis.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => globalThis.cancelAnimationFrame(handle),
  };
};

export const bindAnimationFrame = (
  scope: ResourceScope,
  request: AnimationFrameBindingRequest,
): AnimationFrameBinding => {
  if (typeof request.callback !== 'function') {
    throw new TypeError('animation frame callback must be a function');
  }
  const port = request.port ?? browserAnimationFramePort();
  let completed = false;
  let handle!: ManagedResourceHandle;
  const frameId = port.requestAnimationFrame((timestamp) => {
    completed = true;
    request.callback(timestamp);
    void handle.release('animation-frame-completed').catch(() => undefined);
  });

  try {
    handle = scope.register({
      owner: request.owner,
      key: request.key,
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      cleanup: () => {
        if (!completed) port.cancelAnimationFrame(frameId);
      },
    });
  } catch (error) {
    port.cancelAnimationFrame(frameId);
    throw error;
  }

  return Object.freeze({ frameId, handle });
};

export const bindDisposable = <TDisposable extends { dispose(): void | Promise<void> }>(
  scope: ResourceScope,
  owner: string,
  key: string,
  disposable: TDisposable,
  options: {
    readonly label?: string;
    readonly metadata?: ResourceMetadata;
  } = {},
): ManagedResourceHandle => scope.registerDisposable(owner, key, disposable, options);
