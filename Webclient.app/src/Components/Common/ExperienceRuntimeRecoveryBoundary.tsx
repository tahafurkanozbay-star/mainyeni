import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import {
  createRuntimeRecoveryModel,
  type RuntimeRecoveryModel,
  type RuntimeRecoverySnapshot,
} from '../../experience/runtimeRecoveryModel';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import './experience-runtime-recovery.css';

interface CatcherProps {
  readonly children: ReactNode;
  readonly model: RuntimeRecoveryModel;
}

interface CatcherState {
  readonly failed: boolean;
}

class RuntimeErrorCatcher extends Component<CatcherProps, CatcherState> {
  state: CatcherState = { failed: false };

  static getDerivedStateFromError(): CatcherState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const snapshot = this.props.model.snapshot();
    const input = {
      error,
      source: 'react.render',
      componentStack: info.componentStack,
    };

    if (snapshot.phase === 'recovering') {
      this.props.model.failRecovery(input);
    } else {
      this.props.model.capture(input);
    }

    runtimeDiagnostics.captureError(error, {
      source: 'experience.runtime-boundary',
      recoveryPhase: snapshot.phase,
      componentHint: info.componentStack?.split('\n').find(Boolean)?.trim() ?? null,
    });
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface ExperienceRuntimeRecoveryBoundaryProps {
  readonly children: ReactNode;
  readonly model?: RuntimeRecoveryModel;
  readonly onReload?: () => void;
  readonly onRecovered?: () => void;
}

const createDefaultModel = (): RuntimeRecoveryModel => createRuntimeRecoveryModel({
  maxRecoveryAttempts: 2,
  onObserverError(error) {
    runtimeDiagnostics.captureError(error, {
      source: 'experience.runtime-recovery.observer',
    }, 'warn');
  },
});

const defaultReload = (): void => {
  if (typeof window !== 'undefined') window.location.reload();
};

const formatIncidentTime = (capturedAt: number | null): string => {
  if (capturedAt === null) return 'Bilinmiyor';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(capturedAt));
  } catch {
    return 'Bilinmiyor';
  }
};

const RecoverySurface = ({
  snapshot,
  onRecover,
  onReload,
}: {
  readonly snapshot: RuntimeRecoverySnapshot;
  readonly onRecover: () => void;
  readonly onReload: () => void;
}): ReactNode => {
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const failure = snapshot.failure;

  useEffect(() => {
    window.requestAnimationFrame(() => primaryRef.current?.focus());
  }, [snapshot.revision]);

  return (
    <main
      className={`experience-runtime-recovery experience-runtime-recovery--${snapshot.tone}`}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      data-recovery-phase={snapshot.phase}
    >
      <section
        className="experience-runtime-recovery__card"
        aria-labelledby="experience-runtime-recovery-title"
        aria-describedby="experience-runtime-recovery-description"
      >
        <header className="experience-runtime-recovery__header">
          <div className="experience-runtime-recovery__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3 3.8 6.4v5.1c0 4.8 3.2 8.1 8.2 9.5 5-1.4 8.2-4.7 8.2-9.5V6.4L12 3Z" />
              <path d="M9.5 12.2 11.3 14l3.6-4.2" />
            </svg>
          </div>
          <div>
            <span className="experience-runtime-recovery__eyebrow">GÜVENLİ ÇALIŞMA ZAMANI</span>
            <h1 id="experience-runtime-recovery-title">{snapshot.heading}</h1>
          </div>
        </header>

        <p id="experience-runtime-recovery-description" className="experience-runtime-recovery__description">
          {snapshot.message}
        </p>

        <div className="experience-runtime-recovery__facts" aria-label="Kurtarma ayrıntıları">
          <div>
            <span>Olay referansı</span>
            <strong>{failure?.fingerprint ?? 'UI-UNKNOWN'}</strong>
          </div>
          <div>
            <span>Kurtarma</span>
            <strong>{snapshot.recoveryAttempts} / {snapshot.maxRecoveryAttempts}</strong>
          </div>
          <div>
            <span>Zaman</span>
            <strong>{formatIncidentTime(snapshot.capturedAt)}</strong>
          </div>
        </div>

        <div className="experience-runtime-recovery__notice" role="note">
          <strong>Harita verisine dokunulmadı.</strong>
          <span>
            Bu koruma katmanı yalnız React arayüz ağacını yeniden kurar. GIS servisleri, sorgu kayıtları ve kullanıcı verileri üzerinde otomatik değişiklik yapmaz.
          </span>
        </div>

        {failure?.code ? (
          <div className="experience-runtime-recovery__code" role="note">
            <span>Güvenli hata kodu</span>
            <code>{failure.code}</code>
          </div>
        ) : null}

        <div className="experience-runtime-recovery__actions">
          {snapshot.canRecover ? (
            <button
              ref={primaryRef}
              type="button"
              className="experience-runtime-recovery__action experience-runtime-recovery__action--primary"
              onClick={onRecover}
            >
              Arayüzü yeniden kur
            </button>
          ) : (
            <button
              ref={primaryRef}
              type="button"
              className="experience-runtime-recovery__action experience-runtime-recovery__action--primary"
              onClick={onReload}
            >
              Sayfayı güvenli yenile
            </button>
          )}
          {snapshot.canRecover ? (
            <button
              type="button"
              className="experience-runtime-recovery__action experience-runtime-recovery__action--secondary"
              onClick={onReload}
            >
              Sayfayı yenile
            </button>
          ) : null}
        </div>

        <footer className="experience-runtime-recovery__footer">
          <span>Tekrarlayan çökme döngüsü bounded recovery ile engellenir.</span>
          <span>Referans: {failure?.fingerprint ?? 'UI-UNKNOWN'}</span>
        </footer>
      </section>
    </main>
  );
};

export const ExperienceRuntimeRecoveryBoundary = ({
  children,
  model: suppliedModel,
  onReload = defaultReload,
  onRecovered,
}: ExperienceRuntimeRecoveryBoundaryProps): ReactNode => {
  const [model] = useState<RuntimeRecoveryModel>(() => suppliedModel ?? createDefaultModel());
  const [snapshot, setSnapshot] = useState<RuntimeRecoverySnapshot>(() => model.snapshot());
  const [renderEpoch, setRenderEpoch] = useState(0);

  useEffect(() => model.subscribe(setSnapshot), [model]);

  useEffect(() => {
    if (snapshot.phase !== 'recovering') return undefined;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled || model.snapshot().phase !== 'recovering') return;
      model.completeRecovery();
      onRecovered?.();
      runtimeDiagnostics.record('experience.runtime-boundary.recovered', {
        recoveryAttempts: model.snapshot().recoveryAttempts,
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [model, onRecovered, snapshot.phase]);

  const recover = useCallback((): void => {
    if (!model.beginRecovery()) return;
    runtimeDiagnostics.record('experience.runtime-boundary.recovery-started', {
      recoveryAttempt: model.snapshot().recoveryAttempts,
    });
    setRenderEpoch(epoch => epoch + 1);
  }, [model]);

  if (snapshot.phase === 'crashed' || snapshot.phase === 'locked') {
    return (
      <RecoverySurface
        snapshot={snapshot}
        onRecover={recover}
        onReload={onReload}
      />
    );
  }

  return (
    <RuntimeErrorCatcher key={renderEpoch} model={model}>
      {children}
    </RuntimeErrorCatcher>
  );
};

export default ExperienceRuntimeRecoveryBoundary;
