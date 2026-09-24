import { fireEvent, render, screen } from '@testing-library/react';
import { ExperienceUXLayer, dispatchExperienceCommand } from './ExperienceUXLayer';

const mocks = vi.hoisted(() => ({
  layerOnShow: vi.fn(),
  toggleTheme: vi.fn(),
  captureError: vi.fn(),
  themeState: { theme: 'light' as 'light' | 'dark' },
}));

vi.mock('./ExperienceDesignSystem', () => ({
  useExperienceTheme: () => ({
    theme: mocks.themeState.theme,
    preference: mocks.themeState.theme,
    setTheme: vi.fn(),
    toggleTheme: mocks.toggleTheme,
  }),
}));

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: mocks.captureError,
  },
}));

vi.mock('../Widget/LayerList/LayerListWidget', async () => {
  const ReactModule = await import('react');
  return {
    LayerListWidget: ReactModule.forwardRef((_props, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        OnShow: mocks.layerOnShow,
      }));
      return ReactModule.createElement('div', {
        'data-testid': 'layer-list-widget',
      });
    }),
  };
});

const createWindowManager = () => ({
  ShowWindow: vi.fn(() => true),
  RegisterWindow: vi.fn(() => true),
  UnregisterWindow: vi.fn(() => true),
});

describe('ExperienceUXLayer', () => {
  beforeEach(() => {
    mocks.layerOnShow.mockReset();
    mocks.toggleTheme.mockReset();
    mocks.captureError.mockReset();
    mocks.themeState.theme = 'light';
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-experience-theme');
    document.documentElement.removeAttribute('data-experience-overlay-count');
    document.documentElement.removeAttribute('data-experience-modal-open');
    document.documentElement.style.overscrollBehavior = '';
    document.body.removeAttribute('style');
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  test('renders the utility navigation with accessible labels', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    expect(screen.getByRole('complementary', {
      name: 'Kent Rehberi yardımcı araçları',
    })).toBeInTheDocument();

    expect(screen.getByRole('navigation', {
      name: 'Hızlı araçlar',
    })).toBeInTheDocument();

    expect(screen.getByRole('button', {
      name: 'Genel aramayı aç',
    })).toBeInTheDocument();

    expect(screen.getByRole('button', {
      name: 'Katman yönetimini aç',
    })).toBeInTheDocument();

    expect(screen.getByRole('button', {
      name: 'Lejandı aç',
    })).toBeInTheDocument();

    expect(screen.getByRole('button', {
      name: 'Bildirim merkezini aç',
    })).toBeInTheDocument();
  });

  test('routes search actions through the canonical window manager', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.click(screen.getByRole('button', {
      name: 'Genel aramayı aç',
    }));

    expect(manager.ShowWindow).toHaveBeenCalledWith(
      'genelarama-query-window',
    );
  });

  test('routes layer and legend actions to the managed layer surface', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.click(screen.getByRole('button', {
      name: 'Katman yönetimini aç',
    }));
    fireEvent.click(screen.getByRole('button', {
      name: 'Lejandı aç',
    }));

    expect(mocks.layerOnShow).toHaveBeenNthCalledWith(1, 'layers');
    expect(mocks.layerOnShow).toHaveBeenNthCalledWith(2, 'legend');
  });

  test('responds to externally dispatched Experience commands', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    dispatchExperienceCommand('search');
    dispatchExperienceCommand('layers');
    dispatchExperienceCommand('legend');

    expect(manager.ShowWindow).toHaveBeenCalledWith(
      'genelarama-query-window',
    );
    expect(mocks.layerOnShow).toHaveBeenCalledWith('layers');
    expect(mocks.layerOnShow).toHaveBeenCalledWith('legend');
  });

  test('collapses and expands utility copy without removing controls', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    const collapse = screen.getByRole('button', {
      name: 'Yardımcı araçları daralt',
    });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Çalışma alanı')).toBeInTheDocument();

    fireEvent.click(collapse);

    const expand = screen.getByRole('button', {
      name: 'Yardımcı araçları genişlet',
    });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Çalışma alanı')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Genel aramayı aç',
    })).toBeInTheDocument();

    fireEvent.click(expand);
    expect(screen.getByText('Çalışma alanı')).toBeInTheDocument();
  });

  test('opens help through the shared overlay stack and focuses the close control', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.click(screen.getByRole('button', {
      name: 'Kısayolları ve yardım bilgisini aç',
    }));

    const dialog = screen.getByRole('dialog', {
      name: 'Hızlı kullanım',
    });
    const close = screen.getByRole('button', {
      name: 'Hızlı kullanım: Kapat',
    });

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(close);
    expect(document.documentElement).toHaveAttribute(
      'data-experience-modal-open',
      'true',
    );
    expect(document.documentElement).toHaveAttribute(
      'data-experience-overlay-count',
      '1',
    );
    expect(document.body.style.overflow).toBe('hidden');
  });

  test('opens the notification center as an accessible drawer', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    const opener = screen.getByRole('button', {
      name: 'Bildirim merkezini aç',
    });
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByRole('dialog', {
      name: 'Bildirim merkezi',
    })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Yeni bildirim yok')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', {
      name: 'Bildirim merkezi',
    })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  test('opens help with the question-mark shortcut outside editable fields', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.keyDown(document.body, {
      key: '?',
    });

    expect(screen.getByRole('dialog', {
      name: 'Hızlı kullanım',
    })).toBeInTheDocument();
  });

  test('does not open help while a user types in an editable field', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.keyDown(input, {
      key: '?',
    });

    expect(screen.queryByRole('dialog', {
      name: 'Hızlı kullanım',
    })).not.toBeInTheDocument();
  });

  test('dispatches the command-palette shortcut from normal content', () => {
    const manager = createWindowManager();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);

    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.keyDown(document.body, {
      key: 'k',
      ctrlKey: true,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent | undefined;
    expect(event?.detail).toEqual({
      name: 'command-palette',
    });

    window.removeEventListener('kentrehberi:command', listener);
  });

  test('allows Ctrl/Cmd+K while focus is in a search field', () => {
    const input = document.createElement('input');
    input.type = 'search';
    document.body.appendChild(input);

    const manager = createWindowManager();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);

    render(<ExperienceUXLayer windowManager={manager} />);
    fireEvent.keyDown(input, {
      key: 'k',
      metaKey: true,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('Escape closes help and restores focus to the invoking control', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    const opener = screen.getByRole('button', {
      name: 'Kısayolları ve yardım bilgisini aç',
    });
    opener.focus();
    fireEvent.click(opener);

    expect(screen.getByRole('dialog', {
      name: 'Hızlı kullanım',
    })).toBeInTheDocument();

    fireEvent.keyDown(document, {
      key: 'Escape',
    });

    expect(screen.queryByRole('dialog', {
      name: 'Hızlı kullanım',
    })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
    expect(document.documentElement).not.toHaveAttribute(
      'data-experience-modal-open',
    );
    expect(document.body.style.overflow).toBe('');
  });

  test('clicking the shared backdrop closes help without treating dialog clicks as backdrop clicks', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.click(screen.getByRole('button', {
      name: 'Kısayolları ve yardım bilgisini aç',
    }));

    const dialog = screen.getByRole('dialog', {
      name: 'Hızlı kullanım',
    });
    fireEvent.mouseDown(dialog);
    expect(dialog).toBeInTheDocument();

    const backdrop = document.querySelector(
      '[data-experience-dialog-id="experience-help"]',
    );
    if (!(backdrop instanceof HTMLElement)) {
      throw new Error('Shared help backdrop was not rendered');
    }
    fireEvent.mouseDown(backdrop);

    expect(screen.queryByRole('dialog', {
      name: 'Hızlı kullanım',
    })).not.toBeInTheDocument();
  });

  test('help action can open layers and closes the modal first', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    fireEvent.click(screen.getByRole('button', {
      name: 'Kısayolları ve yardım bilgisini aç',
    }));
    fireEvent.click(screen.getByRole('button', {
      name: /Katmanlar\s*Aç/i,
    }));

    expect(screen.queryByRole('dialog', {
      name: 'Hızlı kullanım',
    })).not.toBeInTheDocument();
    expect(mocks.layerOnShow).toHaveBeenCalledWith('layers');
  });

  test('theme control exposes the next action, delegates to the provider, and emits bounded feedback', () => {
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    const themeButton = screen.getByRole('button', {
      name: 'Koyu temaya geç',
    });
    fireEvent.click(themeButton);

    expect(mocks.toggleTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveAttribute(
      'data-experience-theme',
      'light',
    );
    expect(window.localStorage.getItem(
      'kent-rehberi-experience-theme',
    )).toBe('light');
    expect(screen.getByText('Koyu tema seçildi')).toBeInTheDocument();
  });

  test('renders the dark-theme action label when dark theme is active', () => {
    mocks.themeState.theme = 'dark';
    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    expect(screen.getByRole('button', {
      name: 'Açık temaya geç',
    })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute(
      'data-experience-theme',
      'dark',
    );
  });

  test('reports local-storage failures instead of silently swallowing them', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage unavailable');
      });

    const manager = createWindowManager();
    render(<ExperienceUXLayer windowManager={manager} />);

    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      { source: 'experience.ux-layer.theme-persistence' },
      'warn',
    );

    setItem.mockRestore();
  });

  test('releases shared modal and shortcut lifecycle on unmount', () => {
    const manager = createWindowManager();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);

    const { unmount } = render(
      <ExperienceUXLayer windowManager={manager} />,
    );

    fireEvent.click(screen.getByRole('button', {
      name: 'Kısayolları ve yardım bilgisini aç',
    }));
    expect(document.body.style.overflow).toBe('hidden');

    unmount();

    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement).not.toHaveAttribute(
      'data-experience-modal-open',
    );
    expect(document.documentElement).not.toHaveAttribute(
      'data-experience-overlay-count',
    );

    fireEvent.keyDown(document.body, {
      key: 'k',
      ctrlKey: true,
    });
    expect(listener).not.toHaveBeenCalled();

    window.removeEventListener('kentrehberi:command', listener);
  });
});
