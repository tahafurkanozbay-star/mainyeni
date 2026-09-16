import {
  createExperienceBus,
  createPreferenceStore,
  type ExperiencePreferences,
  type ExperienceBus,
  type PreferenceStore,
  type StorageLike,
} from './experienceRuntime';

const resolveBrowserStorage = (): StorageLike | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Storage access can be blocked by privacy/sandbox policies. Experience
    // preferences remain fully usable in-memory in that environment.
    return null;
  }
};

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
  storage: resolveBrowserStorage(),
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
