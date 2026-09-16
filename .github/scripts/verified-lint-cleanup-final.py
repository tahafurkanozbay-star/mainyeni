from pathlib import Path
import re

ROOT = Path("Webclient.app/src")


def edit(relative: str, transform) -> None:
    path = ROOT / relative
    text = path.read_text()
    updated = transform(text)
    path.write_text(updated)


def remove_catch_bindings(relative: str) -> None:
    edit(relative, lambda text: re.sub(r"catch\s*\((?:_|_error|error)\)\s*\{", "catch {", text))


def remove_import_line(relative: str, token: str) -> None:
    edit(relative, lambda text: "\n".join(
        line for line in text.splitlines() if not (line.startswith("import ") and token in line)
    ) + "\n")


# Unused catch bindings are semantically equivalent to optional catch binding.
for relative in [
    "Components/Query/RouteQuery/RouteQueryWindow.js",
    "Components/Query/ParklarQuery/ParklarQueryWindow.js",
    "gis-engine/serviceCatalog.ts",
    "Components/Query/AAQuery/AAQueryWindow.js",
    "experience/accessibilityRuntime.ts",
    "experience/experienceRuntime.ts",
    "gis-engine/layerScheduler.ts",
    "gis-engine/modernGisKernel.ts",
    "gis-engine/layerOwnership.ts",
    "Components/Widget/GlobalIdentify/GlobalIdentifyWidget.js",
    "Components/Widget/Feedback/FeedbackForm.js",
    "Components/Widget/Measurement/MeasurementWidget.js",
    "Components/Widget/LayerList/LayerListWidget.js",
    "gis-engine/viewRuntime.ts",
    "gis-engine/sceneRuntime.ts",
    "Components/Query/_Common/QueryInteractionRuntime.js",
    "platform/http/responseParser.ts",
    "platform/http/requestScheduler.ts",
    "platform/http/networkDiagnostics.ts",
    "Toolbox/RecordSchemaRuntime.js",
    "Business/CommonBusiness.js",
    "gis-engine/layerFactory.ts",
    "gis-engine/measurementRuntime.ts",
    "Toolbox/SearchSessionRuntime.js",
    "Business/NumberingQueryBusiness.js",
    "gis-engine/spatialMemoRuntime.ts",
    "Components/Common/ExperienceUXLayer.js",
    "Components/Query/EventQuery/EventQueryWindow.js",
    "gis-engine/viewState.ts",
    "gis-engine/arcgisRequestScheduler.js",
    "gis-engine/queryRuntime.ts",
    "App.test.js",
    "data-search/normalization.ts",
]:
    remove_catch_bindings(relative)

# Remaining launcher/UI unused identifiers and event arguments.
edit(
    "Components/Query/FastAccessQuery/FastAccessQueryWindow.js",
    lambda text: text
        .replace(", FiPhone", "")
        .replace("const btnBack_OnClick = (e) => {", "const btnBack_OnClick = () => {")
        .replace("onClick={(e) => btnSubmit_OnClick()}", "onClick={() => btnSubmit_OnClick()}"),
)

# MapAna only needs the hooks/services exercised by its current lifecycle.
def clean_map_ana(text: str) -> str:
    text = re.sub(
        r'import React, \{[^}]+\} from "react";',
        'import React, { useEffect, useImperativeHandle, useState } from "react";',
        text,
        count=1,
    )
    for token in ["DebugHelper", "CommonBusiness", "LayerBusiness", "Constants_ServiceResultType", "loadModules"]:
        text = "\n".join(
            line for line in text.splitlines() if not (line.startswith("import ") and token in line)
        ) + "\n"
    return text

edit("Components/App/MapAna.js", clean_map_ana)

# Unused parameters that are part of public callback signatures keep arity but are marked intentionally unused.
for relative, pairs in {
    "Store/Reducers/MapReducer.js": [("MapClick: (event)", "MapClick: (_event)")],
    "Components/App/CompanyLogo.js": [("onClick={(e) =>", "onClick={() =>")],
    "Components/Widget/AdvancedSketch/AdvancedSketchWidget.js": [("onClick={(e) =>", "onClick={() =>")],
    "Components/Widget/AdvancedSketch/AdvancedSketchWidgetMain.js": [(" = (props) =>", " = (_props) =>")],
    "Components/Common/Page404.js": [("onClick={(e) =>", "onClick={() =>")],
    "Toolbox/GisCommonHelper.js": [("(resolve, reject)", "(resolve, _reject)")],
    "Business/TkgmQueryBusiness.js": [("(resolve, reject)", "(resolve, _reject)")],
}.items():
    def transform(text, pairs=pairs):
        for old, new in pairs:
            text = text.replace(old, new)
        return text
    edit(relative, transform)

# Remove known dead imports/state left by legacy UI shells.
edit("Components/Common/Page404.js", lambda text: text.replace("faHome, faQuestion", "faHome"))
edit("Components/Widget/AdvancedSketch/AdvancedSketchWidget.js", lambda text: text.replace(", faDrawPolygon", ""))
remove_import_line("gis-engine/renderPolicyRuntime.ts", "Dictionary")

# Preserve iteration snapshot semantics without linted spread allocations.
for relative, replacements in {
    "data-search/datasetCatalog.ts": [("[...this.aliasToKey.entries()]", "Array.from(this.aliasToKey.entries())")],
    "gis-engine/layerLifecycleCoordinator.ts": [("[...listeners]", "Array.from(listeners)")],
    "gis-engine/renderGovernorRuntime.ts": [("[...listeners]", "Array.from(listeners)")],
    "gis-engine/gisObservabilityRuntime.ts": [("[...listeners]", "Array.from(listeners)")],
    "gis-engine/serviceHealthRuntime.ts": [("[...listeners]", "Array.from(listeners)")],
    "platform/runtime/taskScheduler.ts": [("[...queue]", "queue.slice()")],
    "data-search/geocodingRuntime.ts": [("[...this.cache.keys()]", "Array.from(this.cache.keys())")],
    "data-search/searchRuntime.ts": [("[...this.cache.keys()]", "Array.from(this.cache.keys())")],
    "data-search/productionRuntime.ts": [("[...this.sessions]", "Array.from(this.sessions)")],
}.items():
    def transform(text, replacements=replacements):
        for old, new in replacements:
            text = text.replace(old, new)
        return text
    edit(relative, transform)

# Modern object spread ignores null/undefined; redundant empty object fallbacks are unnecessary.
for relative in [
    "gis-engine/arcgisQueryRuntime.ts",
    "gis-engine/layerLifecycleManager.ts",
]:
    edit(relative, lambda text: re.sub(r"\.\.\.\(([^()\n]+?)\s*(?:\|\||\?\?)\s*\{\}\)", r"...\1", text))

# Avoid ambiguous single-argument Array constructors while preserving indexed writes.
edit(
    "gis-engine/identifyRuntime.ts",
    lambda text: re.sub(
        r"const results = new Array<Settled<TResult>>\(source\.length\);",
        "const results: Settled<TResult>[] = []; results.length = source.length;",
        text,
    ),
)
edit(
    "gis-engine/sceneRuntime.ts",
    lambda text: re.sub(
        r"const results = new Array<SceneLayerSettled>\(input\.length\);",
        "const results: SceneLayerSettled[] = []; results.length = input.length;",
        text,
    ),
)

# Remove constant-truthiness leftovers without weakening endpoint validation.
edit(
    "platform/network/endpointPolicy.ts",
    lambda text: text.replace(
        "return normalizeApplicationPath(`${cleanBase}/${cleanSegments.join('/')}` || '/');",
        "return normalizeApplicationPath(`${cleanBase}/${cleanSegments.join('/')}`);",
    ),
)
edit(
    "Components/Widget/Toolbar/ToolbarWidget.js",
    lambda text: re.sub(
        r"\n\s*\{AppConfig\.App\.IsFullVersion && false && \(\n\s*<ToolbarWidgetButton[^\n]+\n\s*\)\}",
        "",
        text,
        count=1,
    ),
)

# Replace control-character regexes with explicit character-code checks when still present.
def clean_normalization(text: str) -> str:
    text = text.replace(
        "const CONTROL_CHARACTERS = /[\\u0000-\\u001F\\u007F]/g;",
        "const replaceControlCharacters = (value: string): string => Array.from(value, (character) => {\n  const code = character.charCodeAt(0);\n  return code <= 31 || code === 127 ? ' ' : character;\n}).join('');",
    )
    text = text.replace(
        ".replace(CONTROL_CHARACTERS, ' ')",
        ".split('').map((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127 ? ' ' : character; }).join('')",
    )
    return text

edit("data-search/normalization.ts", clean_normalization)

# Spatial where-clause control validation uses explicit code points, not a linted control regex.
def clean_spatial_planner(text: str) -> str:
    pattern = r"if \(/\[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\]/\.test\(where\)\) \{"
    if re.search(pattern, text):
        marker = "const normalizeWhere = (value: unknown): string => {"
        helper = (
            "const hasInvalidWhereControlCharacter = (value: string): boolean => {\n"
            "  for (const character of value) {\n"
            "    const code = character.charCodeAt(0);\n"
            "    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) return true;\n"
            "  }\n"
            "  return false;\n"
            "};\n\n"
        )
        if "const hasInvalidWhereControlCharacter" not in text:
            text = text.replace(marker, helper + marker, 1)
        text = re.sub(pattern, "if (hasInvalidWhereControlCharacter(where)) {", text)
    return text

edit("gis-engine/spatialQueryPlanner.ts", clean_spatial_planner)

# The ABB surface is only a launcher. Keep only runtime dependencies it actually uses.
(ROOT / "Components/Query/FastAccessQuery/ABBQuery/ABBQueryWindow.js").write_text('''import React, { useState } from "react";\n\nexport const ABBQueryWindow = React.forwardRef((props, _ref) => {\n    const [isVisible, setIsVisible] = useState(true);\n\n    const handleClick = () => {\n        props.windowManager.ShowWindow("halkekmek-query-window");\n        setIsVisible(false);\n    };\n\n    return (\n        <div className="sidebar-container" style={{ display: isVisible ? "block" : "none" }}>\n            <div className="sidebar-button sidebar-button-sub" onClick={handleClick}>\n                <img className="sidebar-button-icon" src="images/icons/sidebar/alisveris.png" alt="" />\n            </div>\n        </div>\n    );\n});\n''')
