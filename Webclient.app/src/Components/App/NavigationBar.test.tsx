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

  it('does not wire / as a global search shortcut', async () => {
    const user = userEvent.setup();
    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
    const otherButton = document.createElement('button');
    otherButton.textContent = 'Other';
    document.body.appendChild(otherButton);
    try {
      otherButton.focus();
      await user.keyboard('/');
      expect(otherButton).toHaveFocus();
      expect(search).not.toHaveFocus();
      expect(search).not.toHaveAttribute('aria-keyshortcuts');
      expect(screen.queryByText(/tuşu arama kutusuna odaklanır/)).not.toBeInTheDocument();
    } finally {
      otherButton.remove();
    }
  });

  it('does not steal / while another text field is being edited', async () => {
    const user = userEvent.setup();
    const auxiliary = document.createElement('input');
    auxiliary.setAttribute('aria-label', 'Yardımcı alan');
    document.body.append(auxiliary);
    try {
      render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
      const search = screen.getByLabelText<HTMLInputElement>('Adres, yer veya katman ara');
      auxiliary.focus();
      await user.keyboard('/');
      expect(auxiliary).toHaveFocus();
      expect(search).not.toHaveFocus();
    } finally {
      auxiliary.remove();
    }
  });

  it('dispatches the explicit theme-toggle command from the header control', () => {
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);

    render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Açık ve koyu tema arasında geçiş yap' }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ name: 'theme-toggle' });
    window.removeEventListener('kentrehberi:command', listener);
  });

  it('exposes CBS Başkent as a safe external link', () => {
    const { container } = render(<NavigationBar windowManager={{ ShowWindow: vi.fn() }} />);
    const cbsLink = container.querySelector<HTMLAnchorElement>('a.kr-header-portal');

    expect(cbsLink).not.toBeNull();
    expect(cbsLink?.getAttribute('aria-label')).toBe('CBS Başkent portalını yeni sekmede aç');
    expect(cbsLink?.getAttribute('href')).toBe('https://cbsbaskent.ankara.bel.tr/');
    expect(cbsLink?.getAttribute('target')).toBe('_blank');
    expect(screen.getAllByRole('link', { name: 'CBS Başkent portalını yeni sekmede aç' })).toHaveLength(1);
    expect(new Set(cbsLink?.getAttribute('rel')?.trim().split(/\s+/))).toEqual(new Set(['noopener', 'noreferrer']));
  });
});
