import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapModeTransitionControl } from './MapModeTransitionControl';
import { createMapModeTransitionModel } from './mapModeTransitionModel';

const renderControl = () => {
  const model = createMapModeTransitionModel();
  const onRequest = vi.fn((mode: '2d' | '3d', source: 'control' | 'recovery') => {
    model.request(mode, source);
  });
  render(<MapModeTransitionControl model={model} onRequest={onRequest} />);
  return { model, onRequest };
};

describe('MapModeTransitionControl', () => {
  it('renders a labelled 2B/3B control with 2B active initially', () => {
    renderControl();
    expect(screen.getByRole('region', { name: 'Harita görünüm modu' })).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: '2B harita görünümüne geç' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '3B sahne görünümüne geç' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('requests 3B from the visible segment', () => {
    const { onRequest } = renderControl();
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    expect(onRequest).toHaveBeenCalledWith('3d', 'control');
    expect(screen.getByRole('region', { name: 'Harita görünüm modu' })).toHaveAttribute('aria-busy', 'true');
  });

  it('does not duplicate a click for the already pending mode', () => {
    const { onRequest } = renderControl();
    const button = screen.getByRole('button', { name: '3B sahne görünümüne geç' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('does not restart an already settled 2B view from a redundant key or click', () => {
    const { onRequest } = renderControl();
    const map = screen.getByRole('button', { name: '2B harita görünümüne geç' });
    map.focus();
    fireEvent.click(map);
    fireEvent.keyDown(map, { key: 'Home' });
    expect(onRequest).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(map);
  });

  it('keeps the opposite segment available as a latest-intent override', () => {
    const { onRequest } = renderControl();
    fireEvent.click(screen.getByRole('button', { name: '3B sahne görünümüne geç' }));
    fireEvent.click(screen.getByRole('button', { name: '2B harita görünümüne geç' }));
    expect(onRequest).toHaveBeenLastCalledWith('2d', 'control');
  });

  it('maps ArrowRight and End to 3B intent', () => {
    const { onRequest } = renderControl();
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onRequest).toHaveBeenLastCalledWith('3d', 'control');
  });

  it('maps ArrowLeft and Home to 2B intent', () => {
    const { model, onRequest } = renderControl();
    act(() => model.acknowledge('3d'));
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    fireEvent.keyDown(group, { key: 'Home' });
    expect(onRequest).toHaveBeenLastCalledWith('2d', 'control');
  });

  it('leaves unrelated keys untouched', () => {
    const { onRequest } = renderControl();
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    fireEvent.keyDown(group, { key: 'Tab' });
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('keeps one tab stop and moves focus with horizontal arrow keys', () => {
    const { onRequest } = renderControl();
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    const map = screen.getByRole('button', { name: '2B harita görünümüne geç' });
    const scene = screen.getByRole('button', { name: '3B sahne görünümüne geç' });
    expect(map.tabIndex).toBe(0);
    expect(scene.tabIndex).toBe(-1);
    map.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(scene);
    expect(scene.tabIndex).toBe(0);
    expect(onRequest).toHaveBeenCalledWith('3d', 'control');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(document.activeElement).toBe(map);
  });

  it('returns the keyboard tab stop to the active view after leaving the group', () => {
    const { model } = renderControl();
    const map = screen.getByRole('button', { name: '2B harita görünümüne geç' });
    const scene = screen.getByRole('button', { name: '3B sahne görünümüne geç' });
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      scene.focus();
      expect(scene.tabIndex).toBe(0);
      expect(map.tabIndex).toBe(-1);
      outside.focus();
      expect(map.tabIndex).toBe(0);
      expect(scene.tabIndex).toBe(-1);

      act(() => model.acknowledge('3d', 'runtime'));
      expect(scene.tabIndex).toBe(0);
      expect(map.tabIndex).toBe(-1);
      map.focus();
      expect(map.tabIndex).toBe(0);
      outside.focus();
      expect(scene.tabIndex).toBe(0);
    } finally {
      outside.remove();
    }
  });

  it('retains the focused tab stop when moving between mode segments', () => {
    renderControl();
    const map = screen.getByRole('button', { name: '2B harita görünümüne geç' });
    const scene = screen.getByRole('button', { name: '3B sahne görünümüne geç' });
    map.focus();
    scene.focus();
    expect(scene).toHaveFocus();
    expect(scene.tabIndex).toBe(0);
    expect(map.tabIndex).toBe(-1);
  });

  it('does not hijack composing or previously handled map-mode key events', () => {
    const { onRequest } = renderControl();
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    const map = screen.getByRole('button', { name: '2B harita görünümüne geç' });
    map.focus();
    const composing = new KeyboardEvent('keydown', {
      key: 'ArrowRight', isComposing: true, bubbles: true, cancelable: true,
    });
    group.dispatchEvent(composing);
    const handled = new KeyboardEvent('keydown', {
      key: 'ArrowRight', bubbles: true, cancelable: true,
    });
    handled.preventDefault();
    group.dispatchEvent(handled);
    expect(composing.defaultPrevented).toBe(false);
    expect(map).toHaveFocus();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('does not capture modified shortcuts or Tab navigation', () => {
    const { onRequest } = renderControl();
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    const map = screen.getByRole('button', { name: '2B harita görünümüne geç' });
    map.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(group, { key: 'Tab' });
    expect(document.activeElement).toBe(map);
    expect(onRequest).not.toHaveBeenCalled();
  });


  it('describes the roving keyboard controls for assistive technology', () => {
    renderControl();
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    const ids = group.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[1]!)).toHaveTextContent('Sol veya yukarı okla 2B haritaya');
    expect(group).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End');
  });

  it('does not consume Shift+Arrow modified keyboard gestures', () => {
    const { onRequest } = renderControl();
    const group = screen.getByRole('group', { name: '2B ve 3B görünüm seçimi' });
    const map = screen.getByRole('button', { name: '2B harita görünümüne geç' });
    map.focus();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true });
    act(() => group.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(map).toHaveFocus();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('announces queued and transitioning states through the live region', () => {
    const { model } = renderControl();
    let request: ReturnType<typeof model.request> = null;
    act(() => {
      request = model.request('3d', 'control');
    });
    expect(request).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('sıraya alındı');
    act(() => { model.begin(request!); });
    expect(screen.getByRole('status')).toHaveTextContent('hazırlanıyor');
  });

  it('marks the requested segment as pending while busy', () => {
    const { model } = renderControl();
    act(() => { model.request('3d'); });
    expect(screen.getByRole('button', { name: '3B sahne görünümüne geç' })).toHaveAttribute('data-pending', 'true');
  });

  it('updates active pressed state after completion', () => {
    const { model } = renderControl();
    const request = model.request('3d')!;
    act(() => {
      model.begin(request);
      model.complete(request);
    });
    expect(screen.getByRole('button', { name: '3B sahne görünümüne geç' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '2B harita görünümüne geç' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows bounded recovery UI after a failed transition', () => {
    const { model } = renderControl();
    const request = model.request('3d')!;
    act(() => {
      model.begin(request);
      model.fail(request, new TypeError('secret'), '2d');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('3B geçişi tamamlanamadı');
    expect(screen.getByRole('button', { name: '3B geçişini yeniden dene' })).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('retries the failed desired mode with recovery source', () => {
    const { model, onRequest } = renderControl();
    const request = model.request('3d')!;
    act(() => {
      model.begin(request);
      model.fail(request, new Error('failed'), '2d');
    });
    fireEvent.click(screen.getByRole('button', { name: '3B geçişini yeniden dene' }));
    expect(onRequest).toHaveBeenLastCalledWith('3d', 'recovery');
  });

  it('does not show recovery UI during ordinary ready state', () => {
    renderControl();
    expect(screen.queryByText(/yeniden dene/i)).not.toBeInTheDocument();
  });

  it('exposes presentation facts for CSS and regression checks', () => {
    const model = createMapModeTransitionModel({ reducedMotion: true, forcedColors: true, coarsePointer: true });
    render(<MapModeTransitionControl model={model} onRequest={vi.fn()} />);
    const region = screen.getByRole('region', { name: 'Harita görünüm modu' });
    expect(region).toHaveAttribute('data-reduced-motion', 'true');
    expect(region).toHaveAttribute('data-forced-colors', 'true');
    expect(region).toHaveAttribute('data-coarse-pointer', 'true');
  });

  it('allows custom class composition without replacing the base class', () => {
    const model = createMapModeTransitionModel();
    render(<MapModeTransitionControl model={model} onRequest={vi.fn()} className="custom-mode-control" />);
    expect(screen.getByRole('region', { name: 'Harita görünüm modu' })).toHaveClass('map-mode-transition-control', 'custom-mode-control');
  });
});
