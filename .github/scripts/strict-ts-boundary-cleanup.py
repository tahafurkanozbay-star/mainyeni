from pathlib import Path
import re

ROOT = Path("Webclient.app/src")


def edit(relative: str, transform) -> None:
    path = ROOT / relative
    text = path.read_text()
    updated = transform(text)
    if updated != text:
        path.write_text(updated)


def replace(relative: str, old: str, new: str, count: int = -1) -> None:
    edit(relative, lambda text: text.replace(old, new, count))


# noUncheckedIndexedAccess: turn unchecked array reads into explicit nullable
# reads while preserving the existing public API.
replace("experience/accessibilityRuntime.ts", "return focusElement(getFocusableElements(container)[0]);", "return focusElement(getFocusableElements(container)[0] ?? null);")
replace("experience/accessibilityRuntime.ts", "if (direction === \"first\") return focusElement(elements[0]) ? elements[0] : null;", "if (direction === \"first\") { const first = elements[0] ?? null; return focusElement(first) ? first : null; }")
replace("experience/accessibilityRuntime.ts", "const last = elements[elements.length - 1];", "const last = elements[elements.length - 1] ?? null;")
replace("experience/accessibilityRuntime.ts", "const next = elements[nextIndex];", "const next = elements[nextIndex] ?? null;")
replace("gis-engine/adaptivePerformanceRuntime.ts", "return sorted[index];", "return sorted[index] ?? 0;")

# Optional scheduler controls are omitted when undefined; exact optional property
# semantics remain enabled rather than being globally weakened.
replace(
    "gis-engine/arcgisQueryExecutor.ts",
    """      priority: options.priority,\n      signal: options.signal,\n      cache: options.cache,\n      cacheTtlMs: options.cacheTtlMs ?? dependencies.defaultCacheTtlMs,\n      staleTtlMs: options.staleTtlMs ?? dependencies.defaultStaleTtlMs,\n      allowStale: options.allowStale,\n      allowStaleOnError: options.allowStaleOnError,\n      estimatedBytes: options.estimatedBytes,""",
    """      ...(options.priority !== undefined ? { priority: options.priority } : {}),\n      ...(options.signal !== undefined ? { signal: options.signal } : {}),\n      ...(options.cache !== undefined ? { cache: options.cache } : {}),\n      ...((options.cacheTtlMs ?? dependencies.defaultCacheTtlMs) !== undefined ? { cacheTtlMs: options.cacheTtlMs ?? dependencies.defaultCacheTtlMs } : {}),\n      ...((options.staleTtlMs ?? dependencies.defaultStaleTtlMs) !== undefined ? { staleTtlMs: options.staleTtlMs ?? dependencies.defaultStaleTtlMs } : {}),\n      ...(options.allowStale !== undefined ? { allowStale: options.allowStale } : {}),\n      ...(options.allowStaleOnError !== undefined ? { allowStaleOnError: options.allowStaleOnError } : {}),\n      ...(options.estimatedBytes !== undefined ? { estimatedBytes: options.estimatedBytes } : {}),""",
)

# Identify runtime: bounds-checked array access and conditional cancellation.
replace("gis-engine/identifyRuntime.ts", "value: await worker(source[index], index)", "value: await worker(source[index]!, index)")
replace("gis-engine/identifyRuntime.ts", "if (Number.isFinite(view?.resolution)) params.resolution = view.resolution;", "if (Number.isFinite(view?.resolution)) params.resolution = Number(view.resolution);")
replace("gis-engine/identifyRuntime.ts", "if (Number.isFinite(options.dpi)) params.dpi = options.dpi;", "if (Number.isFinite(options.dpi)) params.dpi = Number(options.dpi);")
replace("gis-engine/identifyRuntime.ts", "failures.push({ target: source[index], error: entry.reason })", "failures.push({ target: source[index]!, error: entry.reason })")
replace(
    "gis-engine/identifyRuntime.ts",
    "executeGlobalIdentify(view, event, { ...options, signal: localController?.signal })",
    "executeGlobalIdentify(view, event, { ...options, ...(localController ? { signal: localController.signal } : {}) })",
)

# Layer state hydration should not explicitly materialize absent scale values.
replace(
    "gis-engine/layerRuntime.ts",
    """      minScale: persisted.minScale,\n      maxScale: persisted.maxScale,""",
    """      ...(persisted.minScale !== undefined ? { minScale: persisted.minScale } : {}),\n      ...(persisted.maxScale !== undefined ? { maxScale: persisted.maxScale } : {}),""",
)

# Layer scheduler: optional signals are represented by omission; priority fallback
# is a number rather than the literal 100 type.
replace("gis-engine/layerScheduler.ts", "const normalizePriority = (value: unknown, fallback = LAYER_LOAD_PRIORITY.VISIBLE): number =>", "const normalizePriority = (value: unknown, fallback: number = LAYER_LOAD_PRIORITY.VISIBLE): number =>")
replace(
    "gis-engine/layerScheduler.ts",
    "const subscriber: Subscriber<T> = { signal, resolve, reject, done: false, abortHandler: null };",
    "const subscriber: Subscriber<T> = { ...(signal ? { signal } : {}), resolve, reject, done: false, abortHandler: null };",
)
replace(
    "gis-engine/layerScheduler.ts",
    "entry.loader({ layer: entry.layer, layerId: entry.layerId, signal: entry.controller?.signal, priority: entry.priority, metadata: { ...entry.metadata } })",
    "entry.loader({ layer: entry.layer, layerId: entry.layerId, ...(entry.controller ? { signal: entry.controller.signal } : {}), priority: entry.priority, metadata: { ...entry.metadata } })",
)
replace(
    "gis-engine/layerScheduler.ts",
    "loadLayer(layer, { layer, layerId, signal, priority, metadata })",
    "loadLayer(layer, { layer, layerId, ...(signal ? { signal } : {}), priority, metadata })",
)
replace(
    "gis-engine/layerScheduler.ts",
    "update({ type: 'LOAD_SUCCESS', layerId, requestId, featureCount: Number.isFinite(options.featureCount) ? options.featureCount : undefined, loadedAt: new Date(clock()).toISOString() })",
    "update({ type: 'LOAD_SUCCESS', layerId, requestId, ...(Number.isFinite(options.featureCount) ? { featureCount: Number(options.featureCount) } : {}), loadedAt: new Date(clock()).toISOString() })",
)

# State input deliberately accepts user-facing string aliases without widening
# the canonical MeasurementState contract.
replace(
    "gis-engine/measurementRuntime.ts",
    "export interface MeasurementStateInput extends Partial<MeasurementState> { activeTool?: MeasurementTool | string; }",
    "export interface MeasurementStateInput extends Omit<Partial<MeasurementState>, 'activeTool'> { activeTool?: MeasurementTool | string; }",
)

# Modern kernel composition omits optional collaborators when absent and
# normalizes service-health nullable metadata explicitly.
replace(
    "gis-engine/modernGisKernel.ts",
    """  const observability = configuration.observability || createGisObservabilityRuntime({\n    now: clock,\n    onListenerError: configuration.onListenerError,\n  });""",
    """  const observability = configuration.observability || createGisObservabilityRuntime({\n    now: clock,\n    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),\n  });""",
)
replace(
    "gis-engine/modernGisKernel.ts",
    """  const serviceHealth = configuration.serviceHealth || createServiceHealthRuntime({\n    now: clock,\n    onListenerError: configuration.onListenerError,""",
    """  const serviceHealth = configuration.serviceHealth || createServiceHealthRuntime({\n    now: clock,\n    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),""",
)
replace(
    "gis-engine/modernGisKernel.ts",
    """  const renderGovernor = configuration.renderGovernor || createRenderGovernor({\n    now: clock,\n    device: configuration.device,\n    initialTier: configuration.initialTier,\n    onListenerError: configuration.onListenerError,\n  });""",
    """  const renderGovernor = configuration.renderGovernor || createRenderGovernor({\n    now: clock,\n    ...(configuration.device ? { device: configuration.device } : {}),\n    ...(configuration.initialTier ? { initialTier: configuration.initialTier } : {}),\n    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),\n  });""",
)
replace(
    "gis-engine/modernGisKernel.ts",
    """      maxRecordCount: contract.maxRecordCount,\n      metadataRevision: registration.metadataRevision,""",
    """      maxRecordCount: contract.maxRecordCount ?? null,\n      metadataRevision: registration.metadataRevision ?? null,""",
)

# Recursive diagnostics use an interface for object recursion; TS7 rejects the
# previous circular Record alias even though the runtime representation is safe.
replace(
    "platform/bootstrap/bootstrapDiagnostics.ts",
    "export type DiagnosticValue = DiagnosticPrimitive | readonly DiagnosticValue[] | Readonly<Record<string, DiagnosticValue>>;",
    "export interface DiagnosticObject { readonly [key: string]: DiagnosticValue; }\nexport type DiagnosticValue = DiagnosticPrimitive | readonly DiagnosticValue[] | DiagnosticObject;",
)

# Fetch RequestInit uses null for an absent signal. Optional timer hooks are
# omitted so the linked abort scope retains its defaults.
replace("platform/http/fetchTransport.ts", "signal: config.signal || undefined,", "signal: config.signal ?? null,")
replace(
    "platform/http/fetchTransport.ts",
    """  const linked = createLinkedAbortScope({\n    signal: config.signal,\n    timeoutMs: config.timeout,\n    setTimeout: dependencies.setTimeout,\n    clearTimeout: dependencies.clearTimeout\n  });""",
    """  const linked = createLinkedAbortScope({\n    ...(config.signal !== undefined ? { signal: config.signal } : {}),\n    timeoutMs: config.timeout,\n    ...(dependencies.setTimeout ? { setTimeout: dependencies.setTimeout } : {}),\n    ...(dependencies.clearTimeout ? { clearTimeout: dependencies.clearTimeout } : {})\n  });""",
)

# Optional AbortSignals are semantically absent when undefined. Make this
# explicit only on signal boundary declarations; unlike the earlier broad
# optional-property rewrite this does not contaminate normalized numeric config.
for relative in [
    "gis-engine/identifyRuntime.ts",
    "gis-engine/layerScheduler.ts",
    "gis-engine/queryRuntime.ts",
    "gis-engine/sceneRuntime.ts",
    "gis-engine/serviceRegistry.ts",
    "gis-engine/spatialMemoRuntime.ts",
    "platform/bootstrap/bootstrapCore.ts",
    "platform/http/contracts.ts",
    "platform/http/requestCoordinator.ts",
    "platform/http/requestScheduler.ts",
    "platform/http/retryPolicy.ts",
    "platform/runtime/runtimeKernel.ts",
]:
    path = ROOT / relative
    if not path.exists():
        continue
    text = path.read_text()
    text = text.replace("signal?: AbortSignal;", "signal?: AbortSignal | undefined;")
    text = text.replace("signal?: AbortSignal | null;", "signal?: AbortSignal | null | undefined;")
    text = text.replace("externalSignal?: AbortSignal;", "externalSignal?: AbortSignal | undefined;")
    path.write_text(text)
