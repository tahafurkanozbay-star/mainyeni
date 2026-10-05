import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FeedbackHistoryItem, FeedbackHistoryState } from '../../experience/feedbackHistoryExperience';
import { ExperienceFeedbackDigest } from './ExperienceFeedbackDigest';

const NOW = 2_000_000_000_000;
const MINUTE = 60_000;

const item = (
  id: string,
  overrides: Partial<FeedbackHistoryItem> = {},
): FeedbackHistoryItem => Object.freeze({
  id,
  semanticId: `feedback-${id}`,
  title: `Bildirim ${id}`,
  message: null,
  tone: 'neutral',
  priority: 'polite',
  occurredAt: NOW - 30 * MINUTE,
  read: false,
  important: false,
  ...overrides,
});

const history = (
  items: readonly FeedbackHistoryItem[],
  filter: FeedbackHistoryState['filter'] = 'all',
): FeedbackHistoryState => Object.freeze({
  items: Object.freeze([...items]),
  filter,
  sort: 'newest',
  activeId: items[0]?.id ?? null,
  unreadCount: items.filter((entry) => !entry.read).length,
  importantCount: items.filter((entry) => entry.important).length,
});

const renderDigest = (
  state: FeedbackHistoryState,
  selectedFilter: FeedbackHistoryState['filter'] = state.filter,
  onSelectFilter = vi.fn(),
) => {
  const result = render(
    <ExperienceFeedbackDigest
      history={state}
      selectedFilter={selectedFilter}
      onSelectFilter={onSelectFilter}
      now={NOW}
    />,
  );
  return { ...result, onSelectFilter };
};

describe('ExperienceFeedbackDigest', () => {
  it('renders a quiet empty digest', () => {
    renderDigest(history([]));
    const digest = screen.getByRole('complementary', { name: 'Çalışma alanı sakin' });
    expect(digest).toHaveAttribute('data-health', 'quiet');
    expect(screen.getByText('Son yedi günlük çalışma alanı geçmişinde bildirim yok.')).toBeInTheDocument();
    expect(screen.getByLabelText('0 yeni bildirim')).toBeInTheDocument();
  });

  it('renders deterministic total, unread and important quick filters', () => {
    renderDigest(history([
      item('important', { important: true, tone: 'warning' }),
      item('read', { read: true }),
    ]));
    const group = screen.getByLabelText('Bildirim hızlı filtreleri');
    expect(within(group).getByRole('button', { name: 'Toplam: 2' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Okunmamış: 1' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Önemli: 1' })).toBeInTheDocument();
  });

  it('marks the selected quick filter as pressed', () => {
    renderDigest(history([item('one')], 'unread'), 'unread');
    expect(screen.getByRole('button', { name: 'Okunmamış: 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Toplam: 1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('selects unread through the quick filter without owning navigation state', () => {
    const { onSelectFilter } = renderDigest(history([item('one')]));
    fireEvent.click(screen.getByRole('button', { name: 'Okunmamış: 1' }));
    expect(onSelectFilter).toHaveBeenCalledTimes(1);
    expect(onSelectFilter).toHaveBeenCalledWith('unread');
  });

  it('selects important through the quick filter', () => {
    const { onSelectFilter } = renderDigest(history([
      item('one', { important: true, tone: 'warning' }),
    ]));
    fireEvent.click(screen.getByRole('button', { name: 'Önemli: 1' }));
    expect(onSelectFilter).toHaveBeenCalledWith('important');
  });

  it('selects all through the total quick filter', () => {
    const { onSelectFilter } = renderDigest(history([item('one')], 'unread'), 'unread');
    fireEvent.click(screen.getByRole('button', { name: 'Toplam: 1' }));
    expect(onSelectFilter).toHaveBeenCalledWith('all');
  });

  it('disables unread and important filters when those collections are empty', () => {
    renderDigest(history([
      item('read', { read: true }),
    ]));
    expect(screen.getByRole('button', { name: 'Okunmamış: 0' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Önemli: 0' })).toBeDisabled();
  });

  it('renders a stable reviewed history', () => {
    renderDigest(history([
      item('success', { tone: 'success', read: true }),
      item('info', { read: true }),
    ]));
    expect(screen.getByRole('complementary')).toHaveAttribute('data-health', 'stable');
    expect(screen.getByText('Bildirimler kontrol altında')).toBeInTheDocument();
  });

  it('renders attention when a warning is pending', () => {
    renderDigest(history([
      item('warning', { important: true, tone: 'warning' }),
    ]));
    expect(screen.getByRole('complementary')).toHaveAttribute('data-health', 'attention');
    expect(screen.getByText('Önemli bildirimler bekliyor')).toBeInTheDocument();
  });

  it('renders critical health for a danger event', () => {
    renderDigest(history([
      item('danger', { important: true, tone: 'danger' }),
    ]));
    expect(screen.getByRole('complementary')).toHaveAttribute('data-health', 'critical');
    expect(screen.getByText('Kritik bildirimleri inceleyin')).toBeInTheDocument();
  });

  it('shows a tone distribution without duplicating list navigation', () => {
    renderDigest(history([
      item('danger', { important: true, tone: 'danger' }),
      item('warning', { important: true, tone: 'warning' }),
      item('success', { tone: 'success', read: true }),
      item('info', { read: true }),
    ]));
    expect(screen.getByText('1 hata · 1 uyarı · 1 başarılı · 1 bilgi')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows the newest important event and its read state', () => {
    renderDigest(history([
      item('old', { important: true, tone: 'warning', occurredAt: NOW - 10 * MINUTE, read: true, title: 'Eski önemli' }),
      item('new', { important: true, tone: 'warning', occurredAt: NOW - MINUTE, title: 'Yeni önemli' }),
    ]));
    expect(screen.getByText('Yeni önemli')).toBeInTheDocument();
    expect(screen.getByText('Henüz okunmadı')).toBeInTheDocument();
    expect(screen.queryByText('Eski önemli')).not.toBeInTheDocument();
  });

  it('shows a calm latest-important fallback', () => {
    renderDigest(history([
      item('ordinary', { read: true }),
    ]));
    expect(screen.getByText('Bekleyen önemli olay yok')).toBeInTheDocument();
    expect(screen.getByText('Çalışma alanı normal akışta.')).toBeInTheDocument();
  });

  it('shows the recent count as non-interactive status', () => {
    renderDigest(history([
      item('fresh', { occurredAt: NOW - MINUTE }),
      item('older', { occurredAt: NOW - 2 * 60 * MINUTE }),
    ]));
    expect(screen.getByLabelText('1 yeni bildirim')).toHaveTextContent('Son 15 dk: 1');
  });

  it('shows a recommended important-filter action', () => {
    const { onSelectFilter } = renderDigest(history([
      item('important', { important: true, tone: 'warning' }),
      item('ordinary'),
    ]), 'all');
    const action = screen.getByRole('button', { name: 'Önemlileri göster' });
    fireEvent.click(action);
    expect(onSelectFilter).toHaveBeenCalledWith('important');
  });

  it('shows a recommended unread-filter action when no important event exists', () => {
    const { onSelectFilter } = renderDigest(history([
      item('unread'),
    ]), 'all');
    const action = screen.getByRole('button', { name: 'Okunmamışları göster' });
    fireEvent.click(action);
    expect(onSelectFilter).toHaveBeenCalledWith('unread');
  });

  it('hides the recommendation when the selected filter already matches', () => {
    renderDigest(history([
      item('unread'),
    ], 'unread'), 'unread');
    expect(screen.queryByText('Okunmamış bildirimleri hızlıca gözden geçirebilirsiniz.')).not.toBeInTheDocument();
  });

  it('keeps live announcement ownership in the parent feedback center', () => {
    renderDigest(history([
      item('important', { important: true, tone: 'warning' }),
    ]));
    expect(document.querySelector('[aria-live]')).toBeNull();
  });

  it('uses unique labelled-by identifiers across multiple digest instances', () => {
    const state = history([item('one')]);
    render(
      <>
        <ExperienceFeedbackDigest history={state} selectedFilter="all" onSelectFilter={vi.fn()} now={NOW} />
        <ExperienceFeedbackDigest history={state} selectedFilter="all" onSelectFilter={vi.fn()} now={NOW} />
      </>,
    );
    const digests = screen.getAllByRole('complementary');
    expect(digests).toHaveLength(2);
    expect(digests[0]?.getAttribute('aria-labelledby')).not.toBe(digests[1]?.getAttribute('aria-labelledby'));
    expect(digests[0]?.getAttribute('aria-describedby')).not.toBe(digests[1]?.getAttribute('aria-describedby'));
  });

  it('keeps empty metrics non-actionable for keyboard users', () => {
    const { onSelectFilter } = renderDigest(history([]));
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    for (const button of buttons) fireEvent.click(button);
    expect(onSelectFilter).not.toHaveBeenCalled();
  });

  it('updates digest semantics when history changes', () => {
    const onSelectFilter = vi.fn();
    const { rerender } = render(
      <ExperienceFeedbackDigest
        history={history([])}
        selectedFilter="all"
        onSelectFilter={onSelectFilter}
        now={NOW}
      />,
    );
    expect(screen.getByText('Çalışma alanı sakin')).toBeInTheDocument();
    rerender(
      <ExperienceFeedbackDigest
        history={history([item('danger', { important: true, tone: 'danger' })])}
        selectedFilter="all"
        onSelectFilter={onSelectFilter}
        now={NOW}
      />,
    );
    expect(screen.getByText('Kritik bildirimleri inceleyin')).toBeInTheDocument();
  });
});
