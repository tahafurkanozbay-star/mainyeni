import type { ServiceDefinition, ViewSnapshot } from "../types.js";

const VISIBILITY_KEY = "baskent3d:visibility";
const BASEMAP_KEY = "baskent3d:basemap";
const CAMERA_KEY = "baskent3d:camera";

export function readVisibility(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(VISIBILITY_KEY) ?? "{}"); } catch { return {}; }
}

export function saveVisibility(services: ServiceDefinition[]): void {
  localStorage.setItem(VISIBILITY_KEY, JSON.stringify(Object.fromEntries(services.map((s) => [s.id, s.visible]))));
}

export function readBasemap(): string {
  return localStorage.getItem(BASEMAP_KEY) ?? "satellite";
}

export function saveBasemap(id: string): void {
  localStorage.setItem(BASEMAP_KEY, id);
}

export function readCamera(): ViewSnapshot | undefined {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    return raw ? (JSON.parse(raw) as ViewSnapshot) : undefined;
  } catch { return undefined; }
}

export function saveCamera(camera: ViewSnapshot): void {
  localStorage.setItem(CAMERA_KEY, JSON.stringify(camera));
}
