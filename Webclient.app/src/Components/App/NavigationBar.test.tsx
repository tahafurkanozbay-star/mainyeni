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

  it('focuses and selects global search with Control+K from the shell', async () => {
    const user = userEvent.setup();
    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
    await user.click(search);
    await user.type(search, 'Çankaya');
    await user.click(document.body);
    expect(search).not.toHaveFocus();

    await user.keyboard('{Control>}k{/Control}');

    expect(search).toHaveFocus();
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(search.value.length);
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
  });

  it('does not steal Control+K while another text field is being edited', async () => {
    const user = userEvent.setup();
    const auxiliary = document.createElement('input');
    auxiliary.setAttribute('aria-label', 'Yardımcı alan');
    document.body.append(auxiliary);
    try {
      render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
      const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
      auxiliary.focus();
      await user.keyboard('{Control>}k{/Control}');
      expect(auxiliary).toHaveFocus();
      expect(search).not.toHaveFocus();
    } finally {
      auxiliary.remove();
    }
  });

  it('removes the global shortcut listener when the shell unmounts', async () => {
    const user = userEvent.setup();
    const view = render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
    view.unmount();
    await user.keyboard('{Control>}k{/Control}');
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
