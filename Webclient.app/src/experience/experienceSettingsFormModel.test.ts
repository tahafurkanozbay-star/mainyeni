import { describe, expect, it } from 'vitest';
import type { ExperiencePreferences } from './experienceRuntime';
import {
  createExperienceSettingsFormModel,
  EXPERIENCE_SETTINGS_FIELD_IDS,
} from './experienceSettingsFormModel';

const preferences = (overrides: Partial<ExperiencePreferences> = {}): ExperiencePreferences => ({
  theme: 'system',
  density: 'comfortable',
  panelPlacement: 'auto',
  motion: 'system',
  highContrastMapControls: false,
  showCoordinateReadout: true,
  lastMapMode: '2d',
  ...overrides,
});

describe('experienceSettingsFormModel', () => {
  it('starts from the canonical experience preferences without creating another persistence authority', () => {
    const model = createExperienceSettingsFormModel(preferences());
    expect(model.snapshot()).toEqual({
      theme: 'system',
      density: 'comfortable',
      panelPlacement: 'auto',
      motion: 'system',
      highContrastMapControls: false,
      showCoordinateReadout: true,
    });
    expect(model.validation.snapshot().fieldOrder).toEqual([
      EXPERIENCE_SETTINGS_FIELD_IDS.theme,
      EXPERIENCE_SETTINGS_FIELD_IDS.density,
      EXPERIENCE_SETTINGS_FIELD_IDS.panelPlacement,
      EXPERIENCE_SETTINGS_FIELD_IDS.motion,
      EXPERIENCE_SETTINGS_FIELD_IDS.highContrastMapControls,
      EXPERIENCE_SETTINGS_FIELD_IDS.showCoordinateReadout,
    ]);
    model.dispose();
  });

  it('uses the existing production control ids as validation identities', () => {
    expect(EXPERIENCE_SETTINGS_FIELD_IDS).toEqual({
      theme: 'experience-theme-setting',
      density: 'experience-density-setting',
      panelPlacement: 'experience-panel-setting',
      motion: 'experience-motion-setting',
      highContrastMapControls: 'experience-high-contrast-setting',
      showCoordinateReadout: 'experience-coordinate-setting',
    });
  });

  it('tracks theme changes through the shared validation model', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.setTheme('dark');
    expect(model.snapshot().theme).toBe('dark');
    const field = model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.theme];
    expect(field?.value).toBe('dark');
    expect(field?.dirty).toBe(true);
    model.dispose();
  });

  it('tracks density changes through the shared validation model', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.setDensity('compact');
    expect(model.snapshot().density).toBe('compact');
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.density]?.dirty).toBe(true);
    model.dispose();
  });

  it('tracks panel placement changes through the shared validation model', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.setPanelPlacement('bottom');
    expect(model.snapshot().panelPlacement).toBe('bottom');
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.panelPlacement]?.value).toBe('bottom');
    model.dispose();
  });

  it('tracks motion changes through the shared validation model', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.setMotion('reduced');
    expect(model.snapshot().motion).toBe('reduced');
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.motion]?.value).toBe('reduced');
    model.dispose();
  });

  it('tracks high contrast changes through the shared validation model', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.setHighContrastMapControls(true);
    expect(model.snapshot().highContrastMapControls).toBe(true);
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.highContrastMapControls]?.value).toBe(true);
    model.dispose();
  });

  it('tracks coordinate readout changes through the shared validation model', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.setShowCoordinateReadout(false);
    expect(model.snapshot().showCoordinateReadout).toBe(false);
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.showCoordinateReadout]?.value).toBe(false);
    model.dispose();
  });

  it('validates all canonical settings as a single form contract', async () => {
    const model = createExperienceSettingsFormModel(preferences());
    await expect(model.validation.validateAll()).resolves.toBe(true);
    expect(model.validation.snapshot().invalidFieldIds).toEqual([]);
    model.dispose();
  });

  it('keeps preference sync deterministic when the session changes externally', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.sync(preferences({
      theme: 'dark',
      density: 'compact',
      panelPlacement: 'right',
      motion: 'reduced',
      highContrastMapControls: true,
      showCoordinateReadout: false,
    }));
    expect(model.snapshot()).toEqual({
      theme: 'dark',
      density: 'compact',
      panelPlacement: 'right',
      motion: 'reduced',
      highContrastMapControls: true,
      showCoordinateReadout: false,
    });
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.theme]?.value).toBe('dark');
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.density]?.value).toBe('compact');
    model.dispose();
  });

  it('does not mark unchanged external preference sync as a new dirty mutation', () => {
    const initial = preferences();
    const model = createExperienceSettingsFormModel(initial);
    model.sync(initial);
    expect(model.validation.snapshot().fieldOrder.every((id) => model.validation.snapshot().fields[id]?.dirty === false)).toBe(true);
    model.dispose();
  });

  it('synchronizes only changed values when external preferences advance', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.sync(preferences({ theme: 'light' }));
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.theme]?.dirty).toBe(true);
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.density]?.dirty).toBe(false);
    expect(model.validation.snapshot().fields[EXPERIENCE_SETTINGS_FIELD_IDS.motion]?.dirty).toBe(false);
    model.dispose();
  });

  it('reset re-establishes a supplied canonical preference snapshot', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.setTheme('dark');
    model.setDensity('compact');
    model.reset(preferences({ theme: 'light', panelPlacement: 'left' }));
    expect(model.snapshot().theme).toBe('light');
    expect(model.snapshot().density).toBe('comfortable');
    expect(model.snapshot().panelPlacement).toBe('left');
    model.dispose();
  });

  it('can submit the canonical settings contract without an alternate store', async () => {
    const model = createExperienceSettingsFormModel(preferences());
    await expect(model.validation.beginSubmit()).resolves.toBe(true);
    expect(model.validation.snapshot().submitting).toBe(true);
    expect(model.validation.snapshot().submitCount).toBe(1);
    model.validation.endSubmit();
    expect(model.validation.snapshot().submitting).toBe(false);
    model.dispose();
  });

  it('preserves lastMapMode outside the settings-form draft boundary', () => {
    const model = createExperienceSettingsFormModel(preferences({ lastMapMode: '3d' }));
    expect(model.snapshot()).not.toHaveProperty('lastMapMode');
    model.dispose();
  });

  it('returns an immutable draft snapshot', () => {
    const model = createExperienceSettingsFormModel(preferences());
    expect(Object.isFrozen(model.snapshot())).toBe(true);
    model.dispose();
  });

  it('supports repeated idempotent disposal', () => {
    const model = createExperienceSettingsFormModel(preferences());
    expect(() => {
      model.dispose();
      model.dispose();
    }).not.toThrow();
  });

  it('rejects use after disposal', () => {
    const model = createExperienceSettingsFormModel(preferences());
    model.dispose();
    expect(() => model.snapshot()).toThrow(/dispose edildikten sonra/);
    expect(() => model.setTheme('dark')).toThrow(/dispose edildikten sonra/);
    expect(() => model.sync(preferences())).toThrow(/dispose edildikten sonra/);
  });

  it('keeps every form field label available for accessible error summaries', () => {
    const model = createExperienceSettingsFormModel(preferences());
    const snapshot = model.validation.snapshot();
    expect(snapshot.fields[EXPERIENCE_SETTINGS_FIELD_IDS.theme]?.label).toBe('Tema');
    expect(snapshot.fields[EXPERIENCE_SETTINGS_FIELD_IDS.density]?.label).toBe('Arayüz yoğunluğu');
    expect(snapshot.fields[EXPERIENCE_SETTINGS_FIELD_IDS.panelPlacement]?.label).toBe('Panel yerleşimi');
    expect(snapshot.fields[EXPERIENCE_SETTINGS_FIELD_IDS.motion]?.label).toBe('Hareket tercihi');
    expect(snapshot.fields[EXPERIENCE_SETTINGS_FIELD_IDS.highContrastMapControls]?.label).toBe('Harita kontrollerinde yüksek kontrast');
    expect(snapshot.fields[EXPERIENCE_SETTINGS_FIELD_IDS.showCoordinateReadout]?.label).toBe('Koordinat durumu');
    model.dispose();
  });

  it('keeps all settings validation synchronous and bounded', async () => {
    const model = createExperienceSettingsFormModel(preferences());
    const before = model.validation.snapshot().revision;
    await model.validation.validateAll();
    const after = model.validation.snapshot();
    expect(after.revision).toBeGreaterThan(before);
    expect(after.fieldOrder).toHaveLength(6);
    expect(after.invalidFieldIds).toHaveLength(0);
    model.dispose();
  });
});
