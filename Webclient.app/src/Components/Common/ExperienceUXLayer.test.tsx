import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NotificationCenterModel } from '../../experience/notificationCenterModel';
import { ExperienceUXLayer, dispatchExperienceCommand } from './ExperienceUXLayer';

const dispatchHelpCommand = (): void => {
  act(() => dispatchExperienceCommand('help'));
};

const mocks = vi.hoisted(() => ({
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

const createWindowManager = () => ({
  ShowWindow: vi.fn(() => true),
  RegisterWindow: vi.fn(() => true),
  UnregisterWindow: vi.fn(() => true),
});

const renderLayer = (manager = createWindowManager()) => {
  const notificationModel = new NotificationCenterModel();
  const result = render(
    <ExperienceUXLayer
      windowManager={manager}
      notificationModel={notificationModel}
    />,
  );
  return { ...result, manager, notificationModel };
};

describe('ExperienceUXLayer', () => {
  beforeEach(() => {
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

  test('removes the bottom-right utility rail, search action, and notification-center action', () => {
    renderLayer();

    expect(screen.queryByRole('complementary', {
      name: 'Kent Rehberi yardımcı araçları',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Genel aramayı aç' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bildirim merkezini aç' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Koyu temaya geç' })).not.toBeInTheDocument();
  });

  test('routes search commands through the canonical window manager', () => {
    const manager = createWindowManager();
    renderLayer(manager);

    dispatchExperienceCommand('search');

    expect(manager.ShowWindow).toHaveBeenCalledWith('genelarama-query-window');
  });

  test('does not render retired API-backed layer and legend controls', () => {
    renderLayer();
    expect(screen.queryByRole('button', { name: 'Katman yönetimini aç' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lejandı aç' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('layer-list-widget')).not.toBeInTheDocument();
  });

  test('routes only supported externally dispatched Experience commands', () => {
    const manager = createWindowManager();
    renderLayer(manager);

    dispatchExperienceCommand('search');
    dispatchExperienceCommand('layers');
    dispatchExperienceCommand('legend');

    expect(manager.ShowWindow).toHaveBeenCalledTimes(1);
    expect(manager.ShowWindow).toHaveBeenCalledWith('genelarama-query-window');
  });

  test('keeps notification drawers available through explicit commands without a floating trigger', () => {
    const manager = createWindowManager();
    renderLayer(manager);
    dispatchExperienceCommand('notifications');
    expect(screen.getByRole('dialog', { name: 'Bildirim merkezi' })).toBeInTheDocument();
  });

  test('opens help through the shared overlay stack and focuses the close control', () => {
    const manager = createWindowManager();
    renderLayer(manager);

    dispatchHelpCommand();

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

  test('opens the notification center via command and restores focus to the header control', () => {
    const manager = createWindowManager();
    const opener = document.createElement('button');
    opener.id = 'mainbar-theme-toggle';
    opener.textContent = 'Tema';
    document.body.append(opener);
    const { notificationModel } = renderLayer(manager);
    act(() => notificationModel.push({
      id: 'shared-notification',
      title: 'Ortak bildirim',
      message: 'Tek notification authority üzerinden geldi.',
    }));

    opener.focus();
    act(() => dispatchExperienceCommand('notifications'));

    const dialog = screen.getByRole('dialog', { name: 'Bildirim merkezi' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Ortak bildirim' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Bildirim merkezi' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  test('does not open a second help dialog from the question-mark shortcut', () => {
    const manager = createWindowManager();
    renderLayer(manager);

    fireEvent.keyDown(document.body, {
      key: '?',
    });

    expect(screen.queryByRole('dialog', {
      name: 'Hızlı kullanım',
    })).not.toBeInTheDocument();
  });

  test('does not create a duplicate help dialog while typing in an editable field', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    const manager = createWindowManager();
    renderLayer(manager);

    fireEvent.keyDown(input, {
      key: '?',
    });

    expect(screen.queryByRole('dialog', {
      name: 'Hızlı kullanım',
    })).not.toBeInTheDocument();
  });

  test('does not dispatch a command-palette event for Ctrl+K', () => {
    const manager = createWindowManager();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);

    renderLayer(manager);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('does not dispatch a command-palette event for Cmd+K in a search field', () => {
    const input = document.createElement('input');
    input.type = 'search';
    document.body.appendChild(input);

    const manager = createWindowManager();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);

    renderLayer(manager);
    fireEvent.keyDown(input, { key: 'k', metaKey: true });

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('kentrehberi:command', listener);
  });

  test('Escape closes help and restores focus to the header theme control', () => {
    const manager = createWindowManager();
    const opener = document.createElement('button');
    opener.id = 'mainbar-theme-toggle';
    opener.textContent = 'Tema';
    document.body.append(opener);
    renderLayer(manager);

    opener.focus();
    dispatchHelpCommand();

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
    renderLayer(manager);

    dispatchHelpCommand();

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

  test('help dialog contains only supported direct-source actions', () => {
    const manager = createWindowManager();
    renderLayer(manager);

    dispatchHelpCommand();
    expect(screen.getByRole('dialog', { name: 'Hızlı kullanım' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Hızlı kullanım' })).getByRole('button', { name: /Genel arama.*Aç/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Katmanlar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lejand/i })).not.toBeInTheDocument();
    expect(manager.ShowWindow).not.toHaveBeenCalled();
  });

  test('delegates the header theme command to the canonical theme provider without a toast', () => {
    const { notificationModel } = renderLayer();

    act(() => dispatchExperienceCommand('theme-toggle'));

    expect(mocks.toggleTheme).toHaveBeenCalledTimes(1);
    expect(notificationModel.snapshot().items.some((item) => item.id === 'experience-theme-feedback')).toBe(false);
    expect(screen.queryByText('Koyu tema seçildi')).not.toBeInTheDocument();
  });

  test('supports a theme-toggle command while dark theme is active', () => {
    mocks.themeState.theme = 'dark';
    renderLayer();

    act(() => dispatchExperienceCommand('theme-toggle'));

    expect(mocks.toggleTheme).toHaveBeenCalledTimes(1);
  });

  test('leaves theme DOM and persistence to the canonical workspace preference owner', () => {
    document.documentElement.dataset.experienceTheme = 'dark';
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderLayer();
    expect(document.documentElement.dataset.experienceTheme).toBe('dark');
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  test('releases shared modal and shortcut lifecycle on unmount', () => {
    const manager = createWindowManager();
    const listener = vi.fn();
    window.addEventListener('kentrehberi:command', listener);

    const { unmount } = renderLayer(manager);

    dispatchHelpCommand();
    expect(document.body.style.overflow).toBe('hidden');
    // Ignore the intentional command event used to open help; this spy checks cleanup.
    listener.mockClear();

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
  test('opens full notification history from the bounded toast summary and returns keyboard focus', () => {
    const opener = document.createElement('button');
    opener.id = 'mainbar-theme-toggle';
    opener.textContent = 'Tema';
    document.body.append(opener);
    const { notificationModel } = renderLayer();
    act(() => {
      for (let index = 0; index < 5; index += 1) notificationModel.push({ id: `n-${index}`, title: `Kayıt ${index}` });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tüm bildirimleri aç' }));
    expect(screen.getByRole('dialog', { name: 'Bildirim merkezi' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });

});
