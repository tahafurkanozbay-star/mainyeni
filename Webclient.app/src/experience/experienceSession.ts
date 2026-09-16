import {
  createExperienceBus,
  createPreferenceStore,
  type ExperiencePreferences,
  type ExperienceBus,
  type PreferenceStore,
} from './experienceRuntime';

/**
 * One process-wide Experience session.
 *
 * The legacy UI used to create independent preference/theme stores in multiple
 * component modules. Keeping a single authority prevents theme, density and
 * map-mode state from drifting when React 19 remounts or lazy boundaries are
 * introduced.
 */
export const experienceBus: ExperienceBus = createExperienceBus();
export const experiencePreferenceStore: PreferenceStore = createPreferenceStore({
  bus: experienceBus,
});

export const getExperiencePreferences = (): ExperiencePreferences =>
  experiencePreferenceStore.get();

export const subscribeExperiencePreferences = (notify: () => void): (() => void) =>
  experiencePreferenceStore.subscribe(() => notify());

export const patchExperiencePreferences = (
  patch: Partial<ExperiencePreferences>,
): ExperiencePreferences => experiencePreferenceStore.set(patch);

export const resetExperiencePreferences = (): ExperiencePreferences =>
  experiencePreferenceStore.reset();
