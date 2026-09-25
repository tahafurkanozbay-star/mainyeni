import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppConfig } from '../../Core/AppConfig';
import {
  type StartupExperienceModel,
  type StartupExperienceSnapshot,
} from '../../experience/startupExperienceModel';
import './experience-startup-boundary.css';

export interface ExperienceStartupBoundaryProps {
  readonly model: StartupExperienceModel;
  readonly onRetry: () => void;
  readonly onReload?: () => void;
  readonly children: ReactNode;
}

const formatElapsed = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds} sn`;
  return `${Math.floor(seconds / 60)} dk ${seconds % 60} sn`;
};

const progressValue = (snapshot: StartupExperienceSnapshot): number => {
  if (snapshot.phase === 'delayed') return 82;
  if (snapshot.phase !== 'starting') return 0;
  const ratio = snapshot.delayedAfterMs > 0
    ? snapshot.elapsedMs / snapshot.delayedAfterMs
    : 0;
  return Math.max(12, Math.min(76, Math.round(ratio * 76)));
};

const phaseLabel = (snapshot: StartupExperienceSnapshot): string => {
  switch (snapshot.phase) {
    case 'starting': return 'Başlatılıyor';
    case 'delayed': return 'Yavaş yanıt';
    case 'offline': return 'Çevrimdışı';
    case 'failed': return snapshot.exhausted ? 'Yenileme gerekli' : 'Başlatma hatası';
    case 'ready': return 'Hazır';
    default: return 'Hazırlanıyor';
  }
};

const defaultReload = (): void => {
  if (typeof window !== 'undefined') window.location.reload();
};

export const ExperienceStartupBoundary = ({
  model,
  onRetry,
  onReload = defaultReload,
  children,
}: ExperienceStartupBoundaryProps): ReactNode => {
  const [snapshot, setSnapshot] = useState<StartupExperienceSnapshot>(() => model.snapshot());
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const previousPhaseRef = useRef(snapshot.phase);

  useEffect(() => model.subscribe(setSnapshot), [model]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
    const synchronize = (): void => model.setOnline(navigator.onLine !== false);
    synchronize();
    window.addEventListener('online', synchronize);
    window.addEventListener('offline', synchronize);
    return () => {
      window.removeEventListener('online', synchronize);
      window.removeEventListener('offline', synchronize);
    };
  }, [model]);

  useEffect(() => {
    if (!['starting', 'delayed', 'offline'].includes(snapshot.phase)) return undefined;
    const timer = window.setInterval(() => model.refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [model, snapshot.phase]);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = snapshot.phase;
    if (snapshot.phase !== 'failed' || previousPhase === 'failed') return;
    window.requestAnimationFrame(() => primaryActionRef.current?.focus());
  }, [snapshot.phase]);

  const retry = useCallback((): void => {
    if (model.snapshot().canRetry) onRetry();
  }, [model, onRetry]);

  if (snapshot.ready) return children;

  const failed = snapshot.phase === 'failed';
  const offline = snapshot.phase === 'offline';
  const delayed = snapshot.phase === 'delayed';
  const showReload = failed && (!snapshot.failure?.retryable || snapshot.exhausted);
  const showRetry = failed && snapshot.failure?.retryable !== false && !snapshot.exhausted;
  const title = `${AppConfig.App.Title1} | ${AppConfig.App.Title2}`;

  return (
    <main
      className={`experience-startup experience-startup--${snapshot.tone}`}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      aria-atomic="true"
      aria-busy={snapshot.busy || undefined}
      data-startup-phase={snapshot.phase}
      data-startup-online={String(snapshot.online)}
    >
      <div className="experience-startup__ambient" aria-hidden="true" />
      <section
        className="experience-startup__card"
        aria-labelledby="experience-startup-title"
        aria-describedby="experience-startup-message"
      >
        <header className="experience-startup__brand">
          <img
            src="images/logo.png"
            className="experience-startup__logo"
            alt="Ankara Büyükşehir Belediyesi"
          />
          <div className="experience-startup__brand-copy">
            <span className="experience-startup__eyebrow">KENT REHBERİ</span>
            <strong>{title}</strong>
          </div>
          <span
            className={`experience-startup__phase experience-startup__phase--${snapshot.tone}`}
            aria-label={`Başlatma durumu: ${phaseLabel(snapshot)}`}
          >
            <span className="experience-startup__phase-dot" aria-hidden="true" />
            {phaseLabel(snapshot)}
          </span>
        </header>

        <div className="experience-startup__content">
          <div className="experience-startup__copy">
            <h1 id="experience-startup-title">{snapshot.heading}</h1>
            <p id="experience-startup-message">{snapshot.message}</p>
          </div>

          {!failed && !offline ? (
            <div className="experience-startup__progress-block" aria-hidden="true">
              <div className="experience-startup__progress-track">
                <span
                  className="experience-startup__progress-value"
                  style={{ width: `${progressValue(snapshot)}%` }}
                />
              </div>
              <span className="experience-startup__progress-glow" />
            </div>
          ) : null}

          <dl className="experience-startup__facts" aria-label="Başlatma ayrıntıları">
            <div><dt>Deneme</dt><dd>{snapshot.attempt} / {snapshot.maxAttempts}</dd></div>
            <div><dt>Bağlantı</dt><dd>{snapshot.online ? 'Çevrimiçi' : 'Çevrimdışı'}</dd></div>
            <div><dt>Süre</dt><dd>{formatElapsed(snapshot.elapsedMs)}</dd></div>
          </dl>

          {delayed ? (
            <div className="experience-startup__notice" role="note">
              <strong>İşlem hâlâ devam ediyor.</strong>
              <span>
                Sekmeyi açık bırakabilirsiniz. Kent Rehberi yanıt verir vermez çalışma alanı otomatik açılır.
              </span>
            </div>
          ) : null}

          {offline ? (
            <div className="experience-startup__notice experience-startup__notice--warning" role="note">
              <strong>Ağ bağlantısı bulunamadı.</strong>
              <span>
                İnternet veya kurum ağı bağlantısını kontrol edin. Bağlantı geri geldiğinde durum otomatik güncellenir.
              </span>
            </div>
          ) : null}

          {failed && snapshot.failure ? (
            <div className="experience-startup__diagnostic" role="note">
              <span className="experience-startup__diagnostic-label">Güvenli tanı</span>
              <strong>{snapshot.failure.code ?? 'Başlatma işlemi tamamlanamadı'}</strong>
              <span>Teknik ayrıntılar kullanıcı ekranına taşınmaz; yalnız güvenli hata kodu gösterilir.</span>
            </div>
          ) : null}

          {failed ? (
            <div className="experience-startup__actions">
              {showRetry ? (
                <button
                  ref={primaryActionRef}
                  type="button"
                  className="experience-startup__action experience-startup__action--primary"
                  onClick={retry}
                  disabled={!snapshot.canRetry}
                >
                  {snapshot.online ? 'Tekrar dene' : 'Bağlantı bekleniyor'}
                </button>
              ) : null}
              {showReload ? (
                <button
                  ref={primaryActionRef}
                  type="button"
                  className="experience-startup__action experience-startup__action--primary"
                  onClick={onReload}
                >
                  Sayfayı yenile
                </button>
              ) : null}
              <span className="experience-startup__action-hint">
                {snapshot.exhausted
                  ? 'Otomatik tekrar deneme sınırı doldu. Yeni bir başlangıç için sayfayı güvenli biçimde yenileyin.'
                  : snapshot.online
                    ? 'Yalnız uygulama başlangıcı yeniden denenir; harita verileri değiştirilmez.'
                    : 'Tekrar deneme bağlantı geri gelene kadar devre dışıdır.'}
              </span>
            </div>
          ) : null}
        </div>

        <footer className="experience-startup__footer">
          <span>Güvenli başlangıç</span><span aria-hidden="true">•</span>
          <span>Erişilebilir çalışma alanı</span><span aria-hidden="true">•</span>
          <span>2B + 3B GIS</span>
        </footer>
      </section>
    </main>
  );
};

export default ExperienceStartupBoundary;
