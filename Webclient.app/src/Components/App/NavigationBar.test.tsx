import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NavigationBar } from './NavigationBar';

describe('NavigationBar', () => {
  it('opens general search with the trimmed query', async () => {
    const user = userEvent.setup();
    const showWindow = vi.fn();
    render(<NavigationBar windowManager={{ ShowWindow: showWindow }} />);

    const search = screen.getByLabelText('Adres, yer veya katman ara');
    await user.type(search, '  Kızılay  ');
    await user.click(screen.getByRole('button', { name: 'Aramayı başlat' }));

    expect(showWindow).toHaveBeenCalledWith('genelarama-query-window', { name: 'Kızılay' });
  });

  it('does not submit whitespace-only search', async () => {
    const user = userEvent.setup();
    const showWindow = vi.fn();
    render(<NavigationBar windowManager={{ ShowWindow: showWindow }} />);

    const search = screen.getByLabelText('Adres, yer veya katman ara');
    await user.type(search, '   ');
    expect(screen.getByRole('button', { name: 'Aramayı başlat' })).toBeDisabled();
    expect(showWindow).not.toHaveBeenCalled();
  });

  it('clears search and releases focus with Escape', async () => {
    const user = userEvent.setup();
    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
    await user.type(search, 'Ankara');
    expect(search).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
  });

  it('preserves search text and focus when Escape belongs to an active IME composition', () => {
    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
    search.focus();
    fireEvent.change(search, { target: { value: 'Ankara' } });
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: 'Escape', isComposing: true });
    expect(search).toHaveValue('Ankara');
    expect(search).toHaveFocus();
    expect(screen.getByText('Metin girişi sürüyor.')).toBeInTheDocument();
  });

  it('focuses and selects global search with Control+K from the shell', async () => {
    const user = userEvent.setup();
    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
    await user.click(search);
    await user.type(search, 'Çankaya');
    search.blur();
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

    const cbsLink = screen.getByRole<HTMLAnchorElement>('link', { name: 'CBS Başkent portalını yeni sekmede aç' });
    expect(cbsLink).toHaveAttribute('href', 'https://cbsbaskent.ankara.bel.tr/');
    expect(cbsLink).toHaveAttribute('target', '_blank');
    expect(cbsLink).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(cbsLink).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });
});
