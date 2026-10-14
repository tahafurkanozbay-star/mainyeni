import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationCenterModel } from '../../experience/notificationCenterModel';
import { ExperienceNotificationCenter } from './ExperienceNotificationCenter';

vi.mock('./ExperienceFeedbackCenter', () => ({
  ExperienceFeedbackCenter: ({
    label,
    callerId,
  }: {
    readonly label: string;
    readonly callerId: string;
  }) => (
    <section
      data-testid="governed-feedback-center"
      data-caller-id={callerId}
      data-label={label}
    >
      Governed feedback history
    </section>
  ),
}));

const createModel = (): NotificationCenterModel => new NotificationCenterModel({
  now: () => 1_800_000_000_000,
});

const push = (
  model: NotificationCenterModel,
  id: string,
  options: {
    readonly tone?: 'info' | 'success' | 'warning' | 'error';
    readonly priority?: 'normal' | 'urgent';
    readonly dismissible?: boolean;
    readonly action?: boolean;
  } = {},
): void => {
  model.push({
    id,
    title: `Bildirim ${id}`,
    message: `${id} ayrıntısı`,
    tone: options.tone ?? 'info',
    priority: options.priority ?? 'normal',
    dismissible: options.dismissible ?? true,
    actions: options.action ? [{ id: 'open', label: 'Aç' }] : [],
  });
};

describe('ExperienceNotificationCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates center mode to the governed feedback history surface', () => {
    const model = createModel();
    push(model, 'one');

    render(
      <ExperienceNotificationCenter
        model={model}
        mode="center"
        label="Bildirim merkezi"
      />,
    );

    const center = screen.getByTestId('governed-feedback-center');
    expect(center).toHaveAttribute('data-label', 'Bildirim merkezi');
    expect(center).toHaveAttribute('data-caller-id', 'experience-utility-notifications');
    expect(screen.getByLabelText('Bildirim merkezi')).toHaveAttribute('data-unread-count', '1');
  });

  it('preserves assertive source announcements while governed history is mounted', () => {
    const model = createModel();
    render(<ExperienceNotificationCenter model={model} mode="center" />);

    act(() => {
      push(model, 'critical', { tone: 'error', priority: 'urgent' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Hata: Bildirim critical. critical ayrıntısı');
    expect(screen.getByTestId('governed-feedback-center')).toBeInTheDocument();
  });

  it('preserves polite source announcements in center mode', () => {
    const model = createModel();
    const { container } = render(<ExperienceNotificationCenter model={model} mode="center" />);

    act(() => {
      push(model, 'ready', { tone: 'success' });
    });

    const polite = container.querySelector('[aria-live="polite"]');
    expect(polite).toHaveTextContent('Başarılı: Bildirim ready. ready ayrıntısı');
  });

  it('keeps toast mode independent from the governed center surface', () => {
    const model = createModel();
    push(model, 'toast');

    render(<ExperienceNotificationCenter model={model} mode="toasts" />);

    expect(screen.queryByTestId('governed-feedback-center')).not.toBeInTheDocument();
    expect(screen.getByText('Bildirim toast')).toBeInTheDocument();
    expect(screen.getByLabelText('Bildirimler')).toHaveAttribute('data-unread-count', '1');
  });

  it('shows only unread notifications in toast mode', () => {
    const model = createModel();
    push(model, 'read');
    push(model, 'unread');
    model.markRead('read');

    render(<ExperienceNotificationCenter model={model} mode="toasts" />);

    expect(screen.queryByText('Bildirim read')).not.toBeInTheDocument();
    expect(screen.getByText('Bildirim unread')).toBeInTheDocument();
  });

  it('bounds visible toast count without mutating the source model', () => {
    const model = createModel();
    for (let index = 0; index < 6; index += 1) push(model, `toast-${index}`);

    render(
      <ExperienceNotificationCenter
        model={model}
        mode="toasts"
        maxVisibleToasts={2}
      />,
    );

    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('4 bildirim daha var')).toBeInTheDocument();
    expect(model.snapshot().items).toHaveLength(6);
  });

  it('marks a toast read before forwarding its action', () => {
    const model = createModel();
    const onAction = vi.fn();
    push(model, 'action', { action: true });

    render(
      <ExperienceNotificationCenter
        model={model}
        mode="toasts"
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Aç' }));

    expect(model.snapshot().items.find((item) => item.id === 'action')?.read).toBe(true);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Bildirim action')).not.toBeInTheDocument();
  });

  it('dismisses dismissible toasts through the source authority', () => {
    const model = createModel();
    push(model, 'dismiss');

    render(<ExperienceNotificationCenter model={model} mode="toasts" />);

    fireEvent.click(screen.getByRole('button', { name: 'Bildirim dismiss: bildirimi kapat' }));

    expect(model.snapshot().items).toHaveLength(0);
    expect(screen.queryByText('Bildirim dismiss')).not.toBeInTheDocument();
  });

  it('does not expose a dismiss control for sticky/non-dismissible feedback', () => {
    const model = createModel();
    push(model, 'fixed', { dismissible: false });

    render(<ExperienceNotificationCenter model={model} mode="toasts" />);

    expect(screen.queryByRole('button', { name: 'Bildirim fixed: bildirimi kapat' })).not.toBeInTheDocument();
    expect(screen.getByText('Bildirim fixed')).toBeInTheDocument();
  });
  it('keeps older urgent feedback visible before newer normal notifications without reordering the model', () => {
    const model = createModel();
    push(model, 'urgent', { priority: 'urgent' });
    push(model, 'error', { tone: 'error' });
    push(model, 'normal');
    const onOpenCenter = vi.fn();
    render(<ExperienceNotificationCenter model={model} maxVisibleToasts={2} onOpenCenter={onOpenCenter} />);
    expect(screen.getAllByRole('article').map((item) => item.dataset.notificationId)).toEqual(['error', 'urgent']);
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['normal', 'error', 'urgent']);
    fireEvent.click(screen.getByRole('button', { name: 'Tüm bildirimleri aç' }));
    expect(onOpenCenter).toHaveBeenCalledOnce();
  });

  it('announces each toast through one live channel and keeps card labels instance scoped', () => {
    const model = createModel();
    push(model, 'same id', { tone: 'error' });
    const { container } = render(<><ExperienceNotificationCenter model={model} /><ExperienceNotificationCenter model={model} /></>);
    const cards = screen.getAllByRole('article');
    const labels = cards.map((card) => card.getAttribute('aria-labelledby'));
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(document.getElementById(label!)).toHaveTextContent('Bildirim same id');
    expect(container.querySelectorAll('article[role="alert"], article[role="status"]')).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('does not display an action that has no registered handler', () => {
    const model = createModel();
    push(model, 'action', { action: true });
    render(<ExperienceNotificationCenter model={model} />);
    expect(screen.queryByRole('button', { name: 'Aç' })).not.toBeInTheDocument();
    expect(model.snapshot().unreadCount).toBe(1);
  });

  it('moves keyboard focus to the next toast, then back to the caller when the last toast is dismissed', () => {
    const model = createModel();
    push(model, 'older');
    push(model, 'newer');
    render(<><button id="caller">Bildirim geçmişi</button><ExperienceNotificationCenter model={model} returnFocusId="caller" /></>);
    const newerClose = screen.getByRole('button', { name: 'Bildirim newer: bildirimi kapat' });
    newerClose.focus();
    fireEvent.click(newerClose);
    const olderClose = screen.getByRole('button', { name: 'Bildirim older: bildirimi kapat' });
    expect(olderClose).toHaveFocus();
    fireEvent.click(olderClose);
    expect(screen.getByRole('button', { name: 'Bildirim geçmişi' })).toHaveFocus();
  });

  it('focuses the surviving card when it has no controls and skips an inert caller', () => {
    const model = createModel();
    push(model, 'fixed', { dismissible: false });
    push(model, 'closing');
    render(<><div inert><button id="caller">Caller</button></div><ExperienceNotificationCenter model={model} returnFocusId="caller" /></>);
    const close = screen.getByRole('button', { name: 'Bildirim closing: bildirimi kapat' });
    close.focus();
    fireEvent.click(close);
    expect(screen.getByRole('article')).toHaveFocus();
  });

  it('preserves focus moved by an action callback and does not steal focus on pointer dismissal', () => {
    const model = createModel();
    push(model, 'action', { action: true });
    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.append(outside);
    render(<ExperienceNotificationCenter model={model} onAction={() => outside.focus()} />);
    const action = screen.getByRole('button', { name: 'Aç' });
    action.focus();
    fireEvent.click(action);
    expect(outside).toHaveFocus();
    act(() => push(model, 'pointer'));
    fireEvent.click(screen.getByRole('button', { name: 'Bildirim pointer: bildirimi kapat' }));
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('releases its model subscription after StrictMode replay and unmount', () => {
    const model = createModel();
    const { unmount } = render(<React.StrictMode><ExperienceNotificationCenter model={model} /></React.StrictMode>);
    expect(model.observerDiagnostics().activeObserverCount).toBe(1);
    unmount();
    expect(model.observerDiagnostics().activeObserverCount).toBe(0);
  });

});
