export type AdminRouteId =
  | "home"
  | "map-config"
  | "config-services"
  | "takbis-config"
  | "layers"
  | "basemaps"
  | "system-logs";

export type AdminRouteGroup = "home" | "configuration" | "layers" | "system";

export interface AdminRouteDefinition {
  readonly id: AdminRouteId;
  readonly path: string;
  readonly label: string;
  readonly group: AdminRouteGroup;
  readonly navigation: boolean;
  readonly description: string;
}

const route = (
  id: AdminRouteId,
  path: string,
  label: string,
  group: AdminRouteGroup,
  description: string,
  navigation = true,
): AdminRouteDefinition => Object.freeze({ id, path, label, group, description, navigation });

export const ADMIN_ROUTES = Object.freeze([
  route("home", "/", "Giriş", "home", "Yönetim paneli başlangıç ekranı."),
  route("map-config", "/mapconfig", "Harita Ayarları", "configuration", "Harita merkez, zoom ve görünüm ayarları."),
  route("config-services", "/configservices", "Konfigürasyon Servisleri", "configuration", "Kent Rehberi servis kataloğu yönetimi."),
  route("takbis-config", "/takbisconfig", "TAKBİS Ayarları", "configuration", "TAKBİS bağlantı ve çalışma ayarları."),
  route("layers", "/layers", "Katmanlar", "layers", "CBS katmanları ve katman grupları."),
  route("basemaps", "/basemaps", "Altlık Haritalar", "layers", "Altlık harita kataloğu."),
  route("system-logs", "/syslogs", "Sistem Kayıtları", "system", "Sistem, hata ve kullanıcı hareketi kayıtları."),
] as const satisfies readonly AdminRouteDefinition[]);

const ROUTE_BY_ID = new Map<AdminRouteId, AdminRouteDefinition>(
  ADMIN_ROUTES.map((item) => [item.id, item]),
);

export const getAdminRoute = (id: AdminRouteId): AdminRouteDefinition => {
  const found = ROUTE_BY_ID.get(id);
  if (!found) throw new Error(`Admin route bulunamadı: ${id}`);
  return found;
};

export const hashHref = (routeOrPath: AdminRouteDefinition | string): string => {
  const path = typeof routeOrPath === "string" ? routeOrPath : routeOrPath.path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `#${normalized}`;
};

export const routesForGroup = (group: AdminRouteGroup): readonly AdminRouteDefinition[] =>
  Object.freeze(ADMIN_ROUTES.filter((item) => item.navigation && item.group === group));

export const normalizeHashPath = (hash: string): string => {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = raw.split(/[?#]/u, 1)[0] ?? "/";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  const collapsed = withSlash.replace(/\/{2,}/gu, "/");
  return collapsed !== "/" ? collapsed.replace(/\/$/u, "") : "/";
};

export const routeForHash = (hash: string): AdminRouteDefinition | null => {
  const path = normalizeHashPath(hash);
  return ADMIN_ROUTES.find((item) => item.path === path) ?? null;
};

export const routeGroups = Object.freeze([
  Object.freeze({ id: "configuration" as const, label: "Konfigürasyon" }),
  Object.freeze({ id: "layers" as const, label: "Katmanlar" }),
  Object.freeze({ id: "system" as const, label: "Sistem" }),
]);
