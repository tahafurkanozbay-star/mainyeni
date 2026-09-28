import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  patchExperiencePreferences,
  resetExperiencePreferences,
} from '../../experience/experienceSession';
import { ExperienceSettingsValidationBridge } from './ExperienceSettingsValidationBridge';

const createSelect = (
  id: string,
  values: readonly string[],
  selected: string,
): HTMLSelectElement => {
  const select = document.createElement('select');
  select.id = id;
  select.setAttribute('aria-describedby', `${id}-hint`);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  select.value = selected;
  return select;
};

const createToggle = (id: string, checked: boolean): HTMLButtonElement => {
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', checked ? 'true' : 'false');
  button.setAttribute('aria-describedby', `${id}-hint`);
  return button;
};

const rowFor = (control: HTMLElement, label: string): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'experience-setting-row';
  const copy = document.createElement('div');
  copy.className = 'experience-setting-row__copy';
  const heading = document.createElement('span');
  heading.textContent = label;
  const hint = document.createElement('span');
  hint.id = `${control.id}-hint`;
  hint.textContent = `${label} açıklaması`;
  copy.append(heading, hint);
  row.append(copy, control);
  return row;
};

const createSettingsDialog = (): HTMLElement => {
  const dialog = document.createElement('section');
  dialog.dataset.testid = 'experience-settings';
  dialog.setAttribute('aria-label', 'Deneyim ayarları');

  dialog.append(
    rowFor(createSelect(
      'experience-theme-setting',
      ['system', 'light', 'dark', 'unsupported-theme'],
      'system',
    ), 'Tema'),
    rowFor(createSelect(
      'experience-density-setting',
      ['comfortable', 'compact', 'unsupported-density'],
      'comfortable',
    ), 'Yoğunluk'),
    rowFor(createSelect(
      'experience-panel-setting',
      ['auto', 'left', 'right', 'bottom', 'unsupported-panel'],
      'auto',
    ), 'Panel'),
    rowFor(createSelect(
      'experience-motion-setting',
      ['system', 'reduced', 'full', 'unsupported-motion'],
      'system',
    ), 'Hareket'),
    rowFor(createToggle('experience-high-contrast-setting', false), 'Yüksek kontrast'),
    rowFor(createToggle('experience-coordinate-setting', true), 'Koordinat'),
  );
  return dialog;
};

const validationError = (dialog: HTMLElement, fieldId: string): HTMLElement | null =>
  dialog.querySelector<HTMLElement>(`#${fieldId}-validation`);

const status = (dialog: HTMLElement): HTMLElement | null =>
  dialog.querySelector<HTMLElement>('#experience-settings-validation-status');

afterEach(() => {
  document.body.replaceChildren();
  resetExperiencePreferences();
});

describe('ExperienceSettingsValidationBridge', () => {
  test('connects to a settings dialog that mounts after the bridge', async () => {
    render(<ExperienceSettingsValidationBridge />);
    const dialog = createSettingsDialog();
    document.body.append(dialog);

    await waitFor(() => {
      expect(status(dialog)).toBeInTheDocument();
    });

    expect(status(dialog)).toHaveAttribute('role', 'status');
    expect(status(dialog)).toHaveAttribute('aria-live', 'polite');
    expect(dialog.querySelectorAll('[data-experience-validation]')).toHaveLength(6);
  });

  test('reveals a field error only after the field is touched', async () => {
    const dialog = createSettingsDialog();
    document.body.append(dialog);
    render(<ExperienceSettingsValidationBridge />);

    const theme = dialog.querySelector<HTMLSelectElement>('#experience-theme-setting');
    expect(theme).not.toBeNull();

    await waitFor(() => expect(validationError(dialog, 'experience-theme-setting')).toBeInTheDocument());
    expect(theme).toHaveAttribute('aria-invalid', 'false');
    expect(validationError(dialog, 'experience-theme-setting')).toHaveAttribute('hidden');

    fireEvent.change(theme as HTMLSelectElement, { target: { value: 'unsupported-theme' } });
    expect(theme).toHaveAttribute('aria-invalid', 'false');

    fireEvent.blur(theme as HTMLSelectElement);

    await waitFor(() => expect(theme).toHaveAttribute('aria-invalid', 'true'));
    const error = validationError(dialog, 'experience-theme-setting');
    expect(error).not.toHaveAttribute('hidden');
    expect(error).toHaveTextContent('Tema tercihi desteklenen seçeneklerden biri olmalıdır.');
    expect(theme?.getAttribute('aria-describedby')).toContain('experience-theme-setting-hint');
    expect(theme?.getAttribute('aria-describedby')).toContain('experience-theme-setting-validation');
    expect(status(dialog)).toHaveTextContent('düzeltilmesi gereken 1 alan');
  });

  test('clears validation error after a touched field becomes valid', async () => {
    const dialog = createSettingsDialog();
    document.body.append(dialog);
    render(<ExperienceSettingsValidationBridge />);
    const density = dialog.querySelector<HTMLSelectElement>('#experience-density-setting') as HTMLSelectElement;

    await waitFor(() => expect(validationError(dialog, density.id)).toBeInTheDocument());
    fireEvent.change(density, { target: { value: 'unsupported-density' } });
    fireEvent.blur(density);
    await waitFor(() => expect(density).toHaveAttribute('aria-invalid', 'true'));

    fireEvent.change(density, { target: { value: 'compact' } });
    fireEvent.blur(density);

    await waitFor(() => expect(density).toHaveAttribute('aria-invalid', 'false'));
    expect(validationError(dialog, density.id)).toHaveAttribute('hidden');
    expect(validationError(dialog, density.id)).toHaveTextContent('');
    expect(density.getAttribute('aria-describedby')).toBe('experience-density-setting-hint');
    expect(status(dialog)).toHaveTextContent('');
  });

  test('counts multiple touched invalid fields in the polite status', async () => {
    const dialog = createSettingsDialog();
    document.body.append(dialog);
    render(<ExperienceSettingsValidationBridge />);
    const theme = dialog.querySelector<HTMLSelectElement>('#experience-theme-setting') as HTMLSelectElement;
    const motion = dialog.querySelector<HTMLSelectElement>('#experience-motion-setting') as HTMLSelectElement;

    await waitFor(() => expect(status(dialog)).toBeInTheDocument());
    fireEvent.change(theme, { target: { value: 'unsupported-theme' } });
    fireEvent.blur(theme);
    fireEvent.change(motion, { target: { value: 'unsupported-motion' } });
    fireEvent.blur(motion);

    await waitFor(() => expect(status(dialog)).toHaveTextContent('düzeltilmesi gereken 2 alan'));
    expect(theme).toHaveAttribute('aria-invalid', 'true');
    expect(motion).toHaveAttribute('aria-invalid', 'true');
  });

  test('syncs canonical preference changes without marking untouched fields invalid', async () => {
    const dialog = createSettingsDialog();
    document.body.append(dialog);
    render(<ExperienceSettingsValidationBridge />);
    const theme = dialog.querySelector<HTMLSelectElement>('#experience-theme-setting') as HTMLSelectElement;

    await waitFor(() => expect(status(dialog)).toBeInTheDocument());
    patchExperiencePreferences({ theme: 'dark', density: 'compact' });

    await waitFor(() => expect(theme).toHaveAttribute('aria-invalid', 'false'));
    expect(status(dialog)).toHaveTextContent('');
  });

  test('reconnects when the portal replaces the dialog node', async () => {
    const first = createSettingsDialog();
    document.body.append(first);
    render(<ExperienceSettingsValidationBridge />);
    await waitFor(() => expect(status(first)).toBeInTheDocument());

    const firstTheme = first.querySelector<HTMLSelectElement>('#experience-theme-setting') as HTMLSelectElement;
    const second = createSettingsDialog();
    first.replaceWith(second);

    await waitFor(() => expect(status(second)).toBeInTheDocument());
    expect(firstTheme).not.toHaveAttribute('aria-invalid');
    expect(second.querySelector('#experience-theme-setting')).toHaveAttribute('aria-invalid', 'false');
  });

  test('preserves pre-existing description tokens while adding and removing errors', async () => {
    const dialog = createSettingsDialog();
    document.body.append(dialog);
    render(<ExperienceSettingsValidationBridge />);
    const panel = dialog.querySelector<HTMLSelectElement>('#experience-panel-setting') as HTMLSelectElement;

    await waitFor(() => expect(validationError(dialog, panel.id)).toBeInTheDocument());
    fireEvent.change(panel, { target: { value: 'unsupported-panel' } });
    fireEvent.blur(panel);
    await waitFor(() => expect(panel).toHaveAttribute('aria-invalid', 'true'));

    const invalidTokens = panel.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    expect(invalidTokens).toContain('experience-panel-setting-hint');
    expect(invalidTokens).toContain('experience-panel-setting-validation');

    fireEvent.change(panel, { target: { value: 'right' } });
    fireEvent.blur(panel);
    await waitFor(() => expect(panel).toHaveAttribute('aria-invalid', 'false'));
    expect(panel.getAttribute('aria-describedby')).toBe('experience-panel-setting-hint');
  });

  test('cleans bridge-owned aria state when unmounted', async () => {
    const dialog = createSettingsDialog();
    document.body.append(dialog);
    const { unmount } = render(<ExperienceSettingsValidationBridge />);
    const theme = dialog.querySelector<HTMLSelectElement>('#experience-theme-setting') as HTMLSelectElement;

    await waitFor(() => expect(status(dialog)).toBeInTheDocument());
    fireEvent.change(theme, { target: { value: 'unsupported-theme' } });
    fireEvent.blur(theme);
    await waitFor(() => expect(theme).toHaveAttribute('aria-invalid', 'true'));

    unmount();

    expect(theme).not.toHaveAttribute('aria-invalid');
    expect(theme.getAttribute('aria-describedby')).toBe('experience-theme-setting-hint');
  });

  test('tolerates a partial dialog while lazy controls are still mounting', async () => {
    const dialog = document.createElement('section');
    dialog.dataset.testid = 'experience-settings';
    const theme = createSelect('experience-theme-setting', ['system', 'dark'], 'system');
    dialog.append(rowFor(theme, 'Tema'));
    document.body.append(dialog);

    expect(() => render(<ExperienceSettingsValidationBridge />)).not.toThrow();
    await waitFor(() => expect(status(dialog)).toBeInTheDocument());
    expect(dialog.querySelectorAll('[data-experience-validation]')).toHaveLength(1);
    expect(theme).toHaveAttribute('aria-invalid', 'false');
  });
});
