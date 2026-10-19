import { defineManagedWindow } from './managedWindowLoading';

// Public feedback is linked directly to Başkent 153 from the toolbar. The
// legacy API-backed feedback form is not part of the public map workspace.
export const WIDGET_WINDOW_DEFINITIONS = Object.freeze([
  defineManagedWindow('basemap-widget', 'Altlık Haritalar', () => import('../Widget/Basemap/BasemapWidget'), 'BasemapWidget'),
  defineManagedWindow('bookmark-widget', 'Yer İmleri', () => import('../Widget/Bookmark/BookmarkWidget'), 'BookmarkWidget'),
  defineManagedWindow('context-menu-widget', 'Harita işlemleri', () => import('../Widget/ContextMenu/ContextMenuWidget'), 'ContextMenuWidget'),
  defineManagedWindow('global-identify-widget', 'Konum Bilgisi', () => import('../Widget/GlobalIdentify/GlobalIdentifyWidget'), 'GlobalIdentifyWidget'),
  defineManagedWindow('measurement-widget', 'Ölçüm Araçları', () => import('../Widget/Measurement/MeasurementWidget'), 'MeasurementWidget'),
  defineManagedWindow('sketch-widget', 'Çizim Araçları', () => import('../Widget/Sketch/SketchWidget'), 'SketchWidget'),
  defineManagedWindow('streetview-widget', 'Sokak Görüntüsü', () => import('../Widget/StreetView/StreetViewWidget'), 'StreetViewWidget'),
]);
