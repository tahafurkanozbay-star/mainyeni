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

  it('announces queued and transitioning states through the live region', () => {
    const { model } = renderControl();
    let request = model.request('3d', 'control');
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
