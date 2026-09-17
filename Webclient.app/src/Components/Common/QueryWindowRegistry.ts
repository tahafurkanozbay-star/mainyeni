import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface QueryManagedWindowProps {
  readonly id: string;
  readonly windowManager: unknown;
  readonly [key: string]: unknown;
}

export type QueryWindowComponent = ComponentType<QueryManagedWindowProps>;

type QueryWindowModule = Readonly<Record<string, unknown>>;
type QueryWindowLoader = () => Promise<QueryWindowModule>;

interface QueryWindowSpec {
  readonly id: string;
  readonly label: string;
  readonly loader: QueryWindowLoader;
  readonly exportName: string;
}

const QUERY_WINDOW_SPECS = [
  { id: 'assemblyarea-query-window', label: 'Toplanma alanları', loader: () => import('../Query/AAQuery/AAQueryWindow'), exportName: 'AssemblyAreaQueryWindow' },
  { id: 'baskentmarket-query-window', label: 'Başkent Market', loader: () => import('../Query/BaskentMarketQuery/BaskentMarketQueryWindow'), exportName: 'BaskentMarketQueryWindow' },
  { id: 'cityblockparcel-query-window', label: 'Ada parsel sorgusu', loader: () => import('../Query/CityBlockParcelQuery/CityBlockParcelQueryWindow'), exportName: 'CityBlockParcelQueryWindow' },
  { id: 'culture-query-window', label: 'Kültür ve sanat', loader: () => import('../Query/CultureQuery/CultureQueryWindow'), exportName: 'CultureQueryWindow' },
  { id: 'ego-query-window', label: 'EGO sorgusu', loader: () => import('../Query/EgoQuery/EgoQueryWindow'), exportName: 'EgoQueryWindow' },
  { id: 'event-query-window', label: 'Etkinlikler', loader: () => import('../Query/EventQuery/EventQueryWindow'), exportName: 'EventQueryWindow' },
  { id: 'halkekmek-query-window', label: 'Halk Ekmek', loader: () => import('../Query/HalkEkmekQuery/HalkEkmekQueryWindow'), exportName: 'HalkEkmekQueryWindow' },
  { id: 'patidostu-query-window', label: 'Pati Dostu', loader: () => import('../Query/PatiDostuQuery/PatiDostuQueryWindow'), exportName: 'PatiDostuQueryWindow' },
  { id: 'teknolojimerkezi-query-window', label: 'Teknoloji merkezleri', loader: () => import('../Query/TeknolojiMerkezleriQuery/TeknolojiMerkezleriQueryWindow'), exportName: 'TeknolojiMerkezleriQueryWindow' },
  { id: 'aileyasammerkezleri-query-window', label: 'Aile yaşam merkezleri', loader: () => import('../Query/AileYasamMerkezleriQery/AileYasamMerkezleriQeryWindow'), exportName: 'AileYasamMerkezleriQeryWindow' },
  { id: 'anfabitkievi-query-window', label: 'ANFA Bitki Evi', loader: () => import('../Query/AnfaBitkiEviQery/AnfaBitkiEviQeryWindow'), exportName: 'AnfaBitkiEviQeryWindow' },
  { id: 'anfakafeler-query-window', label: 'ANFA kafeler', loader: () => import('../Query/AnfaKafelerQery/AnfaKafelerQeryWindow'), exportName: 'AnfaKafelerQeryWindow' },
  { id: 'anfaotopark-query-window', label: 'ANFA otoparklar', loader: () => import('../Query/AnfaOtoparkQuery/AnfaOtoparkQueryWindow'), exportName: 'AnfaOtoparkQueryWindow' },
  { id: 'askiatiksutesisleri-query-window', label: 'ASKİ atık su tesisleri', loader: () => import('../Query/AskiAtıkSuTesisleriQery/AskiAtıkSuTesisleriQeryWindow'), exportName: 'AskiAtıkSuTesisleriQeryWindow' },
  { id: 'askibaraj-query-window', label: 'ASKİ barajları', loader: () => import('../Query/AskiBarajQery/AskiBarajQeryWindow'), exportName: 'AskiBarajQeryWindow' },
  { id: 'askibolgemudurlukler-query-window', label: 'ASKİ bölge müdürlükleri', loader: () => import('../Query/AskiBolgeMudurlukleriQery/AskiBolgeMudurlukleriQeryWindow'), exportName: 'AskiBolgeMudurlukleriQeryWindow' },
  { id: 'askikartdolumodeme-query-window', label: 'ASKİ kart dolum ve ödeme', loader: () => import('../Query/AskiKartDolumOdemeQuery/AskiKartDolumOdemeQueryWindow'), exportName: 'AskiKartDolumOdemeQueryWindow' },
  { id: 'askisumatik-query-window', label: 'ASKİ Sumatik', loader: () => import('../Query/AskiSumatikQery/AskiSumatikQeryWindow'), exportName: 'AskiSumatikQeryWindow' },
  { id: 'askitahsilatsube-query-window', label: 'ASKİ tahsilat şubeleri', loader: () => import('../Query/AskiTahsilatSubeQuery/AskiTahsilatSubeQueryWindow'), exportName: 'AskiTahsilatSubeQueryWindow' },
  { id: 'belkomeyvesuyusatisbufeleri-query-window', label: 'BELKO meyve suyu satış büfeleri', loader: () => import('../Query/BelkoMeyveSuyuSatisBufeleriQuery/BelkoMeyveSuyuSatisBufeleriQueryWindow'), exportName: 'BelkoMeyveSuyuSatisBufeleriQueryWindow' },
  { id: 'belmekbeltek-query-window', label: 'BELMEK ve BELTEK', loader: () => import('../Query/BelmekBeltekQery/BelmekBeltekQeryWindow'), exportName: 'BelmekBeltekQeryWindow' },
  { id: 'cocuketkinlikmerkezleri-query-window', label: 'Çocuk etkinlik merkezleri', loader: () => import('../Query/CocukEtkinlikMerkezleriQery/CocukEtkinlikMerkezleriQeryWindow'), exportName: 'CocukEtkinlikMerkezleriQeryWindow' },
  { id: 'egoankarayduraklar-query-window', label: 'ANKARAY durakları', loader: () => import('../Query/EgoAnkarayDuraklariQuery/EgoAnkarayDuraklariQueryWindow'), exportName: 'EgoAnkarayDuraklariQueryWindow' },
  { id: 'egobaskentrayduraklar-query-window', label: 'Başkentray durakları', loader: () => import('../Query/EgoBaskentrayDuraklariQuery/EgoBaskentrayDuraklariQueryWindow'), exportName: 'EgoBaskentrayDuraklariQueryWindow' },
  { id: 'egoelektriklibisikletistasyonlari-query-window', label: 'Elektrikli bisiklet istasyonları', loader: () => import('../Query/EgoElektrikliBisikletİstasyonlariQuery/EgoElektrikliBisikletIstasyonlariQueryWindow'), exportName: 'EgoElektrikliBisikletIstasyonlariQueryWindow' },
  { id: 'egokartdolumnoktalari-query-window', label: 'EGO kart dolum noktaları', loader: () => import('../Query/EgoKartDolumNoktalariQery/EgoKartDolumNoktalariQeryWindow'), exportName: 'EgoKartDolumNoktalariQeryWindow' },
  { id: 'egokartsatisnoktalari-query-window', label: 'EGO kart satış noktaları', loader: () => import('../Query/EgoKartSatisNoktalariQuery/EgoKartSatisNoktalariQueryWindow'), exportName: 'EgoKartSatisNoktalariQueryWindow' },
  { id: 'egometroduraklar-query-window', label: 'Metro durakları', loader: () => import('../Query/EgoMetroDuraklariQuery/EgoMetroDuraklariQueryWindow'), exportName: 'EgoMetroDuraklariQueryWindow' },
  { id: 'egootobusduraklar-query-window', label: 'Otobüs durakları', loader: () => import('../Query/EgoOtobusDuraklariQuery/EgoOtobusDuraklariQueryWindow'), exportName: 'EgoOtobusDuraklariQueryWindow' },
  { id: 'egooteleferikduraklari-query-window', label: 'Teleferik durakları', loader: () => import('../Query/EgoTeleferikDuraklariQuery/EgoTeleferikDuraklariQueryWindow'), exportName: 'EgoTeleferikDuraklariQueryWindow' },
  { id: 'engellibirey-query-window', label: 'Engelli birey hizmetleri', loader: () => import('../Query/EngelliBireyQery/EngelliBireyQeryWindow'), exportName: 'EngelliBireyQeryWindow' },
  { id: 'engellicocuk-query-window', label: 'Engelli çocuk hizmetleri', loader: () => import('../Query/EngelliCocukQuery/EngelliCocukQueryWindow'), exportName: 'EngelliCocukQueryWindow' },
  { id: 'gazilermerkezi-query-window', label: 'Gaziler merkezi', loader: () => import('../Query/GazilerMerkeziQurey/GazilerMerkeziQueryWindow'), exportName: 'GazilerMerkeziQueryWindow' },
  { id: 'park-query-window', label: 'Parklar', loader: () => import('../Query/ParklarQuery/ParklarQueryWindow'), exportName: 'ParklarQueryWindow' },
  { id: 'portasasfalturetim-query-window', label: 'PORTAŞ asfalt üretim', loader: () => import('../Query/PortasAsfaltUretimQuery/PortasAsfaltUretimQueryWindow'), exportName: 'PortasAsfaltUretimQueryWindow' },
  { id: 'segmensufabrikasi-query-window', label: 'Seğmen Su fabrikaları', loader: () => import('../Query/SegmenSuFabrikalarıQuery/SegmenSuFabrikalarıQueryWindow'), exportName: 'SegmenSuFabrikalarıQueryWindow' },
  { id: 'segmensusatisbayileri-query-window', label: 'Seğmen Su satış bayileri', loader: () => import('../Query/SegmenSuSatisBayileriQuery/SegmenSuSatisBayileriQueryWindow'), exportName: 'SegmenSuSatisBayileriQueryWindow' },
  { id: 'sosyalhizmetler-query-window', label: 'Sosyal hizmetler', loader: () => import('../Query/SosyalHizmetlerQuery/SosyalHizmetlerQueryWindow'), exportName: 'SosyalHizmetlerQueryWindow' },
  { id: 'sportesisleri-query-window', label: 'Spor tesisleri', loader: () => import('../Query/SporTesisleriQuery/SporTesisleriQueryWindow'), exportName: 'SporTesisleriQueryWindow' },
  { id: 'wifinoktalari-query-window', label: 'Wi-Fi noktaları', loader: () => import('../Query/WifiNoktalariQuery/WifiNoktalariQueryWindow'), exportName: 'WifiNoktalariQueryWindow' },
  { id: 'yaslidostu-query-window', label: 'Yaşlı dostu uygulamalar', loader: () => import('../Query/YasliDostuQuery/YasliDostuQueryWindow'), exportName: 'YasliDostuQueryWindow' },
  { id: 'kutuphaneler-query-window', label: 'Kütüphaneler', loader: () => import('../Query/KutuphanelerQuery/KutuphanelerQueryWindow'), exportName: 'KutuphanelerQueryWindow' },
  { id: 'kadinlarlokali-query-window', label: 'Kadınlar lokali', loader: () => import('../Query/KadinlarLokaliQuery/KadinlarLokaliQueryWindow'), exportName: 'KadinlarLokaliQueryWindow' },
  { id: 'kadindanisma-query-window', label: 'Kadın danışma merkezi', loader: () => import('../Query/KadinDanismaQuery/KadinDanismaQueryWindow'), exportName: 'KadinDanismaQueryWindow' },
  { id: 'genelarama-query-window', label: 'Genel arama', loader: () => import('../Query/GenelAramaQuery/GenelAramaQeryWindow'), exportName: 'GenelAramaQeryWindow' },
  { id: 'numbering-query-window', label: 'Numarataj sorgusu', loader: () => import('../Query/NumberingQuery/NumberingQueryWindow'), exportName: 'NumberingQueryWindow' },
  { id: 'pod-query-window', label: 'POD sorgusu', loader: () => import('../Query/PodQuery/PodQueryWindow'), exportName: 'PodQueryWindow' },
  { id: 'report-query-window', label: 'Rapor sorgusu', loader: () => import('../Query/ReportQuery/ReportQueryWindow'), exportName: 'ReportQueryWindow' },
  { id: 'route-query-window', label: 'Rota sorgusu', loader: () => import('../Query/RouteQuery/RouteQueryWindow'), exportName: 'RouteQueryWindow' },
  { id: 'taxi-query-window', label: 'Taksi sorgusu', loader: () => import('../Query/TaxiQuery/TaxiQueryWindow'), exportName: 'TaxiQueryWindow' },
  { id: 'vicinity-query-window', label: 'Yakın çevre sorgusu', loader: () => import('../Query/VicinityQuery/VicinityQueryWindow'), exportName: 'VicinityQueryWindow' },
] as const satisfies readonly QueryWindowSpec[];

export type QueryWindowId = typeof QUERY_WINDOW_SPECS[number]['id'];

export interface QueryWindowDefinition {
  readonly id: QueryWindowId;
  readonly label: string;
  readonly component: LazyExoticComponent<QueryWindowComponent>;
  readonly preload: () => Promise<QueryWindowComponent>;
}

const modulePromises = new Map<QueryWindowId, Promise<QueryWindowComponent>>();

const loadNamed = async (spec: typeof QUERY_WINDOW_SPECS[number]): Promise<QueryWindowComponent> => {
  const existing = modulePromises.get(spec.id);
  if (existing) return existing;
  const pending = spec.loader().then(module => {
    const candidate = module[spec.exportName];
    if ((typeof candidate !== 'function' && typeof candidate !== 'object') || candidate === null) {
      throw new Error(`Lazy window export not found: ${spec.exportName}`);
    }
    return candidate as QueryWindowComponent;
  }).catch((error: unknown) => {
    modulePromises.delete(spec.id);
    throw error;
  });
  modulePromises.set(spec.id, pending);
  return pending;
};

const createDefinition = (spec: typeof QUERY_WINDOW_SPECS[number]): QueryWindowDefinition => ({
  id: spec.id,
  label: spec.label,
  component: lazy(async () => ({ default: await loadNamed(spec) })),
  preload: () => loadNamed(spec),
});

export const QUERY_WINDOW_DEFINITIONS: readonly QueryWindowDefinition[] = Object.freeze(QUERY_WINDOW_SPECS.map(createDefinition));
export const QUERY_WINDOW_IDS: readonly QueryWindowId[] = Object.freeze(QUERY_WINDOW_SPECS.map(spec => spec.id));

const definitionById = new Map<QueryWindowId, QueryWindowDefinition>(QUERY_WINDOW_DEFINITIONS.map(definition => [definition.id, definition]));

export function isQueryWindowId(value: unknown): value is QueryWindowId {
  return typeof value === 'string' && definitionById.has(value as QueryWindowId);
}

export function getQueryWindowDefinition(id: string): QueryWindowDefinition | undefined {
  return isQueryWindowId(id) ? definitionById.get(id) : undefined;
}

export function preloadQueryWindow(id: string): Promise<QueryWindowComponent> | null {
  return getQueryWindowDefinition(id)?.preload() ?? null;
}

export function validateQueryWindowRegistry(): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const spec of QUERY_WINDOW_SPECS) {
    if (!spec.id.trim()) errors.push('Query window id cannot be empty.');
    if (!spec.label.trim()) errors.push(`Query window label cannot be empty: ${spec.id}`);
    if (ids.has(spec.id)) errors.push(`Duplicate query window id: ${spec.id}`);
    ids.add(spec.id);
  }
  return Object.freeze(errors);
}
