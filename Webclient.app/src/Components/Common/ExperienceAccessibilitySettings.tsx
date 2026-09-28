import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createFormAccessibilityController, type FormAccessibilityController } from '../../experience/formAccessibilityController';
import { createFormValidationModel } from '../../experience/formValidationModel';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';

export type ExperienceDensity = 'comfortable' | 'compact';
export type ExperienceMotion = 'system' | 'reduced';
export type ExperienceContrast = 'system' | 'more';

export interface ExperienceAccessibilityPreferences {
  readonly density: ExperienceDensity;
  readonly motion: ExperienceMotion;
  readonly contrast: ExperienceContrast;
  readonly largeTargets: boolean;
}

const STORAGE_KEY = 'kent-rehberi-experience-accessibility';
const DEFAULT_PREFERENCES: ExperienceAccessibilityPreferences = Object.freeze({
  density: 'comfortable',
  motion: 'system',
  contrast: 'system',
  largeTargets: false,
});

const isDensity = (value: unknown): value is ExperienceDensity => value === 'comfortable' || value === 'compact';
const isMotion = (value: unknown): value is ExperienceMotion => value === 'system' || value === 'reduced';
const isContrast = (value: unknown): value is ExperienceContrast => value === 'system' || value === 'more';

export const normalizeExperienceAccessibilityPreferences = (
  value: unknown,
): ExperienceAccessibilityPreferences => {
  if (!value || typeof value !== 'object') return DEFAULT_PREFERENCES;
  const candidate = value as Record<string, unknown>;
  return Object.freeze({
    density: isDensity(candidate.density) ? candidate.density : DEFAULT_PREFERENCES.density,
    motion: isMotion(candidate.motion) ? candidate.motion : DEFAULT_PREFERENCES.motion,
    contrast: isContrast(candidate.contrast) ? candidate.contrast : DEFAULT_PREFERENCES.contrast,
    largeTargets: candidate.largeTargets === true,
  });
};

export const readExperienceAccessibilityPreferences = (): ExperienceAccessibilityPreferences => {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    return normalizeExperienceAccessibilityPreferences(JSON.parse(raw));
  } catch (error) {
    runtimeDiagnostics.captureError(error, { source: 'experience.accessibility-settings.read' }, 'warn');
    return DEFAULT_PREFERENCES;
  }
};

export const applyExperienceAccessibilityPreferences = (
  preferences: ExperienceAccessibilityPreferences,
): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.experienceDensity = preferences.density;
  root.dataset.experienceMotion = preferences.motion;
  root.dataset.experienceContrast = preferences.contrast;
  root.dataset.experienceLargeTargets = String(preferences.largeTargets);
};

const persistExperienceAccessibilityPreferences = (
  preferences: ExperienceAccessibilityPreferences,
): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
};

const describePreference = (preferences: ExperienceAccessibilityPreferences): string => {
  const density = preferences.density === 'compact' ? 'sıkı' : 'rahat';
  const motion = preferences.motion === 'reduced' ? 'azaltılmış hareket' : 'sistem hareketi';
  const contrast = preferences.contrast === 'more' ? 'yüksek kontrast' : 'sistem kontrastı';
  const targets = preferences.largeTargets ? 'büyük dokunma hedefleri' : 'standart dokunma hedefleri';
  return `${density} yoğunluk, ${motion}, ${contrast}, ${targets}`;
};

interface FieldShellProps {
  readonly label: string;
  readonly hint: string;
  readonly hintId: string;
  readonly errorId: string;
  readonly children: ReactNode;
}

const FieldShell = ({ label, hint, hintId, errorId, children }: FieldShellProps): ReactNode => (
  <div className="experience-settings__field">
    <label className="experience-settings__label">{label}</label>
    {children}
    <span id={hintId} className="experience-settings__hint">{hint}</span>
    <span id={errorId} className="experience-settings__error" hidden />
  </div>
);

export function ExperienceAccessibilitySettings(): ReactNode {
  const initial = useMemo(readExperienceAccessibilityPreferences, []);
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState(initial);
  const [savedSummary, setSavedSummary] = useState(() => describePreference(initial));
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const densityRef = useRef<HTMLSelectElement | null>(null);
  const motionRef = useRef<HTMLSelectElement | null>(null);
  const contrastRef = useRef<HTMLSelectElement | null>(null);
  const targetsRef = useRef<HTMLInputElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<FormAccessibilityController | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    applyExperienceAccessibilityPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!open) return undefined;
    const form = formRef.current;
    const density = densityRef.current;
    const motion = motionRef.current;
    const contrast = contrastRef.current;
    const targets = targetsRef.current;
    if (!form || !density || !motion || !contrast || !targets) return undefined;

    const model = createFormValidationModel({
      mode: 'blur',
      onObserverError(error) {
        runtimeDiagnostics.captureError(error, { source: 'experience.accessibility-settings.validation' }, 'warn');
      },
    });
    const unregister = [
      model.register({ id: 'density', label: 'Arayüz yoğunluğu', required: true }, preferences.density),
      model.register({ id: 'motion', label: 'Hareket tercihi', required: true }, preferences.motion),
      model.register({ id: 'contrast', label: 'Kontrast tercihi', required: true }, preferences.contrast),
      model.register({ id: 'largeTargets', label: 'Dokunma hedefleri' }, String(preferences.largeTargets)),
    ];

    const controller = createFormAccessibilityController({
      form,
      model,
      fields: [
        { id: 'density', element: density, hintElement: document.getElementById('experience-density-hint') ?? undefined, errorElement: document.getElementById('experience-density-error') ?? undefined },
        { id: 'motion', element: motion, hintElement: document.getElementById('experience-motion-hint') ?? undefined, errorElement: document.getElementById('experience-motion-error') ?? undefined },
        { id: 'contrast', element: contrast, hintElement: document.getElementById('experience-contrast-hint') ?? undefined, errorElement: document.getElementById('experience-contrast-error') ?? undefined },
        { id: 'largeTargets', element: targets, hintElement: document.getElementById('experience-targets-hint') ?? undefined, errorElement: document.getElementById('experience-targets-error') ?? undefined },
      ],
      summary: summaryRef.current ?? undefined,
      status: statusRef.current ?? undefined,
      onObserverError(error) {
        runtimeDiagnostics.captureError(error, { source: 'experience.accessibility-settings.controller' }, 'warn');
      },
      onSubmit() {
        const next = normalizeExperienceAccessibilityPreferences({
          density: density.value,
          motion: motion.value,
          contrast: contrast.value,
          largeTargets: targets.checked,
        });
        persistExperienceAccessibilityPreferences(next);
        applyExperienceAccessibilityPreferences(next);
        setPreferences(next);
        setSavedSummary(describePreference(next));
      },
    });
    controllerRef.current = controller;
    density.focus();

    return () => {
      controller.dispose();
      controllerRef.current = null;
      for (const release of unregister) release();
      model.dispose();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const reset = (): void => {
    const next = DEFAULT_PREFERENCES;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      runtimeDiagnostics.captureError(error, { source: 'experience.accessibility-settings.reset' }, 'warn');
    }
    applyExperienceAccessibilityPreferences(next);
    setPreferences(next);
    setSavedSummary(describePreference(next));
    close();
  };

  return (
    <section className="experience-settings" aria-label="Erişilebilirlik tercihleri">
      <button
        ref={triggerRef}
        className="experience-settings__trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="experience-accessibility-settings-dialog"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">Aa</span>
        <span>Erişilebilirlik</span>
      </button>
      <span className="experience-settings__current" aria-live="polite">{savedSummary}</span>

      {open ? (
        <div className="experience-settings__backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}>
          <div
            ref={dialogRef}
            id="experience-accessibility-settings-dialog"
            className="experience-settings__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="experience-accessibility-settings-title"
            aria-describedby="experience-accessibility-settings-description"
          >
            <header className="experience-settings__header">
              <div>
                <p className="experience-settings__eyebrow">Görünüm ve etkileşim</p>
                <h2 id="experience-accessibility-settings-title">Erişilebilirlik tercihleri</h2>
                <p id="experience-accessibility-settings-description">
                  Harita verisini değiştirmeden yoğunluk, hareket, kontrast ve dokunma hedeflerini kişiselleştirin.
                </p>
              </div>
              <button type="button" className="experience-settings__close" onClick={close} aria-label="Erişilebilirlik tercihlerini kapat">×</button>
            </header>

            <form ref={formRef} className="experience-settings__form">
              <div ref={summaryRef} className="experience-settings__summary" hidden />

              <FieldShell label="Arayüz yoğunluğu" hint="Harita üstü kontrollerin ve bilgi yüzeylerinin aralığını belirler." hintId="experience-density-hint" errorId="experience-density-error">
                <select ref={densityRef} id="experience-density" name="density" defaultValue={preferences.density}>
                  <option value="comfortable">Rahat</option>
                  <option value="compact">Sıkı</option>
                </select>
              </FieldShell>

              <FieldShell label="Hareket" hint="Geçiş ve mikro etkileşim hareketlerini azaltabilirsiniz." hintId="experience-motion-hint" errorId="experience-motion-error">
                <select ref={motionRef} id="experience-motion" name="motion" defaultValue={preferences.motion}>
                  <option value="system">Sistem tercihini izle</option>
                  <option value="reduced">Hareketi azalt</option>
                </select>
              </FieldShell>

              <FieldShell label="Kontrast" hint="Sistem kontrastını koruyun veya arayüz sınırlarını güçlendirin." hintId="experience-contrast-hint" errorId="experience-contrast-error">
                <select ref={contrastRef} id="experience-contrast" name="contrast" defaultValue={preferences.contrast}>
                  <option value="system">Sistem tercihini izle</option>
                  <option value="more">Daha yüksek kontrast</option>
                </select>
              </FieldShell>

              <div className="experience-settings__check-field">
                <input ref={targetsRef} id="experience-large-targets" name="largeTargets" type="checkbox" defaultChecked={preferences.largeTargets} />
                <div>
                  <label htmlFor="experience-large-targets">Büyük dokunma hedefleri</label>
                  <span id="experience-targets-hint" className="experience-settings__hint">Dokunmatik kullanım için kontrollerde en az 48 px hedef alanını tercih eder.</span>
                  <span id="experience-targets-error" className="experience-settings__error" hidden />
                </div>
              </div>

              <div ref={statusRef} className="experience-settings__status" />
              <footer className="experience-settings__actions">
                <button type="button" className="experience-settings__secondary" onClick={reset}>Varsayılanlara dön</button>
                <button type="button" className="experience-settings__secondary" onClick={close}>İptal</button>
                <button type="submit" className="experience-settings__primary">Tercihleri kaydet</button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default ExperienceAccessibilitySettings;
