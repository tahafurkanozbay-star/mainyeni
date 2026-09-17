import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NavigationBar } from './NavigationBar';

describe('NavigationBar', () => {
  it('submits the typed global-search payload through the window manager', async () => {
    const user = userEvent.setup();
    const ShowWindow = vi.fn();
    render(<NavigationBar windowManager={{ ShowWindow }} />);

    const search = screen.getByLabelText('Adres, yer veya katman ara');
    await user.type(search, 'Anıtkabir');
    await user.click(screen.getByRole('button', { name: 'Aramayı başlat' }));

    expect(ShowWindow).toHaveBeenCalledTimes(1);
    expect(ShowWindow).toHaveBeenCalledWith('genelarama-query-window', { name: 'Anıtkabir' });
  });

  it('clears and blurs search on Escape', async () => {
    const user = userEvent.setup();
    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);

    const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
    await user.type(search, 'Kızılay');
    expect(search).toHaveValue('Kızılay');

    await user.keyboard('{Escape}');

    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
  });

  it('exposes CBS Başkent as a safe external link', () => {
    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);

    const cbsLink = screen.getByRole('link', { name: 'CBS Başkent portalını yeni sekmede aç' });
    expect(cbsLink).toHaveAttribute('href', 'https://cbsbaskent.ankara.bel.tr');
    expect(cbsLink).toHaveAttribute('target', '_blank');
    expect(cbsLink).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
