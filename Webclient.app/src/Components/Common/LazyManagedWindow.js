import React, { Suspense, useEffect, useRef } from 'react';
import './LazyManagedWindow.css';

const WindowLoadingFallback = ({ label }) => (
  <section className="kr-lazy-window" role="status" aria-live="polite" aria-busy="true">
    <span className="kr-lazy-window__spinner" aria-hidden="true" />
    <div>
      <strong>{label || 'Araç yükleniyor'}</strong>
      <span>Gerekli arayüz kodu hazırlanıyor…</span>
    </div>
  </section>
);

export function LazyManagedWindow({ id, label, component: Component, windowManager, componentProps }) {
  const componentRef = useRef(null);

  useEffect(() => {
    windowManager?.RegisterPlaceholder?.(id);
    return () => windowManager?.UnregisterWindow?.(id, componentRef);
  }, [id, windowManager]);

  if (!windowManager?.IsVisible?.(id)) return null;

  return (
    <Suspense fallback={<WindowLoadingFallback label={label} />}>
      <Component
        id={id}
        ref={componentRef}
        windowManager={windowManager}
        {...componentProps}
      />
    </Suspense>
  );
}

export default LazyManagedWindow;
