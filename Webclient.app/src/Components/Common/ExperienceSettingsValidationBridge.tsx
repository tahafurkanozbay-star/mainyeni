import { useEffect, type ReactNode } from 'react';
import {
  EXPERIENCE_SETTINGS_FIELD_IDS,
  createExperienceSettingsFormModel,
  type ExperienceSettingsFieldId,
} from '../../experience/experienceSettingsFormModel';
import {
  getExperiencePreferences,
  subscribeExperiencePreferences,
} from '../../experience/experienceSession';

/**
 * Progressive validation bridge for the existing ExperienceSettingsDialog.
 *
 * The settings dialog remains the sole visual and persistence authority. This
 * bridge deliberately renders no competing controls and owns no preference
 * store. It connects the canonical validation model to the six production
 * controls after the dialog is mounted through ExperienceDialog's portal.
 * This keeps validation semantics reusable without forcing a second settings
 * surface or weakening the dialog's existing focus lifecycle.
 */

const FIELD_IDS = Object.freeze(Object.values(EXPERIENCE_SETTINGS_FIELD_IDS));
const FIELD_ID_SET = new Set<string>(FIELD_IDS);
const DIALOG_SELECTOR = '[data-testid="experience-settings"]';
const ERROR_CLASS = 'experience-setting-row__validation';
const STATUS_ID = 'experience-settings-validation-status';

type SettingsControl = HTMLSelectElement | HTMLButtonElement;

const isSettingsFieldId = (value: string): value is ExperienceSettingsFieldId =>
  FIELD_ID_SET.has(value);

const resolveControl = (root: ParentNode, id: ExperienceSettingsFieldId): SettingsControl | null => {
  const element = root.querySelector<HTMLElement>(`#${id}`);
  return element instanceof HTMLSelectElement || element instanceof HTMLButtonElement ? element : null;
};

const readControlValue = (control: SettingsControl): unknown => {
  if (control instanceof HTMLSelectElement) return control.value;
  return control.getAttribute('aria-checked') === 'true';
};

const errorId = (fieldId: ExperienceSettingsFieldId): string => `${fieldId}-validation`;

const ensureErrorElement = (control: SettingsControl, fieldId: ExperienceSettingsFieldId): HTMLElement => {
  const row = control.closest('.experience-setting-row');
  const host = row?.querySelector<HTMLElement>('.experience-setting-row__copy') ?? row ?? control.parentElement;
  const existing = host?.querySelector<HTMLElement>(`#${errorId(fieldId)}`);
  if (existing) return existing;

  const error = document.createElement('p');
  error.id = errorId(fieldId);
  error.className = `${ERROR_CLASS} experience-sr-only`;
  error.hidden = true;
  error.setAttribute('data-experience-validation', fieldId);
  host?.append(error);
  return error;
};

const tokens = (value: string | null): string[] =>
  value?.split(/\s+/u).map((token) => token.trim()).filter(Boolean) ?? [];

const setDescribedByToken = (control: SettingsControl, token: string, enabled: boolean): void => {
  const next = new Set(tokens(control.getAttribute('aria-describedby')));
  if (enabled) next.add(token);
  else next.delete(token);
  if (next.size === 0) control.removeAttribute('aria-describedby');
  else control.setAttribute('aria-describedby', [...next].join(' '));
};

const ensureStatus = (dialog: HTMLElement): HTMLElement => {
  const existing = dialog.querySelector<HTMLElement>(`#${STATUS_ID}`);
  if (existing) return existing;
  const status = document.createElement('p');
  status.id = STATUS_ID;
  status.className = 'experience-sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  dialog.append(status);
  return status;
};

export const ExperienceSettingsValidationBridge = (): ReactNode => {
  useEffect(() => {
    let releaseDialog: (() => void) | undefined;
    let activeDialog: HTMLElement | null = null;

    const disconnectDialog = (): void => {
      releaseDialog?.();
      releaseDialog = undefined;
      activeDialog = null;
    };

    const connectDialog = (dialog: HTMLElement): void => {
      if (activeDialog === dialog) return;
      disconnectDialog();
      activeDialog = dialog;

      const model = createExperienceSettingsFormModel(getExperiencePreferences());
      const status = ensureStatus(dialog);
      const cleanup: Array<() => void> = [];
      const controls = new Map<ExperienceSettingsFieldId, SettingsControl>();
      const errors = new Map<ExperienceSettingsFieldId, HTMLElement>();

      for (const id of FIELD_IDS) {
        const control = resolveControl(dialog, id);
        if (!control) continue;
        controls.set(id, control);
        const error = ensureErrorElement(control, id);
        errors.set(id, error);

        const syncValue = (): void => {
          const value = readControlValue(control);
          model.validation.setValue(id, value);
        };
        const validateTouched = (): void => {
          syncValue();
          void model.validation.blur(id);
        };
        control.addEventListener('change', syncValue);
        control.addEventListener('click', syncValue);
        control.addEventListener('blur', validateTouched);
        cleanup.push(() => {
          control.removeEventListener('change', syncValue);
          control.removeEventListener('click', syncValue);
          control.removeEventListener('blur', validateTouched);
        });
      }

      const render = (): void => {
        const snapshot = model.validation.snapshot();
        let visibleErrors = 0;
        for (const [id, control] of controls) {
          const field = snapshot.fields[id];
          const showError = field?.touched === true && field.issue !== null;
          const error = errors.get(id);
          control.setAttribute('aria-invalid', showError ? 'true' : 'false');
          if (!error) continue;
          error.textContent = showError ? field?.issue?.message ?? '' : '';
          error.hidden = !showError;
          setDescribedByToken(control, error.id, showError);
          if (showError) visibleErrors += 1;
        }
        status.textContent = visibleErrors === 0
          ? ''
          : visibleErrors === 1
            ? 'Deneyim ayarlarında düzeltilmesi gereken 1 alan var.'
            : `Deneyim ayarlarında düzeltilmesi gereken ${visibleErrors} alan var.`;
      };

      cleanup.push(model.validation.subscribe(render));
      cleanup.push(subscribeExperiencePreferences(() => {
        model.sync(getExperiencePreferences());
      }));
      render();

      releaseDialog = () => {
        for (const cleanupItem of cleanup.splice(0)) cleanupItem();
        for (const [id, control] of controls) {
          control.removeAttribute('aria-invalid');
          setDescribedByToken(control, errorId(id), false);
        }
        model.dispose();
      };
    };

    const reconcile = (): void => {
      const candidate = document.querySelector<HTMLElement>(DIALOG_SELECTOR);
      if (!candidate) {
        disconnectDialog();
        return;
      }
      connectDialog(candidate);
    };

    reconcile();
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true });

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !isSettingsFieldId(target.id)) return;
      reconcile();
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
      disconnectDialog();
    };
  }, []);

  return null;
};

export default ExperienceSettingsValidationBridge;
