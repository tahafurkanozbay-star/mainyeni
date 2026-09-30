import { normalizeMapShortcutHelpText } from './mapShortcutHelpModel';

export type MapWorkspaceGuideCategory =
  | 'all'
  | 'navigation'
  | 'tools'
  | 'data'
  | 'accessibility'
  | 'recovery';

export type MapWorkspaceGuideMove =
  | 'next'
  | 'previous'
  | 'first'
  | 'last'
  | 'page-next'
  | 'page-previous';

export interface MapWorkspaceGuideDefinition {
  readonly id: string;
  readonly category: Exclude<MapWorkspaceGuideCategory, 'all'>;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly keywords: readonly string[];
  readonly shortcutHint?: string;
}

export interface MapWorkspaceGuideEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly category: Exclude<MapWorkspaceGuideCategory, 'all'>;
  readonly categoryLabel: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly string[];
  readonly shortcutHint: string | null;
  readonly position: number;
  readonly setSize: number;
  readonly selected: boolean;
}

export interface MapWorkspaceGuideSnapshot {
  readonly revision: number;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly category: MapWorkspaceGuideCategory;
  readonly activeId: string | null;
  readonly resultCount: number;
  readonly totalCount: number;
  readonly entries: readonly MapWorkspaceGuideEntry[];
  readonly activeEntry: MapWorkspaceGuideEntry | null;
  readonly announcement: string;
  readonly empty: boolean;
}

export interface MapWorkspaceGuideCategoryOption {
  readonly id: MapWorkspaceGuideCategory;
  readonly label: string;
}

export interface MapWorkspaceGuideAuditFinding {
  readonly code:
    | 'duplicate-id'
    | 'empty-title'
    | 'empty-summary'
    | 'empty-steps'
    | 'too-many-steps'
    | 'empty-step'
    | 'catalog-too-large';
  readonly entryId?: string;
  readonly detail: string;
}

export interface MapWorkspaceGuideModelOptions {
  readonly maxQueryLength?: number;
  readonly maxListeners?: number;
  readonly pageSize?: number;
}

const DEFAULT_MAX_QUERY_LENGTH = 96;
const MAX_QUERY_LENGTH = 180;
const DEFAULT_MAX_LISTENERS = 24;
const MAX_LISTENERS = 100;
const DEFAULT_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 20;
const MAX_GUIDE_ENTRIES = 48;
const MAX_STEPS_PER_ENTRY = 8;

export const MAP_WORKSPACE_GUIDE_CATEGORIES: readonly MapWorkspaceGuideCategoryOption[] = Object.freeze([
  Object.freeze({ id: 'all', label: 'Tüm rehber' }),
  Object.freeze({ id: 'navigation', label: 'Gezinme' }),
  Object.freeze({ id: 'tools', label: 'Araçlar' }),
  Object.freeze({ id: 'data', label: 'Veri ve sonuçlar' }),
  Object.freeze({ id: 'accessibility', label: 'Erişilebilirlik' }),
  Object.freeze({ id: 'recovery', label: 'Bağlantı ve kurtarma' }),
]);

const CATEGORY_LABELS: Readonly<Record<Exclude<MapWorkspaceGuideCategory, 'all'>, string>> = Object.freeze({
  navigation: 'Gezinme',
  tools: 'Araçlar',
  data: 'Veri ve sonuçlar',
  accessibility: 'Erişilebilirlik',
  recovery: 'Bağlantı ve kurtarma',
});

const freezeStrings = (items: readonly string[]): readonly string[] => Object.freeze([...items]);

const guide = (
  definition: MapWorkspaceGuideDefinition,
): Readonly<MapWorkspaceGuideDefinition> => Object.freeze({
  ...definition,
  steps: freezeStrings(definition.steps),
  keywords: freezeStrings(definition.keywords),
});

export const MAP_WORKSPACE_GUIDE_DEFINITIONS: readonly Readonly<MapWorkspaceGuideDefinition>[] = Object.freeze([
  guide({
    id: 'map-focus',
    category: 'navigation',
    title: 'Harita çalışma alanına hızlı geçiş',
    summary: 'Haritaya klavyeyle odaklanıp araçlar arasında gereksiz Tab dolaşımını azaltın.',
    steps: [
      'Alt+M ile ana harita çalışma alanına odaklanın.',
      'Tab ve Shift+Tab ile görünür harita kontrolleri arasında ilerleyin.',
      'Alt+N ile ana navigasyon alanına geri dönün.',
    ],
    keywords: ['harita', 'odak', 'focus', 'tab', 'navigasyon', 'klavye'],
    shortcutHint: 'Alt+M · Alt+N',
  }),
  guide({
    id: 'map-pan-zoom',
    category: 'navigation',
    title: 'Haritada gezinme ve ölçek değiştirme',
    summary: 'Harita odağındayken klavye ve standart harita kontrolleriyle görünümü değiştirin.',
    steps: [
      'Harita çalışma alanını odaklayın.',
      'Yön tuşlarını kullanarak görünümü kaydırın.',
      'Artı ve eksi tuşlarıyla yakınlaştırın veya uzaklaştırın.',
      'Başlangıç görünümü aracını kullanarak güvenli başlangıç konumuna dönün.',
    ],
    keywords: ['pan', 'zoom', 'yakınlaştır', 'uzaklaştır', 'yön tuşu', 'başlangıç'],
  }),
  guide({
    id: 'sidebar-discovery',
    category: 'navigation',
    title: 'Katman ve hizmetleri bulma',
    summary: 'Kenar çubuğunda arama, görünüm ve favori davranışlarını kullanarak harita içeriğine ulaşın.',
    steps: [
      'Alt+L ile katman ve araç kenar çubuğunu açın veya kapatın.',
      'Arama alanına hizmet, katman veya işlev adını yazın.',
      'Liste ve grup görünümleri arasında ihtiyacınıza göre geçiş yapın.',
      'Sık kullandığınız öğeleri favorilere ekleyin.',
    ],
    keywords: ['sidebar', 'kenar çubuğu', 'katman', 'favori', 'arama', 'hizmet'],
    shortcutHint: 'Alt+L',
  }),
  guide({
    id: 'command-center',
    category: 'navigation',
    title: 'Komut merkezinden hızlı işlem',
    summary: 'Pencere ve araçları menülerde aramak yerine komut merkezinden filtreleyerek açın.',
    steps: [
      'Ctrl+K ile komut merkezini açın.',
      'İşlem veya hizmet adını yazın.',
      'Yön tuşlarıyla sonucu seçip Enter ile çalıştırın.',
      'Escape ile komut merkezini güvenli biçimde kapatın.',
    ],
    keywords: ['komut', 'command', 'ctrl+k', 'arama', 'hızlı erişim'],
    shortcutHint: 'Ctrl+K',
  }),
  guide({
    id: 'basemap',
    category: 'tools',
    title: 'Altlık harita seçme',
    summary: 'Çalışma bağlamına uygun altlık haritayı kontrollü seçim yüzeyinden değiştirin.',
    steps: [
      'Alt+B ile altlık harita seçicisini açın.',
      'Klavye veya işaretçiyle uygun altlığı seçin.',
      'Konumsal işinizi sürdürmek için seçiciyi kapatın.',
    ],
    keywords: ['altlık', 'basemap', 'harita görünümü', 'zemin'],
    shortcutHint: 'Alt+B',
  }),
  guide({
    id: 'measurement',
    category: 'tools',
    title: 'Ölçüm araçlarını kullanma',
    summary: 'Mesafe ve alan ölçümlerini harita çalışma alanından erişilebilir araç penceresiyle başlatın.',
    steps: [
      'Alt+R ile ölçüm araçlarını açın.',
      'İhtiyacınıza göre mesafe veya alan ölçümünü seçin.',
      'Harita üzerinde gerekli noktaları belirleyin.',
      'İşlem tamamlandığında ölçüm durumunu temizleyin veya pencereyi kapatın.',
    ],
    keywords: ['ölçüm', 'measure', 'mesafe', 'alan', 'araç'],
    shortcutHint: 'Alt+R',
  }),
  guide({
    id: 'map-mode',
    category: 'tools',
    title: '2D ve 3D görünüm arasında geçiş',
    summary: 'Harita bağlamını kaybetmeden desteklenen 2D ve 3D görünüm modları arasında geçiş yapın.',
    steps: [
      'Harita mod kontrolünü bulun.',
      '2D veya 3D görünümü seçin.',
      'Geçiş sürerken harita durum duyurusunun tamamlanmasını bekleyin.',
      'Yeni görünümde odak ve araç durumunun korunduğunu doğrulayın.',
    ],
    keywords: ['2d', '3d', 'scene', 'map mode', 'görünüm', 'mod'],
  }),
  guide({
    id: 'feedback',
    category: 'tools',
    title: 'Geri bildirim gönderme',
    summary: 'Harita deneyimi veya belediye hizmetiyle ilgili geri bildirimi kontrollü pencereden başlatın.',
    steps: [
      'Alt+F ile geri bildirim yüzeyini açın.',
      'İlgili alanları doldurun ve hata mesajlarını kontrol edin.',
      'Göndermeden önce kişisel bilgilerinizi gözden geçirin.',
    ],
    keywords: ['geri bildirim', 'feedback', 'başkent 153', 'bildirim'],
    shortcutHint: 'Alt+F',
  }),
  guide({
    id: 'query-results',
    category: 'data',
    title: 'Sorgu sonuçlarında klavye ile gezinme',
    summary: 'Adres, parsel ve diğer sonuç listelerinde tek roving tab durağı ve yön tuşlarıyla ilerleyin.',
    steps: [
      'Sorguyu çalıştırın ve sonuç yüzeyinin yüklenmesini bekleyin.',
      'Tab ile sonuç koleksiyonuna girin.',
      'Yön tuşları, Home ve End ile sonuçlar arasında hareket edin.',
      'Enter ile seçili sonucu etkinleştirin.',
    ],
    keywords: ['sorgu', 'sonuç', 'liste', 'tablo', 'roving', 'adres', 'parsel'],
  }),
  guide({
    id: 'data-table',
    category: 'data',
    title: 'Tablo ve sayfalama davranışı',
    summary: 'Semantik veri tablolarında satır odağı, sıralama ve sayfalama davranışlarını klavyeyle kullanın.',
    steps: [
      'Tab ile tablo gövdesindeki aktif satıra girin.',
      'Yön tuşlarıyla satırlar arasında ilerleyin.',
      'PageUp ve PageDown ile sayfa değiştirirken aktif satırın görünür kaldığını kontrol edin.',
      'Sıralanabilir sütun başlıklarını buton olarak etkinleştirin.',
    ],
    keywords: ['tablo', 'data table', 'sayfa', 'pagination', 'sıralama', 'satır'],
  }),
  guide({
    id: 'data-disclaimer',
    category: 'data',
    title: 'Harita verisini yorumlama',
    summary: 'Kent Rehberi verilerini karar veya resmi belge yerine bilgilendirme bağlamında değerlendirin.',
    steps: [
      'Veri uyarısını ve kaynak bağlamını okuyun.',
      'Kritik kararlar için yetkili kurumsal kaynağı doğrulayın.',
      'Güncellik veya doğruluk şüpheniz varsa geri bildirim kanallarını kullanın.',
    ],
    keywords: ['veri', 'uyarı', 'disclaimer', 'resmi', 'güncellik', 'kaynak'],
  }),
  guide({
    id: 'focus-visible',
    category: 'accessibility',
    title: 'Klavye odağını takip etme',
    summary: 'Focus-visible halkaları hangi kontrolün klavye odağında olduğunu görünür biçimde gösterir.',
    steps: [
      'Tab ile uygulama içinde ilerleyin.',
      'Görünür odak halkasını takip edin.',
      'Odak görünmüyorsa hızlı erişim bağlantılarıyla ana bölgelere atlayın.',
    ],
    keywords: ['focus', 'odak', 'klavye', 'focus-visible', 'erişilebilirlik'],
  }),
  guide({
    id: 'skip-navigation',
    category: 'accessibility',
    title: 'Hızlı erişim bağlantıları',
    summary: 'Tekrarlayan kontrolleri atlayıp harita, katman menüsü veya araçlara doğrudan geçin.',
    steps: [
      'Sayfanın başında Tab tuşuna basın.',
      'Görünür hızlı erişim bağlantılarından hedef bölgeyi seçin.',
      'Hedef bölgeye geçtikten sonra normal klavye akışına devam edin.',
    ],
    keywords: ['skip', 'hızlı erişim', 'atla', 'klavye', 'landmark'],
  }),
  guide({
    id: 'motion-colors',
    category: 'accessibility',
    title: 'Azaltılmış hareket ve yüksek kontrast',
    summary: 'İşletim sistemi reduced-motion ve forced-colors tercihleri modern Kent Rehberi yüzeylerinde korunur.',
    steps: [
      'İşletim sisteminizde hareket azaltma veya yüksek kontrast tercihini etkinleştirin.',
      'Kent Rehberi arayüzünün animasyonları azaltıp sistem renklerini koruduğunu doğrulayın.',
      'Bilgi yalnız renkle aktarılmadığı için metin ve durum etiketlerini takip edin.',
    ],
    keywords: ['reduced motion', 'forced colors', 'yüksek kontrast', 'hareket', 'erişilebilirlik'],
  }),
  guide({
    id: 'offline-recovery',
    category: 'recovery',
    title: 'Bağlantı kesildiğinde çalışma',
    summary: 'Bağlantı durumu görünür biçimde bildirilir; uygulama kullanılabilir yerel yüzeyleri korumaya çalışır.',
    steps: [
      'Bağlantı bildiriminin çevrimdışı durumunu kontrol edin.',
      'Ağ gerektiren yeni işlemleri bağlantı geri gelene kadar erteleyin.',
      'Bağlantı geri geldiğinde durum mesajının çevrimiçi hale döndüğünü doğrulayın.',
    ],
    keywords: ['offline', 'çevrimdışı', 'bağlantı', 'network', 'recovery'],
  }),
  guide({
    id: 'startup-recovery',
    category: 'recovery',
    title: 'Başlangıç hatasından kurtarma',
    summary: 'Uygulama başlatılamadığında bounded retry yüzeyi güvenli hata bilgisini ve tekrar deneme durumunu gösterir.',
    steps: [
      'Başlangıç hata mesajını okuyun.',
      'Bağlantı durumunuzu kontrol edin.',
      'Tekrar deneme etkinse kurtarma eylemini kullanın.',
      'Deneme sınırı dolduysa sayfayı yenilemeden önce bağlantı ve tarayıcı durumunu doğrulayın.',
    ],
    keywords: ['başlangıç', 'bootstrap', 'hata', 'retry', 'kurtarma', 'recovery'],
  }),
]);

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

export const auditMapWorkspaceGuideCatalog = (
  definitions: readonly MapWorkspaceGuideDefinition[] = MAP_WORKSPACE_GUIDE_DEFINITIONS,
): readonly MapWorkspaceGuideAuditFinding[] => {
  const findings: MapWorkspaceGuideAuditFinding[] = [];
  const seen = new Set<string>();

  if (definitions.length > MAX_GUIDE_ENTRIES) {
    findings.push(Object.freeze({ code: 'catalog-too-large', detail: `Guide catalog exceeds ${MAX_GUIDE_ENTRIES} entries.` }));
  }

  for (const definition of definitions.slice(0, MAX_GUIDE_ENTRIES + 1)) {
    if (seen.has(definition.id)) {
      findings.push(Object.freeze({ code: 'duplicate-id', entryId: definition.id, detail: `Duplicate guide id: ${definition.id}` }));
    }
    seen.add(definition.id);
    if (!definition.title.trim()) findings.push(Object.freeze({ code: 'empty-title', entryId: definition.id, detail: `${definition.id} requires a title.` }));
    if (!definition.summary.trim()) findings.push(Object.freeze({ code: 'empty-summary', entryId: definition.id, detail: `${definition.id} requires a summary.` }));
    if (definition.steps.length === 0) findings.push(Object.freeze({ code: 'empty-steps', entryId: definition.id, detail: `${definition.id} requires steps.` }));
    if (definition.steps.length > MAX_STEPS_PER_ENTRY) findings.push(Object.freeze({ code: 'too-many-steps', entryId: definition.id, detail: `${definition.id} exceeds the step budget.` }));
    if (definition.steps.some((step) => !step.trim())) findings.push(Object.freeze({ code: 'empty-step', entryId: definition.id, detail: `${definition.id} contains an empty step.` }));
  }
  return Object.freeze(findings);
};

interface IndexedGuide {
  readonly definition: Readonly<MapWorkspaceGuideDefinition>;
  readonly searchText: string;
}

const indexDefinitions = (definitions: readonly MapWorkspaceGuideDefinition[]): readonly IndexedGuide[] => Object.freeze(
  definitions.slice(0, MAX_GUIDE_ENTRIES).map((definition) => Object.freeze({
    definition,
    searchText: normalizeMapShortcutHelpText([
      definition.title,
      definition.summary,
      CATEGORY_LABELS[definition.category],
      ...definition.steps,
      ...definition.keywords,
      definition.shortcutHint ?? '',
    ].join(' ')),
  })),
);

const createAnnouncement = (resultCount: number, totalCount: number, query: string, category: MapWorkspaceGuideCategory): string => {
  if (!query && category === 'all') return `${totalCount} çalışma alanı rehberi gösteriliyor.`;
  if (resultCount === 0) return 'Filtrelerle eşleşen rehber konusu bulunamadı.';
  return `${resultCount} rehber konusu bulundu.`;
};

const buildSnapshot = (
  revision: number,
  query: string,
  category: MapWorkspaceGuideCategory,
  activeId: string | null,
  indexed: readonly IndexedGuide[],
): MapWorkspaceGuideSnapshot => {
  const normalizedQuery = normalizeMapShortcutHelpText(query);
  const filtered = indexed.filter(({ definition, searchText }) => (
    (category === 'all' || definition.category === category)
    && (!normalizedQuery || searchText.includes(normalizedQuery))
  ));
  const resolvedActiveId = filtered.some(({ definition }) => definition.id === activeId)
    ? activeId
    : filtered[0]?.definition.id ?? null;
  const entries: readonly MapWorkspaceGuideEntry[] = Object.freeze(filtered.map(({ definition }, index) => Object.freeze({
    id: `map-workspace-guide-${definition.id}`,
    sourceId: definition.id,
    category: definition.category,
    categoryLabel: CATEGORY_LABELS[definition.category],
    title: definition.title,
    summary: definition.summary,
    steps: definition.steps,
    shortcutHint: definition.shortcutHint ?? null,
    position: index + 1,
    setSize: filtered.length,
    selected: definition.id === resolvedActiveId,
  })));
  const activeEntry = entries.find((entry) => entry.sourceId === resolvedActiveId) ?? null;
  return Object.freeze({
    revision,
    query,
    normalizedQuery,
    category,
    activeId: resolvedActiveId,
    resultCount: entries.length,
    totalCount: indexed.length,
    entries,
    activeEntry,
    announcement: createAnnouncement(entries.length, indexed.length, normalizedQuery, category),
    empty: entries.length === 0,
  });
};

export class MapWorkspaceGuideModel {
  readonly #indexed: readonly IndexedGuide[];
  readonly #listeners = new Set<() => void>();
  readonly #maxQueryLength: number;
  readonly #maxListeners: number;
  readonly #pageSize: number;
  #snapshot: MapWorkspaceGuideSnapshot;
  #disposed = false;

  constructor(
    definitions: readonly MapWorkspaceGuideDefinition[] = MAP_WORKSPACE_GUIDE_DEFINITIONS,
    options: MapWorkspaceGuideModelOptions = {},
  ) {
    const findings = auditMapWorkspaceGuideCatalog(definitions);
    if (findings.length > 0) throw new Error(`Invalid workspace guide catalog: ${findings.map((finding) => finding.code).join(', ')}`);
    this.#indexed = indexDefinitions(definitions);
    this.#maxQueryLength = clampInteger(options.maxQueryLength, DEFAULT_MAX_QUERY_LENGTH, 1, MAX_QUERY_LENGTH);
    this.#maxListeners = clampInteger(options.maxListeners, DEFAULT_MAX_LISTENERS, 1, MAX_LISTENERS);
    this.#pageSize = clampInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    this.#snapshot = buildSnapshot(0, '', 'all', null, this.#indexed);
  }

  readonly getSnapshot = (): MapWorkspaceGuideSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    if (this.#listeners.has(listener)) return () => this.#listeners.delete(listener);
    if (this.#listeners.size >= this.#maxListeners) throw new Error(`MapWorkspaceGuideModel listener limit exceeded (${this.#maxListeners}).`);
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish(query: string, category: MapWorkspaceGuideCategory, activeId: string | null): void {
    if (this.#disposed) return;
    this.#snapshot = buildSnapshot(this.#snapshot.revision + 1, query, category, activeId, this.#indexed);
    for (const listener of this.#listeners) listener();
  }

  setQuery(value: string): void {
    if (this.#disposed) return;
    const query = value.slice(0, this.#maxQueryLength);
    if (query === this.#snapshot.query) return;
    this.#publish(query, this.#snapshot.category, this.#snapshot.activeId);
  }

  setCategory(category: MapWorkspaceGuideCategory): void {
    if (this.#disposed || category === this.#snapshot.category) return;
    if (!MAP_WORKSPACE_GUIDE_CATEGORIES.some((option) => option.id === category)) return;
    this.#publish(this.#snapshot.query, category, this.#snapshot.activeId);
  }

  setActive(sourceId: string): void {
    if (this.#disposed || sourceId === this.#snapshot.activeId) return;
    if (!this.#snapshot.entries.some((entry) => entry.sourceId === sourceId)) return;
    this.#publish(this.#snapshot.query, this.#snapshot.category, sourceId);
  }

  moveActive(move: MapWorkspaceGuideMove): void {
    if (this.#disposed || this.#snapshot.entries.length === 0) return;
    const entries = this.#snapshot.entries;
    const index = Math.max(0, entries.findIndex((entry) => entry.sourceId === this.#snapshot.activeId));
    let next = index;
    if (move === 'next') next = (index + 1) % entries.length;
    if (move === 'previous') next = (index - 1 + entries.length) % entries.length;
    if (move === 'first') next = 0;
    if (move === 'last') next = entries.length - 1;
    if (move === 'page-next') next = Math.min(entries.length - 1, index + this.#pageSize);
    if (move === 'page-previous') next = Math.max(0, index - this.#pageSize);
    const target = entries[next];
    if (target) this.setActive(target.sourceId);
  }

  reset(): void {
    if (this.#disposed) return;
    this.#publish('', 'all', null);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }

  listenerCount(): number {
    return this.#listeners.size;
  }

  disposed(): boolean {
    return this.#disposed;
  }
}
