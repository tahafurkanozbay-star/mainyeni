import { createSidebarCatalogRuntime } from '../../shell/sidebarCatalogRuntime';
export type SidebarGroupId = 'ABB' | 'EGO' | 'ASKI' | 'ISTIRAK';

export interface SidebarGroup {
  readonly id: SidebarGroupId;
  readonly shortLabel: string;
  readonly label: string;
  readonly logo: string;
}
export interface SidebarItem {
  readonly group: SidebarGroupId;
  readonly label: string;
  readonly windowId: string;
  readonly iconType: string;
  readonly serviceKey: string;
}

export const SIDEBAR_GROUPS: readonly SidebarGroup[] = Object.freeze([
  { id: 'ABB', shortLabel: 'ABB', label: 'Ankara Büyükşehir Belediyesi', logo: '../images/abbbuton.svg' },
  { id: 'EGO', shortLabel: 'EGO', label: 'EGO Genel Müdürlüğü', logo: '../images/egobuton.svg' },
  { id: 'ASKI', shortLabel: 'ASKİ', label: 'ASKİ Genel Müdürlüğü', logo: '../images/askibuton.svg' },
  { id: 'ISTIRAK', shortLabel: 'İştirak', label: 'Belediye iştirakleri', logo: '../images/istiraklerbuton.svg' }
]);

export const SIDEBAR_ITEMS: readonly SidebarItem[] = Object.freeze([
  { group: 'ABB', label: 'Kadın Danışma Merkezleri', windowId: 'kadindanisma-query-window', iconType: 'kadın danışma merkezi', serviceKey: 'YeniKadinDanismaQueryUrl' },
  { group: 'ABB', label: 'Kadınlar Lokali', windowId: 'kadinlarlokali-query-window', iconType: 'kadınlar lokali', serviceKey: 'YeniKadinlarLokaliQeryUrl' },
  { group: 'ABB', label: 'Pati Dostu Uygulamalar', windowId: 'patidostu-query-window', iconType: 'pati dostu', serviceKey: 'YeniPatiDostuQeryUrl' },
  { group: 'ABB', label: 'Teknoloji Merkezleri', windowId: 'teknolojimerkezi-query-window', iconType: 'teknoloji merkezi', serviceKey: 'YeniTeknolojiMerkezleriQueryUrl' },
  { group: 'ABB', label: 'Sosyal Hizmetler', windowId: 'sosyalhizmetler-query-window', iconType: 'sosyal hizmetler', serviceKey: 'YeniSosyalHizmetlerQueryUrl' },
  { group: 'ABB', label: 'Yaşlı Dostu Uygulamalar', windowId: 'yaslidostu-query-window', iconType: 'yaşlı dostu uygulama', serviceKey: 'YeniYasliDostuQueryUrl' },
  { group: 'ABB', label: 'Engelli Çocuklar', windowId: 'engellicocuk-query-window', iconType: 'engelsiz kreş', serviceKey: 'YeniEngelliCocukQueryUrl' },
  { group: 'ABB', label: 'Engelli Bireyler', windowId: 'engellibirey-query-window', iconType: 'engelsiz yaşam', serviceKey: 'YeniEngelliBireyQeryUrl' },
  { group: 'ABB', label: 'Kültür ve Sanat', windowId: 'culture-query-window', iconType: 'kültür sanat', serviceKey: 'YeniKültürSanatQueryUrl' },
  { group: 'ABB', label: 'Çocuk Etkinlik Merkezleri', windowId: 'cocuketkinlikmerkezleri-query-window', iconType: 'çocuk etkinlik merkezi', serviceKey: 'YeniCocukEtkinlikMerkezleriQeryUrl' },
  { group: 'ABB', label: 'Spor Tesisleri', windowId: 'sportesisleri-query-window', iconType: 'espor tesisi', serviceKey: 'YeniSporTesisleriQeryUrl' },
  { group: 'ABB', label: 'Parklar', windowId: 'park-query-window', iconType: 'park', serviceKey: 'YeniParklarQeryUrl' },
  { group: 'ABB', label: 'Aile Yaşam Merkezleri', windowId: 'aileyasammerkezleri-query-window', iconType: 'aile yaşam merkezi', serviceKey: 'YeniAileYasamMerkezleriQeryUrl' },
  { group: 'ABB', label: 'Wi-Fi Noktaları', windowId: 'wifinoktalari-query-window', iconType: 'wifi erişim noktası', serviceKey: 'YeniWifiNoktalariQeryUrl' },
  { group: 'ABB', label: 'Gazi Merkezleri', windowId: 'gazilermerkezi-query-window', iconType: 'gazi merkezi', serviceKey: 'YeniGazilerMerkeziQeyUrl' },
  { group: 'ABB', label: 'Kütüphaneler', windowId: 'kutuphaneler-query-window', iconType: 'kütüphane', serviceKey: 'YeniKutuphanelerQueryUrl' },
  { group: 'ABB', label: 'BELMEK / BELTEK', windowId: 'belmekbeltek-query-window', iconType: 'belmek', serviceKey: 'YeniBelmekBeltekQeryUrl' },

  { group: 'EGO', label: 'Kart Satış Noktaları', windowId: 'egokartsatisnoktalari-query-window', iconType: 'kart satış noktası', serviceKey: 'YeniEgoKartSatisNoktalariQueryUrl' },
  { group: 'EGO', label: 'Kart Dolum Noktaları', windowId: 'egokartdolumnoktalari-query-window', iconType: 'kart dolum noktası', serviceKey: 'YeniEgoKartDolumNoktalariQeryUrl' },
  { group: 'EGO', label: 'Elektrikli Bisiklet İstasyonları', windowId: 'egoelektriklibisikletistasyonlari-query-window', iconType: 'elektrikli bisiklet istasyonu', serviceKey: 'YeniEgoElektrikliBisikletİstasyonlariQueryUrl' },
  { group: 'EGO', label: 'Otobüs Durakları', windowId: 'egootobusduraklar-query-window', iconType: 'otobüs durağı', serviceKey: 'YeniEgoOtobusDuraklariQueryUrl' },
  { group: 'EGO', label: 'ANKARAY', windowId: 'egoankarayduraklar-query-window', iconType: 'ankaray durağı', serviceKey: 'YeniEgoAnkarayDuraklariQueryUrl' },
  { group: 'EGO', label: 'Teleferik', windowId: 'egooteleferikduraklari-query-window', iconType: 'teleferik durağı', serviceKey: 'YeniEgoTeleferikDuraklariQueryUrl' },
  { group: 'EGO', label: 'Başkentray', windowId: 'egobaskentrayduraklar-query-window', iconType: 'başkentray durağı', serviceKey: 'YeniEgoBaskentrayDuraklariQueryUrl' },
  { group: 'EGO', label: 'Metro Hattı', windowId: 'egometroduraklar-query-window', iconType: 'metro hattı', serviceKey: 'YeniEgoMetroDuraklariQueryUrl' },

  { group: 'ASKI', label: 'Bölge Müdürlükleri', windowId: 'askibolgemudurlukler-query-window', iconType: 'bölge müdürlüğü', serviceKey: 'YeniAskiBolgeMudurlukleriQeryUrl' },
  { group: 'ASKI', label: 'Atık Su Tesisleri', windowId: 'askiatiksutesisleri-query-window', iconType: 'atıksu tesisi', serviceKey: 'YeniAskiAtıkSuTesisleriQeryUrl' },
  { group: 'ASKI', label: 'Barajlar', windowId: 'askibaraj-query-window', iconType: 'baraj', serviceKey: 'YeniAskiBarajQeryUrl' },
  { group: 'ASKI', label: 'Tahsilat Şubeleri', windowId: 'askitahsilatsube-query-window', iconType: 'tahsilat şubesi', serviceKey: 'YeniAskiTahsilatSubeQueryUrl' },
  { group: 'ASKI', label: 'Sumatik', windowId: 'askisumatik-query-window', iconType: 'sumatik', serviceKey: 'YeniAskiSumatikQueryUrl' },
  { group: 'ASKI', label: 'Kart Dolum ve Ödeme Noktaları', windowId: 'askikartdolumodeme-query-window', iconType: 'kart dolum', serviceKey: 'YeniAskiKartDolumOdemeQueryUrl' },

  { group: 'ISTIRAK', label: 'ANFA Otopark', windowId: 'anfaotopark-query-window', iconType: 'anfa otopark', serviceKey: 'YeniAnfaOtoparkQeryUrl' },
  { group: 'ISTIRAK', label: 'ANFA Kafeler', windowId: 'anfakafeler-query-window', iconType: 'anfa kafe', serviceKey: 'YeniAnfaKafelerQeryUrl' },
  { group: 'ISTIRAK', label: 'ANFA Bitki Evi', windowId: 'anfabitkievi-query-window', iconType: 'anfa bitki evi', serviceKey: 'YeniAnfaBitkiEviQeryUrl' },
  { group: 'ISTIRAK', label: 'BELKO Meyve Suyu Satış', windowId: 'belkomeyvesuyusatisbufeleri-query-window', iconType: 'belko meyve suyu', serviceKey: 'YeniBelkoMeyveSuyuSatisBufeleriQueryUrl' },
  { group: 'ISTIRAK', label: 'PORTAŞ Asfalt Üretim', windowId: 'portasasfalturetim-query-window', iconType: 'portas asfalt', serviceKey: 'YeniPortasAsfaltUretimQeryUrl' },
  { group: 'ISTIRAK', label: 'Seğmen Su Satış Noktaları', windowId: 'segmensusatisbayileri-query-window', iconType: 'segmen su', serviceKey: 'YeniSegmenSuSatisBayileriQeryUrl' },
  { group: 'ISTIRAK', label: 'Seğmen Su Fabrikaları', windowId: 'segmensufabrikasi-query-window', iconType: 'segmen su', serviceKey: 'YeniSegmenSuFabrikalarıQeryUrl' },
  { group: 'ISTIRAK', label: 'Başkent Market', windowId: 'baskentmarket-query-window', iconType: 'başkent market', serviceKey: 'YeniBaskentMarketQeryUrl' },
  { group: 'ISTIRAK', label: 'Halk Ekmek Satış Noktaları', windowId: 'halkekmek-query-window', iconType: 'halk ekmek', serviceKey: 'YeniHalkEkmekSatisNoktalariQeryUrl' }
]);

export const INITIAL_CITY_LAYER_SERVICE_KEYS: readonly string[] = Object.freeze([
  'YeniYasliDostuQueryUrl',
  'YeniSosyalHizmetlerQueryUrl',
  'YeniTeknolojiMerkezleriQueryUrl',
  'YeniPatiDostuQeryUrl',
  'YeniBelmekBeltekQeryUrl',
  'YeniKadinDanismaQueryUrl',
  'YeniKadinlarLokaliQeryUrl',
  'YeniAileYasamMerkezleriQeryUrl',
  'YeniCocukEtkinlikMerkezleriQeryUrl',
  'YeniEngelliCocukQueryUrl',
  'YeniEngelliBireyQeryUrl',
  'YeniSporTesisleriQeryUrl',
  'YeniGazilerMerkeziQeyUrl',
  'YeniKültürSanatQueryUrl',
  'YeniKutuphanelerQueryUrl',
  'YeniParklarQeryUrl',
  'YeniWifiNoktalariQeryUrl'
]);

export const SIDEBAR_CATALOG_RUNTIME = createSidebarCatalogRuntime({
  groups: SIDEBAR_GROUPS,
  items: SIDEBAR_ITEMS,
});

export const getSidebarItemsForGroup = (groupId: SidebarGroupId): readonly SidebarItem[] =>
  SIDEBAR_CATALOG_RUNTIME.itemsForGroup(groupId) as readonly SidebarItem[];
