interface ServiceWindowActionsProps {
  readonly title: string;
  readonly minimized: boolean;
  readonly onMinimize: () => void;
  readonly onClose: () => void;
}

export function ServiceWindowActions({ title, minimized, onMinimize, onClose }: ServiceWindowActionsProps) {
  const minimizeLabel = minimized ? 'Sonuçları genişlet' : 'Sonuçları küçült';
  return <>
    <button type="button" className="kr-fast-query__minimize" onClick={onMinimize} aria-label={minimizeLabel} title={minimizeLabel} aria-expanded={!minimized}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ transform: minimized ? 'rotate(180deg)' : undefined }}>
        <path d="m6 15 6-6 6 6" />
      </svg>
    </button>
    <button type="button" className="kr-fast-query__close" onClick={onClose} aria-label={title + ' penceresini kapat'} title="Pencereyi kapat">×</button>
  </>;
}
