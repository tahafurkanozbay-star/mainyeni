import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const rewrite = (file, transform) => {
  const path = resolve(root, file);
  const source = readFileSync(path, 'utf8');
  const next = transform(source);
  if (next === source) throw new Error(`Expected lint cleanup change in ${file}`);
  writeFileSync(path, next);
};

rewrite('Webclient.app/src/Business/CommonBusiness.js', (source) =>
  source.replaceAll('catch (error) {', 'catch {')
);

rewrite('Webclient.app/src/Components/Query/ParklarQuery/ParklarQueryWindow.js', (source) =>
  source.replaceAll('catch (_) {', 'catch {')
);

rewrite('Webclient.app/src/Components/Widget/LayerList/LayerListWidget.js', (source) =>
  source.replaceAll('catch (_) {', 'catch {')
);

rewrite('Webclient.app/src/Components/Widget/AdvancedSketch/AdvancedSketchWidgetMain.js', (source) => {
  let next = source.replace('import mainbarCollapse from "react-bootstrap/esm/mainbarCollapse";\n', '');
  next = next.replace('export const AdvancedSketchWidgetMain = (props) => {', 'export const AdvancedSketchWidgetMain = (_props) => {');
  next = next.replace('const [pointSymbol, setPointSymbol] = useState(defaultPointSymbol);', 'const [pointSymbol] = useState(defaultPointSymbol);');
  return next;
});

rewrite('Webclient.app/src/Components/Query/VicinityQuery/VicinityQueryWindow.js', (source) =>
  source.replace('...(item?.attr || {}),', '...item?.attr,')
);

rewrite('Webclient.app/src/Toolbox/GisQueryHelper.js', (source) => source.replace(
`        const {
            url,
            signal,
            cache,
            live,
            ttlMs,
            cacheTags,
            pageSize,
            maxRecords,
            ...queryOptions
        } = options;`,
`        const queryOptions = { ...options };
        delete queryOptions.url;
        delete queryOptions.signal;
        delete queryOptions.cache;
        delete queryOptions.live;
        delete queryOptions.ttlMs;
        delete queryOptions.cacheTags;
        delete queryOptions.pageSize;
        delete queryOptions.maxRecords;`,
));

console.log('[arcgis-zero-lint-cleanup] applied deterministic warning cleanup.');
