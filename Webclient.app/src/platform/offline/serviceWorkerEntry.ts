import { createServiceWorkerRuntime, type ServiceWorkerScopeLike } from './serviceWorkerRuntime';

const scope = globalThis as unknown as ServiceWorkerScopeLike;
const runtime = createServiceWorkerRuntime({ scope });
runtime.attach();

export { runtime as serviceWorkerRuntime };
