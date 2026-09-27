import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createFormAccessibilityController } from '../../experience/formAccessibilityController';
import { createFormValidationModel } from '../../experience/formValidationModel';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';

export type WorkspaceDensity = 'comfortable' | 'compact';
export type WorkspaceThemeChoice = 'light' | 'dark';

export interface WorkspacePreferenceValues {
  readonly theme: WorkspaceThemeChoice;
  readonly density: WorkspaceDensity;
  readonly remember: boolean;
}

interface ExperienceWorkspacePreferencesProps {
  readonly theme: WorkspaceThemeChoice;
  readonly density: WorkspaceDensity;
  readonly onApply: (values: WorkspacePreferenceValues) => void | Promise<void>;
  readonly onCancel: () => void;
}

const reportPreferenceError = (error: unknown): void => {
  runtimeDiagnostics.captureError(
    error,
    { source: 'experience.workspace-preferences' },
    'warn',
  );
};

export function ExperienceWorkspacePreferences({
  theme,
  density,
  onApply,
  onCancel,
}: ExperienceWorkspacePreferencesProps): ReactNode {
  const formRef = useRef<HTMLFormElement | null>(null);
  const themeRef = useRef<HTMLSelectElement | null>(null);
  const densityRef = useRef<HTMLSelectElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const themeErrorRef = useRef<HTMLParagraphElement | null>(null);
  const densityErrorRef = useRef<HTMLParagraphElement | null>(null);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const model = useMemo(() => {
    const next = createFormValidationModel({
      mode: 'blur',
      onObserverError: reportPreferenceError,
    });
    next.register({ id: 'theme', label: 'Tema', required: true }, theme);
    next.register({ id: 'density', label: 'Araç yoğunluğu', required: true }, density);
    return next;
  }, [density, theme]);

  useEffect(() => {
    const form = formRef.current;
    const themeElement = themeRef.current;
    const densityElement = densityRef.current;
    if (!form || !themeElement || !densityElement) return undefined;

    const controller = createFormAccessibilityController({
      form,
      model,
      fields: [
        {
          id: 'theme',
          element: themeElement,
          errorElement: themeErrorRef.current ?? undefined,
        },
        {
          id: 'density',
          element: densityElement,
          errorElement: densityErrorRef.current ?? undefined,
        },
      ],
      summary: summaryRef.current ?? undefined,
      status: statusRef.current ?? undefined,
      onObserverError: reportPreferenceError,
      async onSubmit() {
        setSubmitting(true);
        try {
          const snapshot = model.snapshot();
          const selectedTheme = snapshot.fields.theme?.value;
          const selectedDensity = snapshot.fields.density?.value;
          if (selectedTheme !== 'light' && selectedTheme !== 'dark') {
            throw new Error('Unsupported workspace theme preference.');
          }
          if (selectedDensity !== 'comfortable' && selectedDensity !== 'compact') {
            throw new Error('Unsupported workspace density preference.');
          }
          await onApply({
            theme: selectedTheme,
            density: selectedDensity,
            remember,
          });
        } finally {
          setSubmitting(false);
        }
      },
    });

    return () => controller.dispose();
  }, [model, onApply, remember]);

  useEffect(() => () => model.dispose(), [model]);

  return (
    <form ref={formRef} className="experience-preferences" aria-label="Çalışma alanı tercihleri">
      <div className="experience-preferences__heading">
        <div>
          <p className="experience-preferences__eyebrow">Görünüm</p>
          <h2>Çalışma alanı tercihleri</h2>
        </div>
        <p>
          Harita verisini veya GIS davranışını değiştirmeden arayüz temasını ve yardımcı
          araç yoğunluğunu ayarlayın.
        </p>
      </div>

      <div ref={summaryRef} className="experience-preferences__summary" hidden />

      <div className="experience-preferences__field">
        <label htmlFor="experience-preference-theme">Tema</label>
        <select
          ref={themeRef}
          id="experience-preference-theme"
          name="theme"
          defaultValue={theme}
          disabled={submitting}
        >
          <option value="light">Açık tema</option>
          <option value="dark">Koyu tema</option>
        </select>
        <p ref={themeErrorRef} id="experience-preference-theme-error" className="experience-preferences__error" hidden />
      </div>

      <div className="experience-preferences__field">
        <label htmlFor="experience-preference-density">Araç yoğunluğu</label>
        <select
          ref={densityRef}
          id="experience-preference-density"
          name="density"
          defaultValue={density}
          disabled={submitting}
        >
          <option value="comfortable">Rahat — metin etiketleri görünür</option>
          <option value="compact">Kompakt — araç çubuğu daraltılmış</option>
        </select>
        <p ref={densityErrorRef} id="experience-preference-density-error" className="experience-preferences__error" hidden />
      </div>

      <label className="experience-preferences__check" htmlFor="experience-preference-remember">
        <input
          id="experience-preference-remember"
          type="checkbox"
          checked={remember}
          disabled={submitting}
          onChange={(event) => setRemember(event.currentTarget.checked)}
        />
        <span>
          <strong>Bu tarayıcıda hatırla</strong>
          <small>Tercihler yalnızca yerel arayüz ayarı olarak saklanır.</small>
        </span>
      </label>

      <div ref={statusRef} className="experience-preferences__status" />

      <div className="experience-preferences__actions">
        <button type="button" className="experience-preferences__secondary" onClick={onCancel} disabled={submitting}>
          Vazgeç
        </button>
        <button type="submit" className="experience-preferences__primary" disabled={submitting}>
          {submitting ? 'Uygulanıyor…' : 'Tercihleri uygula'}
        </button>
      </div>
    </form>
  );
}

export default ExperienceWorkspacePreferences;
