from pathlib import Path

ROOT = Path("Webclient.app/src")


def replace(path: str, old: str, new: str, count: int = -1) -> None:
    file = ROOT / path
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Expected type-cleanup pattern missing in {path}: {old!r}")
    file.write_text(text.replace(old, new, count))


# exactOptionalPropertyTypes: model explicit undefined where public runtime callers
# legitimately pass it, rather than weakening the compiler option.
replace(
    "data-search/contracts.ts",
    """export interface RecordNormalizationOptions {\n  readonly schema?: RecordAliasSchema;\n  readonly dedupe?: boolean;\n  readonly keepInvalid?: boolean;\n  readonly maxRecords?: number;\n}""",
    """export interface RecordNormalizationOptions {\n  readonly schema?: RecordAliasSchema | undefined;\n  readonly dedupe?: boolean | undefined;\n  readonly keepInvalid?: boolean | undefined;\n  readonly maxRecords?: number | undefined;\n}""",
)
replace(
    "data-search/contracts.ts",
    """export interface RegisterDatasetOptions extends RecordNormalizationOptions {\n  readonly now?: number;\n}""",
    """export interface RegisterDatasetOptions extends RecordNormalizationOptions {\n  readonly now?: number | undefined;\n}""",
)

catalog = ROOT / "data-search/datasetCatalog.ts"
text = catalog.read_text()
for old, new in [
    ("readonly title?: string;", "readonly title?: string | undefined;"),
    ("readonly sourceKind?: DatasetSourceKind;", "readonly sourceKind?: DatasetSourceKind | undefined;"),
    ("readonly sourceId?: string | null;", "readonly sourceId?: string | null | undefined;"),
    ("readonly schemaVersion?: string;", "readonly schemaVersion?: string | undefined;"),
    ("readonly aliases?: RecordAliasSchema;", "readonly aliases?: RecordAliasSchema | undefined;"),
    ("readonly tags?: readonly string[];", "readonly tags?: readonly string[] | undefined;"),
    ("readonly ttlMs?: number;", "readonly ttlMs?: number | undefined;"),
    ("readonly metadata?: Readonly<Record<string, unknown>>;", "readonly metadata?: Readonly<Record<string, unknown>> | undefined;"),
    ("readonly schemaProfile?: DatasetSchemaProfile | null;", "readonly schemaProfile?: DatasetSchemaProfile | null | undefined;"),
    ("readonly integrity?: IntegrityReport | null;", "readonly integrity?: IntegrityReport | null | undefined;"),
    ("readonly state?: DatasetLifecycleState;", "readonly state?: DatasetLifecycleState | undefined;"),
    ("readonly now?: number;", "readonly now?: number | undefined;"),
]:
    if old not in text:
        raise SystemExit(f"Dataset catalog type pattern missing: {old}")
    text = text.replace(old, new, 1)
catalog.write_text(text)

# Do not materialize undefined adapter options: omission remains semantically distinct.
replace(
    "data-search/geocodingRuntime.ts",
    """    return adaptGeocodingPayload(payload, {\n      offset: 'offset' in request ? request.offset : 0,\n      limit: request.limit,\n      minimumScore: request.minimumScore,\n      dedupe: true,\n    });""",
    """    return adaptGeocodingPayload(payload, {\n      offset: 'offset' in request ? request.offset : 0,\n      ...(request.limit !== undefined ? { limit: request.limit } : {}),\n      ...(request.minimumScore !== undefined ? { minimumScore: request.minimumScore } : {}),\n      dedupe: true,\n    });""",
)

# Make recursive record lookup explicitly unknown before the record guard narrows it.
replace("data-search/normalization.ts", "    const nested = value[key];", "    const nested: unknown = value[key];")

# Spatial bounds are intentionally nullable for invalid inputs; retain the guard.
replace(
    "data-search/queryPlanRuntime.ts",
    """    const bounds = createSpatialBounds(request.center, request.radiusMeters);\n    const spatial = collectSpatialCandidatePositions(dataset.spatialIndex, bounds, {\n      maxCandidates: maxSpatialCandidates,\n      signal: request.signal,\n    });\n    spatialCandidatePositions = Object.freeze([...spatial.positions]);""",
    """    const bounds = createSpatialBounds(request.center, request.radiusMeters);\n    if (bounds) {\n      const spatial = collectSpatialCandidatePositions(dataset.spatialIndex, bounds, {\n        maxCandidates: maxSpatialCandidates,\n        signal: request.signal,\n      });\n      spatialCandidatePositions = Object.freeze([...spatial.positions]);\n    }""",
)

# Object.entries loses optional property value precision without an explicit tuple type.
replace(
    "data-search/schemaEvolution.ts",
    "  const entries = Object.entries(schema).map(([semanticField, rawAliases]) => {",
    "  const entries = (Object.entries(schema) as Array<[keyof RecordAliasSchema, readonly string[] | undefined]>).map(([semanticField, rawAliases]) => {",
)

# The cleanup callback is void-returning; do not infer the narrower `() => undefined`.
replace("data-search/searchSession.ts", "    let detachExternal = () => undefined;", "    let detachExternal: () => void = () => undefined;")

# esri-loader 3.x runtime exposes setDefaultOptions but its bundled declarations do
# not expose that symbol consistently under TS7/Bundler resolution. Augment only
# the missing API surface while retaining the package's existing declarations.
types_dir = ROOT / "types"
types_dir.mkdir(parents=True, exist_ok=True)
(types_dir / "esri-loader.d.ts").write_text("""import 'esri-loader';\n\ndeclare module 'esri-loader' {\n  export function setDefaultOptions(options: Readonly<{\n    version?: string | undefined;\n    url?: string | undefined;\n    css?: boolean | string | undefined;\n    insertCssBefore?: string | undefined;\n  }>): void;\n}\n""")
