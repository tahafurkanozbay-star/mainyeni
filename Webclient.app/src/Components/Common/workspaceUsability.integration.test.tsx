import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExperienceDialog } from './ExperienceDialog';
import { ExperienceWorkspace } from './ExperienceWorkspace';

describe('workspace usability composition', () => {
  it('renders the supplied governed mode control without duplicate selectors or fixed settings buttons', async () => {
    render(<ExperienceWorkspace mapModeControl={<button type="button">Görünüm seçimi</button>} />);
    expect(screen.getByRole('button', { name: 'Görünüm seçimi' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Harita görünümü' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Çalışma alanı durumu')).not.toHaveTextContent('2B harita');
    expect(screen.queryByRole('button', { name: 'Deneyim ayarları' })).not.toBeInTheDocument();

    fireEvent(window, new CustomEvent('kentrehberi:command', { detail: { name: 'settings' } }));
    expect(await screen.findByRole('dialog', { name: 'Çalışma alanını kişiselleştir' })).toBeVisible();
  });

  it('mounts modal content outside the map stacking context and releases the portal', () => {
    const view = render(<ExperienceDialog open labelledBy="portal-dialog-title">
      <h2 id="portal-dialog-title">Portal penceresi</h2>
      <button type="button">Kapat</button>
    </ExperienceDialog>);
    const dialog = screen.getByRole('dialog', { name: 'Portal penceresi' });
    expect(view.container.contains(dialog)).toBe(false);
    const portal = dialog.parentElement?.parentElement;
    expect(portal?.parentElement).toBe(document.body);
    view.unmount();
    expect(portal?.isConnected).toBe(false);
    expect(document.body.querySelector('[data-experience-dialog]')).toBeNull();
  });

  it('preserves edited-field focus when an open dialog receives a new close callback', () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const content = <><h2 id="focus-dialog-title">Tercihler</h2><input aria-label="Panel adı" defaultValue="Park" /><button type="button">Tamam</button></>;
    const view = render(<ExperienceDialog open labelledBy="focus-dialog-title" onClose={firstClose}>{content}</ExperienceDialog>);
    const field = screen.getByRole('textbox', { name: 'Panel adı' });
    field.focus();
    fireEvent.change(field, { target: { value: 'Yeni park' } });
    view.rerender(<ExperienceDialog open labelledBy="focus-dialog-title" onClose={latestClose}>{content}</ExperienceDialog>);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Yeni park');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(latestClose).toHaveBeenCalledWith('escape');
    expect(firstClose).not.toHaveBeenCalled();
  });
});
