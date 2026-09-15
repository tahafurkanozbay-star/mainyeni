import React from 'react';

const lazyNamed = (loader, exportName) => React.lazy(() => loader().then(module => {
  const Component = module[exportName];
  if (!Component) throw new Error(`Lazy window export not found: ${exportName}`);
  return { default: Component };
}));

const defineWindow = (id, label, loader, exportName) => ({
  id,
  label,
  component: lazyNamed(loader, exportName)
});

export const QUERY_WINDOW_DEFINITIONS = Object.freeze([
  defineWindow('assemblyarea-query-window', 'Toplanma alanları', () => import('../Query/AAQuery/AAQueryWindow'), 'AssemblyAreaQueryWindow'),
  defineWindow('baskentmarket-query-window', 'Başkent Market', () => import('../Query/BaskentMarketQuery/BaskentMarketQueryWindow'), 'BaskentMarketQueryWindow'),
  defineWindow('cityblockparcel-query-window', 'Ada parsel sorgusu', () => import('../Query/CityBlockParcelQuery/CityBlockParcelQueryWindow'), 'CityBlockParcelQueryWindow'),
  defineWindow('culture-query-window', 'Kültür ve sanat', () => import('../Query/CultureQuery/CultureQueryWindow'), 'CultureQueryWindow'),
  defineWindow('ego-query-window', 'EGO sorgusu', () => import('../Query/EgoQuery/EgoQueryWindow'), 'EgoQueryWindow'),
  defineWindow('event-query-window', 'Etkinlikler', () => import('../Query/EventQuery/EventQueryWindow'), 'EventQueryWindow'),
  defineWindow('halkekmek-query-window', 'Halk Ekmek', () => import('../Query/HalkEkmekQuery/HalkEkmekQueryWindow'), 'HalkEkmekQueryWindow'),
  defineWindow('patidostu-query-window', 'Pati Dostu', () => import('../Query/PatiDostuQuery/PatiDostuQueryWindow'), 'PatiDostuQueryWindow'),
  defineWindow('teknolojimerkezi-query-window', 'Teknoloji merkezleri', () => import('../Query/TeknolojiMerkezleriQuery/TeknolojiMerkezleriQueryWindow'), 'TeknolojiMerkezleriQueryWindow'),
  defineWindow('aileyasammerkezleri-query-window', 'Aile yaşam merkezleri', () => import('../Query/AileYasamMerkezleriQery/AileYasamMerkezleriQeryWindow'), 'AileYasamMerkezleriQeryWindow'),
  defineWindow('anfabitkievi-query-window', 'ANFA Bitki Evi', () => import('../Query/AnfaBitkiEviQery/AnfaBitkiEviQeryWindow'), 'AnfaBitkiEviQeryWindow'),
  defineWindow('anfakafeler-query-window', 'ANFA kafeler', () => import('../Query/AnfaKafelerQery/AnfaKafelerQeryWindow'), 'AnfaKafelerQeryWindow'),
  defineWindow('anfaotopark-query-window', 'ANFA otoparklar', () => import('../Query/AnfaOtoparkQuery/AnfaOtoparkQueryWindow'), 'AnfaOtoparkQueryWindow'),
  defineWindow('askiatiksutesisleri-query-window', 'ASKİ atık su tesisleri', () => import('../Query/AskiAtıkSuTesisleriQery/AskiAtıkSuTesisleriQeryWindow'), 'AskiAtıkSuTesisleriQeryWindow'),
  defineWindow('askibaraj-query-window', 'ASKİ barajları', () => import('../Query/AskiBarajQery/AskiBarajQeryWindow'), 'AskiBarajQeryWindow'),
  defineWindow('askibolgemudurlukler-query-window', 'ASKİ bölge müdürlükleri', () => import('../Query/AskiBolgeMudurlukleriQery/AskiBolgeMudurlukleriQeryWindow'), 'AskiBolgeMudurlukleriQeryWindow'),
  defineWindow('askikartdolumodeme-query-window', 'ASKİ kart dolum ve ödeme', () => import('../Query/AskiKartDolumOdemeQuery/AskiKartDolumOdemeQueryWindow'), 'AskiKartDolumOdemeQueryWindow'),
  defineWindow('askisumatik-query-window', 'ASKİ Sumatik', () => import('../Query/AskiSumatikQery/AskiSumatikQeryWindow'), 'AskiSumatikQeryWindow'),
  defineWindow('askitahsilatsube-query-window', 'ASKİ tahsilat şubeleri', () => import('../Query/AskiTahsilatSubeQuery/AskiTahsilatSubeQueryWindow'), 'AskiTahsilatSubeQueryWindow'),
  defineWindow('belkomeyvesuyusatisbufeleri-query-window', 'BELKO meyve suyu satış büfeleri', () => import('../Query/BelkoMeyveSuyuSatisBufeleriQuery/BelkoMeyveSuyuSatisBufeleriQueryWindow'), 'BelkoMeyveSuyuSatisBufeleriQueryWindow'),
  defineWindow('belmekbeltek-query-window', 'BELMEK ve BELTEK', () => import('../Query/BelmekBeltekQery/BelmekBeltekQeryWindow'), 'BelmekBeltekQeryWindow'),
  defineWindow('cocuketkinlikmerkezleri-query-window', 'Çocuk etkinlik merkezleri', () => import('../Query/CocukEtkinlikMerkezleriQery/CocukEtkinlikMerkezleriQeryWindow'), 'CocukEtkinlikMerkezleriQeryWindow'),
  defineWindow('egoankarayduraklar-query-window', 'ANKARAY durakları', () => import('../Query/EgoAnkarayDuraklariQuery/EgoAnkarayDuraklariQueryWindow'), 'EgoAnkarayDuraklariQueryWindow'),
  defineWindow('egobaskentrayduraklar-query-window', 'Başkentray durakları', () => import('../Query/EgoBaskentrayDuraklariQuery/EgoBaskentrayDuraklariQueryWindow'), 'EgoBaskentrayDuraklariQueryWindow'),
  defineWindow('egoelektriklibisikletistasyonlari-query-window', 'Elektrikli bisiklet istasyonları', () => import('../Query/EgoElektrikliBisikletİstasyonlariQuery/EgoElektrikliBisikletIstasyonlariQueryWindow'), 'EgoElektrikliBisikletIstasyonlariQueryWindow'),
  defineWindow('egokartdolumnoktalari-query-window', 'EGO kart dolum noktaları', () => import('../Query/EgoKartDolumNoktalariQery/EgoKartDolumNoktalariQeryWindow'), 'EgoKartDolumNoktalariQeryWindow'),
  defineWindow('egokartsatisnoktalari-query-window', 'EGO kart satış noktaları', () => import('../Query/EgoKartSatisNoktalariQuery/EgoKartSatisNoktalariQueryWindow'), 'EgoKartSatisNoktalariQueryWindow'),
  defineWindow('egometroduraklar-query-window', 'Metro durakları', () => import('../Query/EgoMetroDuraklariQuery/EgoMetroDuraklariQueryWindow'), 'EgoMetroDuraklariQueryWindow'),
  defineWindow('egootobusduraklar-query-window', 'Otobüs durakları', () => import('../Query/EgoOtobusDuraklariQuery/EgoOtobusDuraklariQueryWindow'), 'EgoOtobusDuraklariQueryWindow'),
  defineWindow('egooteleferikduraklari-query-window', 'Teleferik durakları', () => import('../Query/EgoTeleferikDuraklariQuery/EgoTeleferikDuraklariQueryWindow'), 'EgoTeleferikDuraklariQueryWindow'),
  defineWindow('engellibirey-query-window', 'Engelli birey hizmetleri', () => import('../Query/EngelliBireyQery/EngelliBireyQeryWindow'), 'EngelliBireyQeryWindow'),
  defineWindow('engellicocuk-query-window', 'Engelli çocuk hizmetleri', () => import('../Query/EngelliCocukQuery/EngelliCocukQueryWindow'), 'EngelliCocukQueryWindow'),
  defineWindow('gazilermerkezi-query-window', 'Gaziler merkezi', () => import('../Query/GazilerMerkeziQurey/GazilerMerkeziQueryWindow'), 'GazilerMerkeziQueryWindow'),
  defineWindow('park-query-window', 'Parklar', () => import('../Query/ParklarQuery/ParklarQueryWindow'), 'ParklarQueryWindow'),
  defineWindow('portasasfalturetim-query-window', 'PORTAŞ asfalt üretim', () => import('../Query/PortasAsfaltUretimQuery/PortasAsfaltUretimQueryWindow'), 'PortasAsfaltUretimQueryWindow'),
  defineWindow('segmensufabrikasi-query-window', 'Seğmen Su fabrikaları', () => import('../Query/SegmenSuFabrikalarıQuery/SegmenSuFabrikalarıQueryWindow'), 'SegmenSuFabrikalarıQueryWindow'),
  defineWindow('segmensusatisbayileri-query-window', 'Seğmen Su satış bayileri', () => import('../Query/SegmenSuSatisBayileriQuery/SegmenSuSatisBayileriQueryWindow'), 'SegmenSuSatisBayileriQueryWindow'),
  defineWindow('sosyalhizmetler-query-window', 'Sosyal hizmetler', () => import('../Query/SosyalHizmetlerQuery/SosyalHizmetlerQueryWindow'), 'SosyalHizmetlerQueryWindow'),
  defineWindow('sportesisleri-query-window', 'Spor tesisleri', () => import('../Query/SporTesisleriQuery/SporTesisleriQueryWindow'), 'SporTesisleriQueryWindow'),
  defineWindow('wifinoktalari-query-window', 'Wi-Fi noktaları', () => import('../Query/WifiNoktalariQuery/WifiNoktalariQueryWindow'), 'WifiNoktalariQueryWindow'),
  defineWindow('yaslidostu-query-window', 'Yaşlı dostu uygulamalar', () => import('../Query/YasliDostuQuery/YasliDostuQueryWindow'), 'YasliDostuQueryWindow'),
  defineWindow('kutuphaneler-query-window', 'Kütüphaneler', () => import('../Query/KutuphanelerQuery/KutuphanelerQueryWindow'), 'KutuphanelerQueryWindow'),
  defineWindow('kadinlarlokali-query-window', 'Kadınlar lokali', () => import('../Query/KadinlarLokaliQuery/KadinlarLokaliQueryWindow'), 'KadinlarLokaliQueryWindow'),
  defineWindow('kadindanisma-query-window', 'Kadın danışma merkezi', () => import('../Query/KadinDanismaQuery/KadinDanismaQueryWindow'), 'KadinDanismaQueryWindow'),
  defineWindow('genelarama-query-window', 'Genel arama', () => import('../Query/GenelAramaQuery/GenelAramaQeryWindow'), 'GenelAramaQeryWindow'),
  defineWindow('numbering-query-window', 'Numarataj sorgusu', () => import('../Query/NumberingQuery/NumberingQueryWindow'), 'NumberingQueryWindow'),
  defineWindow('pod-query-window', 'POD sorgusu', () => import('../Query/PodQuery/PodQueryWindow'), 'PodQueryWindow'),
  defineWindow('report-query-window', 'Rapor sorgusu', () => import('../Query/ReportQuery/ReportQueryWindow'), 'ReportQueryWindow'),
  defineWindow('route-query-window', 'Rota sorgusu', () => import('../Query/RouteQuery/RouteQueryWindow'), 'RouteQueryWindow'),
  defineWindow('taxi-query-window', 'Taksi sorgusu', () => import('../Query/TaxiQuery/TaxiQueryWindow'), 'TaxiQueryWindow'),
  defineWindow('vicinity-query-window', 'Yakın çevre sorgusu', () => import('../Query/VicinityQuery/VicinityQueryWindow'), 'VicinityQueryWindow')
]);

export const QUERY_WINDOW_IDS = Object.freeze(QUERY_WINDOW_DEFINITIONS.map(item => item.id));
