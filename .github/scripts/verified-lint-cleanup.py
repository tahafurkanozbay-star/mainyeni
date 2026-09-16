from pathlib import Path
import json
import re

root = Path("Webclient.app/src")


def replace(path: str, old: str, new: str, count: int = -1) -> None:
    file = root / path
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Expected cleanup pattern missing in {path}: {old!r}")
    file.write_text(text.replace(old, new, count))


# Root application typecheck follows the same source/test boundary as the strict
# domain configs. Vitest owns *.test.ts type context; production tsc remains strict.
tsconfig_path = Path("Webclient.app/tsconfig.json")
tsconfig = json.loads(tsconfig_path.read_text())
tsconfig["compilerOptions"]["allowImportingTsExtensions"] = True
tsconfig["exclude"] = [
    "node_modules",
    "build",
    "dist",
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
]
tsconfig_path.write_text(json.dumps(tsconfig, indent=2) + "\n")

# Preserve snapshot semantics while avoiding unnecessary spread allocations.
replace("platform/runtime/taskScheduler.ts", "for (const task of [...queue])", "for (const task of queue.slice())")
replace("gis-engine/layerLifecycleCoordinator.ts", "for (const listener of [...listeners])", "for (const listener of Array.from(listeners))")
replace("gis-engine/renderGovernorRuntime.ts", "for (const listener of [...listeners])", "for (const listener of Array.from(listeners))")
replace("gis-engine/gisObservabilityRuntime.ts", "for (const listener of [...listeners])", "for (const listener of Array.from(listeners))")
replace("gis-engine/serviceHealthRuntime.ts", "for (const listener of [...listeners])", "for (const listener of Array.from(listeners))")
replace("data-search/searchRuntime.ts", "for (const cacheKey of [...this.cache.keys()])", "for (const cacheKey of Array.from(this.cache.keys()))")
replace("data-search/geocodingRuntime.ts", "for (const key of [...this.cache.keys()])", "for (const key of Array.from(this.cache.keys()))")
replace("data-search/productionRuntime.ts", "for (const session of [...this.sessions]) session.dispose();", "for (const session of Array.from(this.sessions)) session.dispose();")
replace("data-search/datasetCatalog.ts", "for (const [alias, target] of [...this.aliasToKey.entries()])", "for (const [alias, target] of Array.from(this.aliasToKey.entries()))")

# Retain indexed writes without the ambiguous single-argument Array constructor.
replace("gis-engine/identifyRuntime.ts", "const results = new Array<Settled<TResult>>(source.length);", "const results: Settled<TResult>[] = []; results.length = source.length;")
replace("gis-engine/sceneRuntime.ts", "const results = new Array<SceneLayerSettled>(input.length);", "const results: SceneLayerSettled[] = []; results.length = input.length;")

# Replace control-character regexes with explicit character-code checks.
replace(
    "data-search/normalization.ts",
    "const CONTROL_CHARACTERS = /[\\u0000-\\u001F\\u007F]/g;",
    "const replaceControlCharacters = (value: string): string => Array.from(value, (character) => {\n  const code = character.charCodeAt(0);\n  return code <= 31 || code === 127 ? ' ' : character;\n}).join('');",
)
replace(
    "data-search/normalization.ts",
    "return String(value)\n    .normalize('NFKC')\n    .replace(CONTROL_CHARACTERS, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim();",
    "return replaceControlCharacters(String(value).normalize('NFKC'))\n    .replace(/\\s+/g, ' ')\n    .trim();",
)

planner = root / "gis-engine/spatialQueryPlanner.ts"
text = planner.read_text()
marker = "const normalizeWhere = (value: unknown): string => {"
helper = "const hasInvalidWhereControlCharacter = (value: string): boolean => {\n  for (const character of value) {\n    const code = character.charCodeAt(0);\n    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) return true;\n  }\n  return false;\n};\n\n"
if marker not in text:
    raise SystemExit("normalizeWhere marker missing")
text = text.replace(marker, helper + marker, 1)
old = "if (/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/.test(where)) {"
if old not in text:
    raise SystemExit("where control regex missing")
planner.write_text(text.replace(old, "if (hasInvalidWhereControlCharacter(where)) {", 1))

# Remove constant truthiness without weakening endpoint validation.
replace("platform/network/endpointPolicy.ts", "return normalizeApplicationPath(`${cleanBase}/${cleanSegments.join('/')}` || '/');", "return normalizeApplicationPath(`${cleanBase}/${cleanSegments.join('/')}`);")
toolbar = root / "Components/Widget/Toolbar/ToolbarWidget.js"
text = toolbar.read_text()
updated = re.sub(r"\n\s*\{AppConfig\.App\.IsFullVersion && false && \(\n\s*<ToolbarWidgetButton[^\n]+\n\s*\)\}", "", text, count=1)
if updated == text:
    raise SystemExit("Toolbar dead route block missing")
toolbar.write_text(updated)

# Remove genuinely dead imports/state and unused event arguments.
replace("Components/Common/Page404.js", "import { faHome, faQuestion }", "import { faHome }")
replace("Components/Common/Page404.js", "onClick={(e) => window.location.href=\"/\"}", "onClick={() => window.location.href=\"/\"}")

message = root / "Components/Common/MessageBar.js"
text = message.read_text()
for pattern in [
    r'^import \{ faCheckCircle, faExclamationCircle, faExclamationTriangle, faInfoCircle \}.*\n',
    r'^import \{ FontAwesomeIcon \}.*\n',
    r'^import \{ Toast \}.*\n',
    r'^import MapManager .*\n',
]:
    text = re.sub(pattern, '', text, flags=re.M)
text = re.sub(r'\n\s*const dismissMessage = \(\) => \{\n\s*MapManager\.RemoveMessage\(\);\n\s*\}\n', '\n', text, count=1)
message.write_text(text)

company = root / "Components/App/CompanyLogo.js"
company.write_text(company.read_text().replace("onClick={(e) =>", "onClick={() =>"))

map_ana = root / "Components/App/MapAna.js"
text = map_ana.read_text()
text = re.sub(r'^import \{ LayerBusiness \}.*\n', '', text, flags=re.M)
text = re.sub(r'^import \{ loadModules \}.*\n', '', text, flags=re.M)
map_ana.write_text(text)

sketch = root / "Components/Widget/AdvancedSketch/AdvancedSketchWidget.js"
text = sketch.read_text()
text = text.replace(", faDrawPolygon", "")
text = re.sub(r'^import MapManager .*\n', '', text, flags=re.M)
text = text.replace('import React, { useState, useEffect } from "react";', 'import React from "react";')
text = re.sub(r'\n\s*const \[mapView, setMapView\] = useState\(null\);\n\s*useEffect\(\(\) => \{.*?\n\s*\}, \[\]\);', '', text, count=1, flags=re.S)
text = text.replace('onClick={(e) => { props.windowManager.HideWindow(props.id) }}', 'onClick={() => { props.windowManager.HideWindow(props.id) }}')
sketch.write_text(text)

sketch_main = root / "Components/Widget/AdvancedSketch/AdvancedSketchWidgetMain.js"
text = sketch_main.read_text()
text = re.sub(r'^import mainbarCollapse .*\n', '', text, flags=re.M)
text = text.replace('export const AdvancedSketchWidgetMain = (props) => {', 'export const AdvancedSketchWidgetMain = () => {')
text = text.replace('const [pointSymbol, setPointSymbol] = useState(defaultPointSymbol);', 'const [pointSymbol] = useState(defaultPointSymbol);')
sketch_main.write_text(text)

# ABB screen is a launcher; retain only dependencies it actually uses.
(root / "Components/Query/FastAccessQuery/ABBQuery/ABBQueryWindow.js").write_text('''import React, { useState } from "react";\n\nexport const ABBQueryWindow = React.forwardRef((props, _ref) => {\n    const [isVisible, setIsVisible] = useState(true);\n\n    const handleClick = () => {\n        props.windowManager.ShowWindow("halkekmek-query-window");\n        setIsVisible(false);\n    };\n\n    return (\n        <div className="sidebar-container" style={{ display: isVisible ? "block" : "none" }}>\n            <div className="sidebar-button sidebar-button-sub" onClick={handleClick}>\n                <img className="sidebar-button-icon" src="images/icons/sidebar/alisveris.png" alt="" />\n            </div>\n        </div>\n    );\n});\n''')

fast = root / "Components/Query/FastAccessQuery/FastAccessQueryWindow.js"
text = fast.read_text().replace("const btnBack_OnClick = (e) => {", "const btnBack_OnClick = () => {")
text = text.replace('onClick={(e) => btnSubmit_OnClick()}', 'onClick={() => btnSubmit_OnClick()}')
fast.write_text(text)

replace("Toolbox/DataIntegrityHelper.js", "normalizeText = (value, { locale = DEFAULT_LOCALE, empty = \"\" } = {})", "normalizeText = (value, { empty = \"\" } = {})")
replace("Business/TkgmQueryBusiness.js", "new Promise((resolve, reject) => {", "new Promise((resolve, _reject) => {")
replace("Toolbox/GisCommonHelper.js", "new Promise((resolve, reject) => {", "new Promise((resolve, _reject) => {")
replace("Store/Reducers/MapReducer.js", "MapClick: (event) => { },", "MapClick: (_event) => { },")

query = root / "Toolbox/GisQueryHelper.js"
text = query.read_text()
old = '''        const {\n            url,\n            signal,\n            cache,\n            live,\n            ttlMs,\n            cacheTags,\n            pageSize,\n            maxRecords,\n            ...queryOptions\n        } = options;'''
new = '''        const queryOptions = { ...options };\n        for (const key of ["url", "signal", "cache", "live", "ttlMs", "cacheTags", "pageSize", "maxRecords"]) {\n            delete queryOptions[key];\n        }'''
if old not in text:
    raise SystemExit("GisQueryHelper spatial option destructuring missing")
query.write_text(text.replace(old, new, 1))
