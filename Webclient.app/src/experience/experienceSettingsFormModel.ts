import type {
  ExperienceDensity,
  ExperienceMotion,
  ExperiencePanelPlacement,
  ExperiencePreferences,
  ExperienceTheme,
} from './experienceRuntime';
import {
  createFormValidationModel,
  type FormValidationIssue,
  type FormValidationModel,
} from './formValidationModel';

export const EXPERIENCE_SETTINGS_FIELD_IDS = Object.freeze({
  theme: 'experience-theme-setting',
  density: 'experience-density-setting',
  panelPlacement: 'experience-panel-setting',
  motion: 'experience-motion-setting',
  highContrastMapControls: 'experience-high-contrast-setting',
  showCoordinateReadout: 'experience-coordinate-setting',
} as const);

export type ExperienceSettingsFieldName = keyof typeof EXPERIENCE_SETTINGS_FIELD_IDS;
export type ExperienceSettingsFieldId = (typeof EXPERIENCE_SETTINGS_FIELD_IDS)[ExperienceSettingsFieldName];

export interface ExperienceSettingsDraft {
  readonly theme: ExperienceTheme;
  readonly density: ExperienceDensity;
  readonly panelPlacement: ExperiencePanelPlacement;
  readonly motion: ExperienceMotion;
  readonly highContrastMapControls: boolean;
  readonly showCoordinateReadout: boolean;
}

export interface ExperienceSettingsFormModel {
  readonly validation: FormValidationModel;
  snapshot(): ExperienceSettingsDraft;
  setTheme(value: ExperienceTheme): void;
  setDensity(value: ExperienceDensity): void;
  setPanelPlacement(value: ExperiencePanelPlacement): void;
  setMotion(value: ExperienceMotion): void;
  setHighContrastMapControls(value: boolean): void;
  setShowCoordinateReadout(value: boolean): void;
  sync(preferences: ExperiencePreferences): void;
  reset(preferences: ExperiencePreferences): void;
  dispose(): void;
}

const THEME_VALUES = new Set<ExperienceTheme>(['system', 'light', 'dark']);
const DENSITY_VALUES = new Set<ExperienceDensity>(['comfortable', 'compact']);
const PANEL_VALUES = new Set<ExperiencePanelPlacement>(['auto', 'left', 'right', 'bottom']);
const MOTION_VALUES = new Set<ExperienceMotion>(['system', 'reduced', 'full']);

const issue = (code: string, message: string): FormValidationIssue => Object.freeze({ code, message });

const validateTheme = (value: ExperienceTheme): FormValidationIssue | null =>
  THEME_VALUES.has(value) ? null : issue('unsupported-theme', 'Tema tercihi desteklenen seçeneklerden biri olmalıdır.');

const validateDensity = (value: ExperienceDensity): FormValidationIssue | null =>
  DENSITY_VALUES.has(value) ? null : issue('unsupported-density', 'Arayüz yoğunluğu desteklenen seçeneklerden biri olmalıdır.');

const validatePanelPlacement = (value: ExperiencePanelPlacement): FormValidationIssue | null =>
  PANEL_VALUES.has(value) ? null : issue('unsupported-panel-placement', 'Panel yerleşimi desteklenen seçeneklerden biri olmalıdır.');

const validateMotion = (value: ExperienceMotion): FormValidationIssue | null =>
  MOTION_VALUES.has(value) ? null : issue('unsupported-motion', 'Hareket tercihi desteklenen seçeneklerden biri olmalıdır.');

const booleanIssue = (value: boolean, label: string): FormValidationIssue | null =>
  typeof value === 'boolean' ? null : issue('invalid-boolean', `${label} tercihi açık veya kapalı olmalıdır.`);

const draftFromPreferences = (preferences: ExperiencePreferences): ExperienceSettingsDraft => Object.freeze({
  theme: preferences.theme,
  density: preferences.density,
  panelPlacement: preferences.panelPlacement,
  motion: preferences.motion,
  highContrastMapControls: preferences.highContrastMapControls,
  showCoordinateReadout: preferences.showCoordinateReadout,
});

export const createExperienceSettingsFormModel = (
  preferences: ExperiencePreferences,
): ExperienceSettingsFormModel => {
  const validation = createFormValidationModel({ mode: 'blur' });
  let draft = draftFromPreferences(preferences);
  let disposed = false;

  const registrations = [
    validation.register({
      id: EXPERIENCE_SETTINGS_FIELD_IDS.theme,
      label: 'Tema',
      required: true,
      validate: (value: ExperienceTheme) => validateTheme(value),
    }, draft.theme),
    validation.register({
      id: EXPERIENCE_SETTINGS_FIELD_IDS.density,
      label: 'Arayüz yoğunluğu',
      required: true,
      validate: (value: ExperienceDensity) => validateDensity(value),
    }, draft.density),
    validation.register({
      id: EXPERIENCE_SETTINGS_FIELD_IDS.panelPlacement,
      label: 'Panel yerleşimi',
      required: true,
      validate: (value: ExperiencePanelPlacement) => validatePanelPlacement(value),
    }, draft.panelPlacement),
    validation.register({
      id: EXPERIENCE_SETTINGS_FIELD_IDS.motion,
      label: 'Hareket tercihi',
      required: true,
      validate: (value: ExperienceMotion) => validateMotion(value),
    }, draft.motion),
    validation.register({
      id: EXPERIENCE_SETTINGS_FIELD_IDS.highContrastMapControls,
      label: 'Harita kontrollerinde yüksek kontrast',
      validate: (value: boolean) => booleanIssue(value, 'Yüksek kontrast'),
    }, draft.highContrastMapControls),
    validation.register({
      id: EXPERIENCE_SETTINGS_FIELD_IDS.showCoordinateReadout,
      label: 'Koordinat durumu',
      validate: (value: boolean) => booleanIssue(value, 'Koordinat durumu'),
    }, draft.showCoordinateReadout),
  ];

  const assertActive = (): void => {
    if (disposed) throw new Error('ExperienceSettingsFormModel dispose edildikten sonra kullanılamaz.');
  };

  const update = <Key extends ExperienceSettingsFieldName>(key: Key, value: ExperienceSettingsDraft[Key]): void => {
    assertActive();
    draft = Object.freeze({ ...draft, [key]: value });
    validation.setValue(EXPERIENCE_SETTINGS_FIELD_IDS[key], value);
  };

  const sync = (next: ExperiencePreferences): void => {
    assertActive();
    const nextDraft = draftFromPreferences(next);
    (Object.keys(EXPERIENCE_SETTINGS_FIELD_IDS) as ExperienceSettingsFieldName[]).forEach((key) => {
      if (Object.is(draft[key], nextDraft[key])) return;
      validation.setValue(EXPERIENCE_SETTINGS_FIELD_IDS[key], nextDraft[key]);
    });
    draft = nextDraft;
  };

  const reset = (next: ExperiencePreferences): void => {
    assertActive();
    draft = draftFromPreferences(next);
    validation.reset();
    (Object.keys(EXPERIENCE_SETTINGS_FIELD_IDS) as ExperienceSettingsFieldName[]).forEach((key) => {
      validation.setValue(EXPERIENCE_SETTINGS_FIELD_IDS[key], draft[key]);
    });
  };

  return Object.freeze({
    validation,
    snapshot: () => {
      assertActive();
      return draft;
    },
    setTheme: (value: ExperienceTheme) => update('theme', value),
    setDensity: (value: ExperienceDensity) => update('density', value),
    setPanelPlacement: (value: ExperiencePanelPlacement) => update('panelPlacement', value),
    setMotion: (value: ExperienceMotion) => update('motion', value),
    setHighContrastMapControls: (value: boolean) => update('highContrastMapControls', value),
    setShowCoordinateReadout: (value: boolean) => update('showCoordinateReadout', value),
    sync,
    reset,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      registrations.forEach((release) => release());
      validation.dispose();
    },
  });
};
