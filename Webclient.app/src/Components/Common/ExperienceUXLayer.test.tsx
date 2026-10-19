import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NotificationCenterModel } from '../../experience/notificationCenterModel';
import { ExperienceUXLayer, dispatchExperienceCommand } from './ExperienceUXLayer';

const mocks = vi.hoisted(() => ({
  captureError: vi.fn(),
}));

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: mocks.captureError,
  },
}));

const appendSearchInput = (): HTMLInputElement => {
  const input = document.createElement('input');
  input.id = 'kentrehberi-global-search';
  input.type = 'search';
  input.setAttribute('aria-label', 'Adres veya yer ara');
  document.body.appendChild(input);
  return input;
};

const renderLayer = () => {
  const notificationModel = new NotificationCenterModel();
  const result = render(<ExperienceUXLayer notificationModel={notificationModel} />);
  return { ...result, notificationModel };
};

const dispatchHelpCommand = (): void => {
  act(() => dispatchExperienceCommand('help'));
};

describe('ExperienceUXLayer', () => {
  beforeEach(() => {
    mocks.captureError.mockReset();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-experience-overlay-count');
    document.documentElement.removeAttribute('data-experience-modal-open');
    document.documentElement.style.overscrollBehavior = '';
    document.body.removeAttribute('style');
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('does not render the retired floating search and notification controls', () => {
    renderLayer();

    expect(document.querySelector('.experience-utility')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Genel aramayı aç' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bildirim merkezini aç' })).not.toBeInTheDocument();
  });

  it('routes the search command to the address field instead of the retired category query', () => {
    const input = appendSearchInput();
    renderLayer();

    dispatchExperienceCommand('search');

    expect(input).toHaveFocus();
    expect(screen.queryByText(/Kategori\s+\d+/i)).not.toBeInTheDocument();
  });

  it('ignores unsupported retired layer and legend commands', () => {
    const input = appendSearchInput();
    renderLayer();

    dispatchExperienceCommand('layers');
    dispatchExperienceCommand('legend');

    expect(input).not.toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Katman yönetimini aç' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lejandı aç' })).not.toBeInTheDocument();
  });

  it('opens help through the shared overlay stack and focuses its close control', () => {
    appendSearchInput();
    renderLayer();

    dispatchHelpCommand();

    const dialog = screen.getByRole('dialog', { name: 'Hızlı kullanım' });
    const close = screen.getByRole('button', { name: 'Hızlı kullanım: Kapat' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(close);
    expect(document.documentElement).toHaveAttribute('data-experience-modal-open', 'true');
    expect(document.documentElement).toHaveAttribute('data-experience-overlay-count', '1');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes help on Escape and restores focus to address search', () => {
    const input = appendSearchInput();
    renderLayer();
    dispatchHelpCommand();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Hızlı kullanım' })).not.toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(document.documentElement).not.toHaveAttribute('data-experience-modal-open');
    expect(document.body.style.overflow).toBe('');
  });

  it('lets the help action focus address search', () => {
    const input = appendSearchInput();
    renderLayer();
    dispatchHelpCommand();

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Hızlı kullanım' }))
      .getByRole('button', { name: /Adres veya yer ara/i }));

    expect(screen.queryByRole('dialog', { name: 'Hızlı kullanım' })).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('opens the notification center from the notification command and restores focus', () => {
    const input = appendSearchInput();
    const { notificationModel } = renderLayer();
    act(() => notificationModel.push({
      id: 'shared-notification',
      title: 'Ortak bildirim',
      message: 'Tek bildirim modeli üzerinden geldi.',
    }));

    dispatchExperienceCommand('notifications');

    const dialog = screen.getByRole('dialog', { name: 'Bildirim merkezi' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Ortak bildirim' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Bildirim merkezi' })).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('opens full notification history from toast summary and restores focus to address search', () => {
    const input = appendSearchInput();
    const { notificationModel } = renderLayer();

    act(() => {
      for (let index = 0; index < 5; index += 1) {
        notificationModel.push({ id: 'n-' + index, title: 'Kayıt ' + index });
      }
    });

    fireEvent.click(screen.getByRole('button', { name: 'Tüm bildirimleri aç' }));
    expect(screen.getByRole('dialog', { name: 'Bildirim merkezi' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(input).toHaveFocus();
  });

  it('releases overlay lifecycle on unmount', () => {
    appendSearchInput();
    const { unmount } = renderLayer();
    dispatchHelpCommand();
    expect(document.body.style.overflow).toBe('hidden');

    unmount();

    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement).not.toHaveAttribute('data-experience-modal-open');
    expect(document.documentElement).not.toHaveAttribute('data-experience-overlay-count');
  });
});
