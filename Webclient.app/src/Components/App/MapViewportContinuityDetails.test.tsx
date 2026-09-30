import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createViewState } from '../../gis-engine/viewState';
import { MapViewportContinuityDetails } from './MapViewportContinuityDetails';
import { createMapViewportContinuityModel } from './mapViewportContinuityModel';

const source = createViewState({
  mode: '2d',
  center: [32.85, 39.93],
  scale: 25000,
  basemapId: 'osm',
  selectedLayerId: 'parks',
  selectedObjectId: 42,
});

const preservedTarget = createViewState({
  ...source,
  mode: '3d',
  scale: 30000,
  tilt: 48,
});

describe('MapViewportContinuityDetails', () => {
  it('renders nothing before continuity is assessed', () => {
    const model = createMapViewportContinuityModel();
    const { container } = render(<MapViewportContinuityDetails model={model} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden for preserved continuity', () => {
    const model = createMapViewportContinuityModel();
    model.assess(1, source, preservedTarget, '3d');
    const { container } = render(<MapViewportContinuityDetails model={model} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a semantic details disclosure for degraded continuity', () => {
    const model = createMapViewportContinuityModel();
    model.assess(2, source, { ...preservedTarget, center: null }, '3d');
    render(<MapViewportContinuityDetails model={model} />);
    const summary = screen.getByText('Görünüm geçişini kontrol et');
    expect(summary.closest('summary')).not.toBeNull();
    expect(summary.closest('details')).toHaveAttribute('data-status', 'degraded');
  });

  it('shows a stable warning count and score', () => {
    const model = createMapViewportContinuityModel();
    model.assess(3, source, { ...preservedTarget, center: null, basemapId: 'other' }, '3d');
    render(<MapViewportContinuityDetails model={model} />);
    expect(screen.getByText('2 önemli fark algılandı')).toBeInTheDocument();
    expect(screen.getByLabelText(/Süreklilik puanı/)).toHaveTextContent('/100');
  });

  it('lists human-readable finding labels', () => {
    const model = createMapViewportContinuityModel();
    model.assess(4, source, {
      ...preservedTarget,
      center: null,
      basemapId: 'other',
      selectedLayerId: 'roads',
      selectedObjectId: 99,
    }, '3d');
    render(<MapViewportContinuityDetails model={model} />);
    expect(screen.getByText('Harita merkezi')).toBeInTheDocument();
    expect(screen.getByText('Altlık harita')).toBeInTheDocument();
    expect(screen.getByText('Seçili katman')).toBeInTheDocument();
    expect(screen.getByText('Seçili nesne')).toBeInTheDocument();
  });

  it('exposes the findings list with an accessible label', () => {
    const model = createMapViewportContinuityModel();
    model.assess(5, source, { ...preservedTarget, center: null }, '3d');
    render(<MapViewportContinuityDetails model={model} />);
    expect(screen.getByRole('list', { name: 'Görünüm sürekliliği bulguları' })).toBeInTheDocument();
  });

  it('shows informational counts when warnings and info coexist', () => {
    const model = createMapViewportContinuityModel();
    model.assess(6, source, {
      ...preservedTarget,
      center: null,
      time: '2026-10-01T00:00:00.000Z',
    }, '3d');
    render(<MapViewportContinuityDetails model={model} />);
    expect(screen.getByText('1 uyarı')).toBeInTheDocument();
    expect(screen.getByText('1 bilgi')).toBeInTheDocument();
  });

  it('includes request identity without exposing raw runtime errors', () => {
    const model = createMapViewportContinuityModel();
    model.assess(77, source, { ...preservedTarget, center: null }, '3d');
    render(<MapViewportContinuityDetails model={model} />);
    expect(screen.getByText('İstek #77')).toBeInTheDocument();
  });

  it('reacts to a later degraded assessment after initially rendering empty', () => {
    const model = createMapViewportContinuityModel();
    render(<MapViewportContinuityDetails model={model} />);
    expect(screen.queryByText('Görünüm geçişini kontrol et')).not.toBeInTheDocument();
    act(() => {
      model.assess(8, source, { ...preservedTarget, basemapId: 'changed' }, '3d');
    });
    expect(screen.getByText('Görünüm geçişini kontrol et')).toBeInTheDocument();
  });
});
