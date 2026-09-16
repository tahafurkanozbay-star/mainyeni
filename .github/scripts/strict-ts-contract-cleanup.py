from pathlib import Path
import re

ROOT = Path("Webclient.app/src")


def replace_if_present(relative: str, old: str, new: str, count: int = -1) -> None:
    path = ROOT / relative
    text = path.read_text()
    if old in text:
        path.write_text(text.replace(old, new, count))


# Keep exactOptionalPropertyTypes enabled. Do not globally add `| undefined` to
# optional properties: doing so poisons Required<>/normalized configuration
# types and turns proven defaults into possibly-undefined values. Instead, fix
# call sites and public contracts where explicit undefined is genuinely part of
# the runtime input model.

# A lint-only pass can remove catch bindings that are consumed by the body.
# Restore those bindings before the strict TypeScript gate; Oxlint later removes
# only genuinely unused bindings.
for relative in [
    "gis-engine/layerScheduler.ts",
    "gis-engine/modernGisKernel.ts",
    "gis-engine/queryRuntime.ts",
    "gis-engine/sceneRuntime.ts",
    "gis-engine/spatialMemoRuntime.ts",
    "gis-engine/viewRuntime.ts",
    "gis-engine/viewState.ts",
    "platform/http/requestScheduler.ts",
    "platform/http/responseParser.ts",
]:
    path = ROOT / relative
    if path.exists():
        path.write_text(path.read_text().replace("catch {", "catch (error) {"))

# Repair type-only imports under verbatimModuleSyntax after unused-import cleanup.
render_policy = ROOT / "gis-engine/renderPolicyRuntime.ts"
if render_policy.exists():
    text = render_policy.read_text()
    text = text.replace(
        "import {\n  FEATURE_RENDER_STRATEGY,\n  FeatureRenderPlan,\n  createClusterConfiguration,\n  planFeatureRendering,\n} from './featureBudget';",
        "import {\n  FEATURE_RENDER_STRATEGY,\n  createClusterConfiguration,\n  planFeatureRendering,\n} from './featureBudget';\nimport type { FeatureRenderPlan } from './featureBudget';",
    )
    text = text.replace(
        "import { Dictionary, IconRecord } from './contracts';",
        "import type { IconRecord } from './contracts';",
    )
    if "IconRecord" not in text.split("export const GIS_VIEW_MODE", 1)[0]:
        marker = "import type { FeatureRenderPlan } from './featureBudget';\n"
        if marker in text:
            text = text.replace(marker, marker + "import type { IconRecord } from './contracts';\n", 1)
    render_policy.write_text(text)

# noUncheckedIndexedAccess: indexed record lookup is intentionally unknown.
replace_if_present(
    "data-search/normalization.ts",
    "const nested = value[key];",
    "const nested: unknown = value[key];",
)

# Optional adapter controls are omitted rather than materialized as undefined.
replace_if_present(
    "data-search/geocodingRuntime.ts",
    """    return adaptGeocodingPayload(payload, {\n      offset: 'offset' in request ? request.offset : 0,\n      limit: request.limit,\n      minimumScore: request.minimumScore,\n      dedupe: true,\n    });""",
    """    return adaptGeocodingPayload(payload, {\n      offset: 'offset' in request ? request.offset : 0,\n      ...(request.limit !== undefined ? { limit: request.limit } : {}),\n      ...(request.minimumScore !== undefined ? { minimumScore: request.minimumScore } : {}),\n      dedupe: true,\n    });""",
)

# Spatial bounds validation is nullable by design; never feed an invalid bound
# into the spatial index planner.
replace_if_present(
    "data-search/queryPlanRuntime.ts",
    """    const bounds = createSpatialBounds(request.center, request.radiusMeters);\n    const spatial = collectSpatialCandidatePositions(dataset.spatialIndex, bounds, {\n      maxCandidates: maxSpatialCandidates,\n      signal: request.signal,\n    });\n    spatialCandidatePositions = Object.freeze([...spatial.positions]);""",
    """    const bounds = createSpatialBounds(request.center, request.radiusMeters);\n    if (bounds) {\n      const spatial = collectSpatialCandidatePositions(dataset.spatialIndex, bounds, {\n        maxCandidates: maxSpatialCandidates,\n        signal: request.signal,\n      });\n      spatialCandidatePositions = Object.freeze([...spatial.positions]);\n    }""",
)

# Object.entries erases the optional alias value type unless the tuple is explicit.
replace_if_present(
    "data-search/schemaEvolution.ts",
    "  const entries = Object.entries(schema).map(([semanticField, rawAliases]) => {",
    "  const entries = (Object.entries(schema) as Array<[keyof RecordAliasSchema, readonly string[] | undefined]>).map(([semanticField, rawAliases]) => {",
)

# Cleanup callback intentionally returns void; prevent inference of () => undefined.
replace_if_present(
    "data-search/searchSession.ts",
    "    let detachExternal = () => undefined;",
    "    let detachExternal: () => void = () => undefined;",
)

# Data/Search registration APIs legitimately forward optional values. Declare
# explicit undefined only at those boundaries; do not broaden every optional
# property in the repository.
contracts = ROOT / "data-search/contracts.ts"
if contracts.exists():
    text = contracts.read_text()
    text = text.replace("readonly schema?: RecordAliasSchema;", "readonly schema?: RecordAliasSchema | undefined;")
    text = text.replace("readonly dedupe?: boolean;", "readonly dedupe?: boolean | undefined;")
    text = text.replace("readonly keepInvalid?: boolean;", "readonly keepInvalid?: boolean | undefined;")
    text = text.replace("readonly maxRecords?: number;", "readonly maxRecords?: number | undefined;")
    text = text.replace("readonly now?: number;", "readonly now?: number | undefined;")
    contracts.write_text(text)

catalog = ROOT / "data-search/datasetCatalog.ts"
if catalog.exists():
    text = catalog.read_text()
    replacements = {
        "readonly title?: string;": "readonly title?: string | undefined;",
        "readonly sourceKind?: DatasetSourceKind;": "readonly sourceKind?: DatasetSourceKind | undefined;",
        "readonly sourceId?: string | null;": "readonly sourceId?: string | null | undefined;",
        "readonly schemaVersion?: string;": "readonly schemaVersion?: string | undefined;",
        "readonly aliases?: RecordAliasSchema;": "readonly aliases?: RecordAliasSchema | undefined;",
        "readonly tags?: readonly string[];": "readonly tags?: readonly string[] | undefined;",
        "readonly ttlMs?: number;": "readonly ttlMs?: number | undefined;",
        "readonly metadata?: Readonly<Record<string, unknown>>;": "readonly metadata?: Readonly<Record<string, unknown>> | undefined;",
        "readonly schemaProfile?: DatasetSchemaProfile | null;": "readonly schemaProfile?: DatasetSchemaProfile | null | undefined;",
        "readonly integrity?: IntegrityReport | null;": "readonly integrity?: IntegrityReport | null | undefined;",
        "readonly state?: DatasetLifecycleState;": "readonly state?: DatasetLifecycleState | undefined;",
        "readonly now?: number;": "readonly now?: number | undefined;",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    catalog.write_text(text)

# DOM RequestInit accepts null rather than an explicit undefined signal.
replace_if_present(
    "platform/http/fetchTransport.ts",
    "signal: config.signal,",
    "signal: config.signal ?? null,",
)

# esri-loader 3.x runtime exposes setDefaultOptions, while its legacy typings do
# not consistently expose the full API under TS7/Bundler resolution.
types_dir = ROOT / "types"
types_dir.mkdir(exist_ok=True)
(types_dir / "esri-loader-augmentation.d.ts").write_text("""import 'esri-loader';

declare module 'esri-loader' {
  export function setDefaultOptions(options: Readonly<{
    version?: string | undefined;
    url?: string | undefined;
    css?: string | boolean | undefined;
    insertCssBefore?: string | undefined;
  }>): void;
}
""")
