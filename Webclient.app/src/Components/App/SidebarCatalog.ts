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
}

export const SIDEBAR_GROUPS: readonly SidebarGroup[] = Object.freeze([
  { id: 'ABB', shortLabel: 'ABB', label: 'Ankara Büyükşehir Belediyesi', logo: '../images/abbbuton.svg' },
  { id: 'EGO', shortLabel: 'EGO', label: 'EGO Genel Müdürlüğü', logo: '../images/egobuton.svg' },
  { id: 'ASKI', shortLabel: 'ASKİ', label: 'ASKİ Genel Müdürlüğü', logo: '../images/askibuton.svg' },
  { id: 'ISTIRAK', shortLabel: 'İştirak', label: 'Belediye iştirakleri', logo: '../images/istiraklerbuton.svg' }
]);

export const SIDEBAR_ITEMS: readonly SidebarItem[] = Object.freeze([
  { group: 'ABB', label: 'Kadın Danışma Merkezleri', windowId: 'kadindanisma-query-window', iconType: 'kadın danışma merkezi' },
  { group: 'ABB', label: 'Kadınlar Lokali', windowId: 'kadinlarlokali-query-window', iconType: 'kadınlar lokali' },
  { group: 'ABB', label: 'Pati Dostu Uygulamalar', windowId: 'patidostu-query-window', iconType: 'pati dostu' },
  { group: 'ABB', label: 'Teknoloji Merkezleri', windowId: 'teknolojimerkezi-query-window', iconType: 'teknoloji merkezi' },
  { group: 'ABB', label: 'Sosyal Hizmetler', windowId: 'sosyalhizmetler-query-window', iconType: 'sosyal hizmetler' },
  { group: 'ABB', label: 'Yaşlı Dostu Uygulamalar', windowId: 'yaslidostu-query-window', iconType: 'yaşlı dostu uygulama' },
  { group: 'ABB', label: 'Engelli Çocuklar', windowId: 'engellicocuk-query-window', iconType: 'engelsiz kreş' },
  { group: 'ABB', label: 'Engelli Bireyler', windowId: 'engellibirey-query-window', iconType: 'engelsiz yaşam' },
  { group: 'ABB', label: 'Kültür ve Sanat', windowId: 'culture-query-window', iconType: 'kültür sanat' },
  { group: 'ABB', label: 'Çocuk Etkinlik Merkezleri', windowId: 'cocuketkinlikmerkezleri-query-window', iconType: 'çocuk etkinlik merkezi' },
  { group: 'ABB', label: 'Spor Tesisleri', windowId: 'sportesisleri-query-window', iconType: 'espor tesisi' },
  { group: 'ABB', label: 'Parklar', windowId: 'park-query-window', iconType: 'park' },
  { group: 'ABB', label: 'Aile Yaşam Merkezleri', windowId: 'aileyasammerkezleri-query-window', iconType: 'aile yaşam merkezi' },
  { group: 'ABB', label: 'Wi-Fi Noktaları', windowId: 'wifinoktalari-query-window', iconType: 'wifi erişim noktası' },
  { group: 'ABB', label: 'Gazi Merkezleri', windowId: 'gazilermerkezi-query-window', iconType: 'gazi merkezi' },
  { group: 'ABB', label: 'Kütüphaneler', windowId: 'kutuphaneler-query-window', iconType: 'kütüphane' },
  { group: 'ABB', label: 'BELMEK / BELTEK', windowId: 'belmekbeltek-query-window', iconType: 'belmek' },

  { group: 'EGO', label: 'Kart Satış Noktaları', windowId: 'egokartsatisnoktalari-query-window', iconType: 'kart satış noktası' },
  { group: 'EGO', label: 'Kart Dolum Noktaları', windowId: 'egokartdolumnoktalari-query-window', iconType: 'kart dolum noktası' },
  { group: 'EGO', label: 'Elektrikli Bisiklet İstasyonları', windowId: 'egoelektriklibisikletistasyonlari-query-window', iconType: 'elektrikli bisiklet istasyonu' },
  { group: 'EGO', label: 'Otobüs Durakları', windowId: 'egootobusduraklar-query-window', iconType: 'otobüs durağı' },
  { group: 'EGO', label: 'ANKARAY', windowId: 'egoankarayduraklar-query-window', iconType: 'ankaray durağı' },
  { group: 'EGO', label: 'Teleferik', windowId: 'egooteleferikduraklari-query-window', iconType: 'teleferik durağı' },
  { group: 'EGO', label: 'Başkentray', windowId: 'egobaskentrayduraklar-query-window', iconType: 'başkentray durağı' },
  { group: 'EGO', label: 'Metro Hattı', windowId: 'egometroduraklar-query-window', iconType: 'metro hattı' },

  { group: 'ASKI', label: 'Bölge Müdürlükleri', windowId: 'askibolgemudurlukler-query-window', iconType: 'bölge müdürlüğü' },
  { group: 'ASKI', label: 'Atık Su Tesisleri', windowId: 'askiatiksutesisleri-query-window', iconType: 'atıksu tesisi' },
  { group: 'ASKI', label: 'Barajlar', windowId: 'askibaraj-query-window', iconType: 'baraj' },
  { group: 'ASKI', label: 'Tahsilat Şubeleri', windowId: 'askitahsilatsube-query-window', iconType: 'tahsilat şubesi' },
  { group: 'ASKI', label: 'Sumatik', windowId: 'askisumatik-query-window', iconType: 'sumatik' },
  { group: 'ASKI', label: 'Kart Dolum ve Ödeme Noktaları', windowId: 'askikartdolumodeme-query-window', iconType: 'kart dolum' },

  { group: 'ISTIRAK', label: 'ANFA Otopark', windowId: 'anfaotopark-query-window', iconType: 'anfa otopark' },
  { group: 'ISTIRAK', label: 'ANFA Kafeler', windowId: 'anfakafeler-query-window', iconType: 'anfa kafe' },
  { group: 'ISTIRAK', label: 'ANFA Bitki Evi', windowId: 'anfabitkievi-query-window', iconType: 'anfa bitki evi' },
  { group: 'ISTIRAK', label: 'BELKO Meyve Suyu Satış', windowId: 'belkomeyvesuyusatisbufeleri-query-window', iconType: 'belko meyve suyu' },
  { group: 'ISTIRAK', label: 'PORTAŞ Asfalt Üretim', windowId: 'portasasfalturetim-query-window', iconType: 'portas asfalt' },
  { group: 'ISTIRAK', label: 'Seğmen Su Satış Noktaları', windowId: 'segmensusatisbayileri-query-window', iconType: 'segmen su' },
  { group: 'ISTIRAK', label: 'Seğmen Su Fabrikaları', windowId: 'segmensufabrikasi-query-window', iconType: 'segmen su' },
  { group: 'ISTIRAK', label: 'Başkent Market', windowId: 'baskentmarket-query-window', iconType: 'başkent market' },
  { group: 'ISTIRAK', label: 'Halk Ekmek Satış Noktaları', windowId: 'halkekmek-query-window', iconType: 'halk ekmek' }
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

export const getSidebarItemsForGroup = (groupId: SidebarGroupId): readonly SidebarItem[] => SIDEBAR_ITEMS.filter((item) => item.group === groupId);
