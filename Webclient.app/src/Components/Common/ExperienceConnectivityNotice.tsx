import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createConnectivityExperienceModel,
  type ConnectivityExperienceModel,
  type ConnectivityExperienceSnapshot,
} from '../../experience/connectivityExperienceModel';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import './experience-connectivity-notice.css';

export interface ExperienceConnectivityNoticeProps {
  readonly model?: ConnectivityExperienceModel;
}

const formatOfflineDuration = (durationMs: number): string => {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds} sn`;
  return `${Math.floor(seconds / 60)} dk ${seconds % 60} sn`;
};

const phaseIcon = (snapshot: ConnectivityExperienceSnapshot): ReactNode => {
  if (snapshot.phase === 'restored') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
        <path d="M5 12.5 9.2 17 19 7" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2.5 8.8a14.7 14.7 0 0 1 19 0M5.8 12.1a10 10 0 0 1 12.4 0M9.1 15.4a5.3 5.3 0 0 1 5.8 0" />
      <path d="M4 4 20 20" />
    </svg>
  );
};

export const ExperienceConnectivityNotice = ({
  model: suppliedModel,
}: ExperienceConnectivityNoticeProps): ReactNode => {
  const model = useMemo<ConnectivityExperienceModel>(() => suppliedModel ?? createConnectivityExperienceModel({
    initialOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    onObserverError(error) {
      runtimeDiagnostics.captureError(error, {
        source: 'experience.connectivity-notice.observer',
      }, 'warn');
    },
  }), [suppliedModel]);
  const [snapshot, setSnapshot] = useState<ConnectivityExperienceSnapshot>(() => model.snapshot());

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
    if (snapshot.phase !== 'offline' && snapshot.phase !== 'restored') return undefined;
    const interval = window.setInterval(() => model.refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [model, snapshot.phase]);

  useEffect(() => {
    if (!snapshot.visible) return;
    runtimeDiagnostics.record('experience.connectivity.changed', {
      phase: snapshot.phase,
      interruptionCount: snapshot.interruptionCount,
      offlineDurationMs: snapshot.offlineDurationMs,
    });
  }, [snapshot.interruptionCount, snapshot.offlineDurationMs, snapshot.phase, snapshot.visible]);

  if (!snapshot.visible) return null;

  return (
    <aside
      className={`experience-connectivity-notice experience-connectivity-notice--${snapshot.tone}`}
      role={snapshot.phase === 'offline' ? 'alert' : 'status'}
      aria-live={snapshot.phase === 'offline' ? 'assertive' : 'polite'}
      aria-atomic="true"
      data-connectivity-phase={snapshot.phase}
    >
      <span className="experience-connectivity-notice__icon">
        {phaseIcon(snapshot)}
      </span>

      <span className="experience-connectivity-notice__copy">
        <strong>{snapshot.heading}</strong>
        <span>{snapshot.message}</span>
      </span>

      <span className="experience-connectivity-notice__meta" aria-label="Bağlantı kesintisi ayrıntıları">
        {snapshot.phase === 'offline'
          ? `Kesinti: ${formatOfflineDuration(snapshot.offlineDurationMs)}`
          : `Kesinti süresi: ${formatOfflineDuration(snapshot.offlineDurationMs)}`}
      </span>

      {snapshot.phase === 'restored' ? (
        <button
          type="button"
          className="experience-connectivity-notice__dismiss"
          onClick={() => model.dismissRestored()}
          aria-label="Bağlantı geri geldi bildirimini kapat"
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </aside>
  );
};

export default ExperienceConnectivityNotice;
