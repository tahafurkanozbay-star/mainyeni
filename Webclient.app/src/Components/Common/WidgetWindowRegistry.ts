import { defineManagedWindow } from './managedWindowLoading';

// Closed tools are off the initial application graph. Each mounts on first use
// and retains its owned state until the map workspace itself is replaced.
export const WIDGET_WINDOW_DEFINITIONS = Object.freeze([
  defineManagedWindow('basemap-widget', 'Altlık Haritalar', () => import('../Widget/Basemap/BasemapWidget'), 'BasemapWidget'),
  defineManagedWindow('bookmark-widget', 'Yer İmleri', () => import('../Widget/Bookmark/BookmarkWidget'), 'BookmarkWidget'),
  defineManagedWindow('context-menu-widget', 'Harita işlemleri', () => import('../Widget/ContextMenu/ContextMenuWidget'), 'ContextMenuWidget'),
  defineManagedWindow('feedback-widget', 'Geri Bildirim', () => import('../Widget/Feedback/FeedbackWidget'), 'FeedbackWidget'),
  defineManagedWindow('global-identify-widget', 'Konum Bilgisi', () => import('../Widget/GlobalIdentify/GlobalIdentifyWidget'), 'GlobalIdentifyWidget'),
  defineManagedWindow('measurement-widget', 'Ölçüm Araçları', () => import('../Widget/Measurement/MeasurementWidget'), 'MeasurementWidget'),
  defineManagedWindow('sketch-widget', 'Çizim Araçları', () => import('../Widget/Sketch/SketchWidget'), 'SketchWidget'),
  defineManagedWindow('streetview-widget', 'Sokak Görüntüsü', () => import('../Widget/StreetView/StreetViewWidget'), 'StreetViewWidget'),
]);
