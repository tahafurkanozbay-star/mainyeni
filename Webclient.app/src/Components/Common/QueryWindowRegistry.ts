import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface QueryManagedWindowProps {
  readonly id: string;
  readonly windowManager: unknown;
  readonly [key: string]: unknown;
}
export type QueryWindowComponent = ComponentType<QueryManagedWindowProps>;
type QueryWindowModule = Readonly<Record<string, unknown>>;
type QueryWindowLoader = () => Promise<QueryWindowModule>;
interface QueryWindowSpec { readonly id: string; readonly label: string; readonly loader: QueryWindowLoader; readonly exportName: string }

const QUERY_WINDOW_SPECS = [
  ['assemblyarea-query-window','Toplanma alanları',() => import('../Query/AAQuery/AAQueryWindow'),'AssemblyAreaQueryWindow'],
  ['baskentmarket-query-window','Başkent Market',() => import('../Query/BaskentMarketQuery/BaskentMarketQueryWindow'),'BaskentMarketQueryWindow'],
  ['cityblockparcel-query-window','Ada parsel sorgusu',() => import('../Query/CityBlockParcelQuery/CityBlockParcelQueryWindow'),'CityBlockParcelQueryWindow'],
  ['culture-query-window','Kültür ve sanat',() => import('../Query/CultureQuery/CultureQueryWindow'),'CultureQueryWindow'],
  ['ego-query-window','EGO sorgusu',() => import('../Query/EgoQuery/EgoQueryWindow'),'EgoQueryWindow'],
  ['event-query-window','Etkinlikler',() => import('../Query/EventQuery/EventQueryWindow'),'EventQueryWindow'],
  ['halkekmek-query-window','Halk Ekmek',() => import('../Query/HalkEkmekQuery/HalkEkmekQueryWindow'),'HalkEkmekQueryWindow'],
  ['patidostu-query-window','Pati Dostu',() => import('../Query/PatiDostuQuery/PatiDostuQueryWindow'),'PatiDostuQueryWindow'],
  ['teknolojimerkezi-query-window','Teknoloji merkezleri',() => import('../Query/TeknolojiMerkezleriQuery/TeknolojiMerkezleriQueryWindow'),'TeknolojiMerkezleriQueryWindow'],
  ['aileyasammerkezleri-query-window','Aile yaşam merkezleri',() => import('../Query/AileYasamMerkezleriQery/AileYasamMerkezleriQeryWindow'),'AileYasamMerkezleriQeryWindow'],
  ['park-query-window','Parklar',() => import('../Query/ParklarQuery/ParklarQueryWindow'),'ParklarQueryWindow'],
  ['sportesisleri-query-window','Spor tesisleri',() => import('../Query/SporTesisleriQuery/SporTesisleriQueryWindow'),'SporTesisleriQueryWindow'],
  ['wifinoktalari-query-window','Wi-Fi noktaları',() => import('../Query/WifiNoktalariQuery/WifiNoktalariQueryWindow'),'WifiNoktalariQueryWindow'],
  ['kutuphaneler-query-window','Kütüphaneler',() => import('../Query/KutuphanelerQuery/KutuphanelerQueryWindow'),'KutuphanelerQueryWindow'],
  ['genelarama-query-window','Genel arama',() => import('../Query/GenelAramaQuery/GenelAramaQeryWindow'),'GenelAramaQeryWindow'],
  ['numbering-query-window','Numarataj sorgusu',() => import('../Query/NumberingQuery/NumberingQueryWindow'),'NumberingQueryWindow'],
  ['report-query-window','Rapor sorgusu',() => import('../Query/ReportQuery/ReportQueryWindow'),'ReportQueryWindow'],
  ['route-query-window','Rota sorgusu',() => import('../Query/RouteQuery/RouteQueryWindow'),'RouteQueryWindow'],
  ['taxi-query-window','Taksi sorgusu',() => import('../Query/TaxiQuery/TaxiQueryWindow'),'TaxiQueryWindow'],
  ['vicinity-query-window','Yakın çevre sorgusu',() => import('../Query/VicinityQuery/VicinityQueryWindow'),'VicinityQueryWindow'],
] as const;

type RawSpec = typeof QUERY_WINDOW_SPECS[number];
export type QueryWindowId = RawSpec[0];
export interface QueryWindowDefinition { readonly id: QueryWindowId; readonly label: string; readonly component: LazyExoticComponent<QueryWindowComponent>; readonly preload: () => Promise<QueryWindowComponent> }
const modulePromises = new Map<QueryWindowId, Promise<QueryWindowComponent>>();
const toSpec = (raw: RawSpec): QueryWindowSpec & { readonly id: QueryWindowId } => ({ id: raw[0], label: raw[1], loader: raw[2], exportName: raw[3] });
const loadNamed = (spec: QueryWindowSpec & { readonly id: QueryWindowId }): Promise<QueryWindowComponent> => {
  const cached = modulePromises.get(spec.id); if (cached) return cached;
  const pending = spec.loader().then(module => { const candidate = module[spec.exportName]; if (!candidate) throw new Error(`Lazy window export not found: ${spec.exportName}`); return candidate as QueryWindowComponent; }).catch(error => { modulePromises.delete(spec.id); throw error; });
  modulePromises.set(spec.id, pending); return pending;
};
export const QUERY_WINDOW_DEFINITIONS: readonly QueryWindowDefinition[] = Object.freeze(QUERY_WINDOW_SPECS.map(raw => { const spec = toSpec(raw); return { id: spec.id, label: spec.label, component: lazy(async () => ({ default: await loadNamed(spec) })), preload: () => loadNamed(spec) }; }));
export const QUERY_WINDOW_IDS = Object.freeze(QUERY_WINDOW_DEFINITIONS.map(item => item.id));
const definitionById = new Map(QUERY_WINDOW_DEFINITIONS.map(item => [item.id, item]));
export const isQueryWindowId = (value: unknown): value is QueryWindowId => typeof value === 'string' && definitionById.has(value as QueryWindowId);
export const getQueryWindowDefinition = (id: string): QueryWindowDefinition | undefined => isQueryWindowId(id) ? definitionById.get(id) : undefined;
export const preloadQueryWindow = (id: string): Promise<QueryWindowComponent> | null => getQueryWindowDefinition(id)?.preload() ?? null;
