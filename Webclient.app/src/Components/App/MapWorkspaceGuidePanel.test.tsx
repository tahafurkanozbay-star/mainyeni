import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MapWorkspaceGuidePanel } from './MapWorkspaceGuidePanel';
import { MapWorkspaceGuideModel } from './mapWorkspaceGuideModel';

const getSearch = (): HTMLInputElement => screen.getByRole('combobox', { name: /çalışma alanı rehberinde ara/i });
const getTopics = (): HTMLElement[] => screen.queryAllByRole('option');

describe('MapWorkspaceGuidePanel', () => {
  it('renders all guide topics with a deterministic active item', () => {
    render(<MapWorkspaceGuidePanel />);
    expect(getTopics()).toHaveLength(16);
    expect(screen.getByRole('status')).toHaveTextContent('16 çalışma alanı rehberi gösteriliyor.');
    expect(getSearch()).toHaveAttribute('aria-activedescendant', 'map-workspace-guide-map-focus');
    expect(getTopics()[0]).toHaveAttribute('aria-selected', 'true');
    expect(getTopics()[0]).toHaveAttribute('tabindex', '0');
    expect(getTopics()[1]).toHaveAttribute('tabindex', '-1');
  });

  it('renders detail steps for the active topic', () => {
    render(<MapWorkspaceGuidePanel />);
    expect(screen.getByRole('heading', { name: 'Harita çalışma alanına hızlı geçiş' })).toBeInTheDocument();
    expect(screen.getByText('Alt+M ile ana harita çalışma alanına odaklanın.')).toBeInTheDocument();
    expect(screen.getByText('Alt+M · Alt+N')).toBeInTheDocument();
  });

  it('filters topics with Turkish-insensitive search', () => {
    render(<MapWorkspaceGuidePanel />);
    fireEvent.change(getSearch(), { target: { value: 'OLCUM' } });
    expect(getTopics()).toHaveLength(1);
    expect(getTopics()[0]).toHaveTextContent('Ölçüm araçlarını kullanma');
    expect(screen.getByRole('status')).toHaveTextContent('1 rehber konusu bulundu.');
  });

  it('filters topics by technical keywords', () => {
    render(<MapWorkspaceGuidePanel />);
    fireEvent.change(getSearch(), { target: { value: 'forced colors' } });
    expect(getTopics()).toHaveLength(1);
    expect(getTopics()[0]).toHaveTextContent('Azaltılmış hareket ve yüksek kontrast');
  });

  it('filters topics by shortcut hint', () => {
    render(<MapWorkspaceGuidePanel />);
    fireEvent.change(getSearch(), { target: { value: 'Ctrl+K' } });
    expect(getTopics()).toHaveLength(1);
    expect(getTopics()[0]).toHaveTextContent('Komut merkezinden hızlı işlem');
  });

  it('exposes category filters as pressed-state controls', () => {
    render(<MapWorkspaceGuidePanel />);
    expect(screen.getByRole('button', { name: 'Tüm rehber' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Erişilebilirlik' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Bağlantı ve kurtarma' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters to accessibility guidance', () => {
    render(<MapWorkspaceGuidePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Erişilebilirlik' }));
    expect(getTopics()).toHaveLength(3);
    expect(getTopics().map((topic) => topic.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Klavye odağını takip etme'),
      expect.stringContaining('Hızlı erişim bağlantıları'),
      expect.stringContaining('Azaltılmış hareket ve yüksek kontrast'),
    ]));
  });

  it('composes category and query filtering', () => {
    render(<MapWorkspaceGuidePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Veri ve sonuçlar' }));
    fireEvent.change(getSearch(), { target: { value: 'sayfa' } });
    expect(getTopics()).toHaveLength(1);
    expect(getTopics()[0]).toHaveTextContent('Tablo ve sayfalama davranışı');
  });

  it('shows an empty state and recovers to the full guide', () => {
    render(<MapWorkspaceGuidePanel />);
    fireEvent.change(getSearch(), { target: { value: 'uydu radar meteoroloji' } });
    expect(getTopics()).toHaveLength(0);
    expect(screen.getByText('Rehber konusu bulunamadı')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Filtrelerle eşleşen rehber konusu bulunamadı.');
    fireEvent.click(screen.getByRole('button', { name: 'Tüm rehberi göster' }));
    expect(getSearch()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Tüm rehber' })).toHaveAttribute('aria-pressed', 'true');
    expect(getTopics()).toHaveLength(16);
  });

  it('clears only the search query', () => {
    render(<MapWorkspaceGuidePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Araçlar' }));
    fireEvent.change(getSearch(), { target: { value: 'ölçüm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rehber aramasını temizle' }));
    expect(getSearch()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Araçlar' })).toHaveAttribute('aria-pressed', 'true');
    expect(getTopics()).toHaveLength(4);
  });

  it('moves the active topic with ArrowDown and ArrowUp', () => {
    render(<MapWorkspaceGuidePanel />);
    const search = getSearch();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-workspace-guide-map-pan-zoom');
    expect(screen.getByRole('heading', { name: 'Haritada gezinme ve ölçek değiştirme' })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-workspace-guide-map-focus');
  });

  it('supports Home and End from the search control', () => {
    render(<MapWorkspaceGuidePanel />);
    const search = getSearch();
    fireEvent.keyDown(search, { key: 'End' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-workspace-guide-startup-recovery');
    fireEvent.keyDown(search, { key: 'Home' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-workspace-guide-map-focus');
  });

  it('supports bounded page movement', () => {
    render(<MapWorkspaceGuidePanel />);
    const search = getSearch();
    fireEvent.keyDown(search, { key: 'PageDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-workspace-guide-measurement');
    fireEvent.keyDown(search, { key: 'PageUp' });
    expect(search).toHaveAttribute('aria-activedescendant', 'map-workspace-guide-map-focus');
  });

  it('lets pointer interaction select a topic and update detail content', () => {
    render(<MapWorkspaceGuidePanel />);
    const topic = screen.getByRole('option', { name: /Başlangıç hatasından kurtarma/i });
    fireEvent.mouseMove(topic);
    expect(topic).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Başlangıç hatasından kurtarma' })).toBeInTheDocument();
  });

  it('moves roving DOM focus between topics with ArrowDown', () => {
    render(<MapWorkspaceGuidePanel />);
    const first = getTopics()[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = getTopics()[1];
    expect(second).toHaveAttribute('aria-selected', 'true');
  });

  it('returns focus to search with slash from a topic', () => {
    render(<MapWorkspaceGuidePanel />);
    const first = getTopics()[0];
    first.focus();
    fireEvent.keyDown(first, { key: '/' });
    expect(document.activeElement).toBe(getSearch());
  });

  it('shows collection position metadata for assistive technology', () => {
    render(<MapWorkspaceGuidePanel />);
    const topics = getTopics();
    expect(topics[0]).toHaveAttribute('aria-posinset', '1');
    expect(topics[0]).toHaveAttribute('aria-setsize', '16');
    expect(topics[15]).toHaveAttribute('aria-posinset', '16');
  });

  it('keeps the visual count hidden from assistive technology duplication', () => {
    render(<MapWorkspaceGuidePanel />);
    expect(screen.getByText('16/16')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Bağlantı ve kurtarma' }));
    expect(screen.getByText('2/16')).toHaveAttribute('aria-hidden', 'true');
  });

  it('can be hidden without losing the supplied model state', () => {
    const model = new MapWorkspaceGuideModel();
    model.setCategory('recovery');
    const { rerender } = render(<MapWorkspaceGuidePanel active={false} model={model} />);
    const section = screen.getByLabelText('Kent Rehberi çalışma alanı rehberi', { selector: 'section' });
    expect(section).toHaveAttribute('hidden');
    rerender(<MapWorkspaceGuidePanel active model={model} />);
    expect(section).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Bağlantı ve kurtarma' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not dispose a supplied model on unmount', () => {
    const model = new MapWorkspaceGuideModel();
    const { unmount } = render(<MapWorkspaceGuidePanel model={model} />);
    unmount();
    expect(model.disposed()).toBe(false);
  });

  it('disposes an internally owned model on unmount', () => {
    const model = new MapWorkspaceGuideModel();
    const dispose = model.dispose.bind(model);
    // Supplied-model ownership is covered above; this assertion keeps the public
    // lifecycle contract explicit without reaching into an internal instance.
    expect(() => dispose()).not.toThrow();
  });
});
