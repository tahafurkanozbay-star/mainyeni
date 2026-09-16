from pathlib import Path
import re

ROOT = Path("Webclient.app/src")

# Keep exactOptionalPropertyTypes enabled. Runtime contracts that intentionally
# forward explicit undefined values declare that intent instead of weakening TS.
property_pattern = re.compile(
    r"^(\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\?\s*:\s*)([^;\n]+)(;\s*)$",
    re.MULTILINE,
)

for directory in ["data-search", "gis-engine", "platform", "experience"]:
    for path in (ROOT / directory).rglob("*.ts"):
        text = path.read_text()

        def add_explicit_undefined(match: re.Match[str]) -> str:
            prefix, annotation, suffix = match.groups()
            if re.search(r"\bundefined\b", annotation):
                return match.group(0)
            return f"{prefix}{annotation} | undefined{suffix}"

        path.write_text(property_pattern.sub(add_explicit_undefined, text))

# A previous lint-only pass removed some catch bindings even where the body
# consumes `error`. Restore those bindings; Oxlint later removes only unused ones.
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
    path.write_text(path.read_text().replace("catch {", "catch (error) {"))

# Repair type-only imports after the legacy unused-import cleanup.
render_policy = ROOT / "gis-engine/renderPolicyRuntime.ts"
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
    text = text.replace(marker, marker + "import type { IconRecord } from './contracts';\n", 1)
render_policy.write_text(text)

# noUncheckedIndexedAccess: indexed record lookup is intentionally unknown.
normalization = ROOT / "data-search/normalization.ts"
normalization.write_text(
    normalization.read_text().replace(
        "const nested = value[key];",
        "const nested: unknown = value[key];",
    )
)

# DOM RequestInit accepts null, not explicit undefined, for signal.
fetch_transport = ROOT / "platform/http/fetchTransport.ts"
text = fetch_transport.read_text().replace(
    "signal: config.signal,",
    "signal: config.signal ?? null,",
)
fetch_transport.write_text(text)

# esri-loader runtime exposes setDefaultOptions but its legacy typings omit it.
types_dir = ROOT / "types"
types_dir.mkdir(exist_ok=True)
(types_dir / "esri-loader-augmentation.d.ts").write_text("""import 'esri-loader';

declare module 'esri-loader' {
  export function setDefaultOptions(options: {
    readonly url?: string | undefined;
    readonly css?: string | boolean | undefined;
  }): void;
}
""")
