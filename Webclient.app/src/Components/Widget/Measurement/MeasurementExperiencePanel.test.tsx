import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MEASUREMENT_TOOLS } from '../../../gis-engine/measurementRuntime';
import { MeasurementExperiencePanel } from './MeasurementExperiencePanel';
import type { MeasurementExperienceSnapshot } from './measurementExperienceModel';

const snapshot = (
  overrides: Partial<MeasurementExperienceSnapshot> = {},
): MeasurementExperienceSnapshot => ({
  revision: 1,
  phase: 'ready',
  visible: true,
  viewReady: true,
  busy: false,
  activeTool: MEASUREMENT_TOOLS.NONE,
  requestedTool: MEASUREMENT_TOOLS.NONE,
  canClear: false,
  canRetry: false,
  retryCount: 0,
  maxRetries: 3,
  errorMessage: null,
  errorCode: null,
  announcement: 'Ölçüm araçları hazır.',
  guidance: 'Alan veya mesafe aracını seçin.',
  modality: 'unknown',
  activity: [],
  ...overrides,
});

describe('MeasurementExperiencePanel', () => {
  it('renders a polite ready status and guidance', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot()} onRetry={vi.fn()} />);

    expect(screen.getByText('Ölçüm araçları hazır.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ölçüm rehberi' })).toBeInTheDocument();
    expect(screen.getByText('Alan veya mesafe aracını seçin.')).toBeInTheDocument();
    expect(screen.getByText('Hazır')).toBeInTheDocument();
  });

  it('renders explicit map readiness and unknown modality facts', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot()} onRetry={vi.fn()} />);

    const facts = screen.getByRole('group', { name: 'Ölçüm oturumu durumu' });
    expect(facts).toHaveTextContent('Harita');
    expect(facts).toHaveTextContent('Hazır');
    expect(facts).toHaveTextContent('Girdi');
    expect(facts).toHaveTextContent('Belirlenmedi');
  });

  it('announces keyboard modality without changing measurement semantics', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({ modality: 'keyboard' })} onRetry={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Ölçüm oturumu durumu' })).toHaveTextContent('Klavye');
  });

  it('announces pointer modality', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({ modality: 'pointer' })} onRetry={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Ölçüm oturumu durumu' })).toHaveTextContent('İşaretçi');
  });

  it('renders waiting-map recovery guidance without a retry button', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'waiting-map',
      viewReady: false,
      announcement: 'Harita görünümünün hazır olması bekleniyor.',
      guidance: 'Harita görünümü hazırlanıyor.',
    })} onRetry={vi.fn()} />);

    expect(screen.getByText('Harita bekleniyor')).toBeInTheDocument();
    expect(screen.getByText(/otomatik olarak yeniden kullanılabilir/)).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: /Yeniden dene/ })).not.toBeInTheDocument();
  });

  it('renders the active measurement phase label', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      activeTool: MEASUREMENT_TOOLS.AREA,
      canClear: true,
      announcement: 'Alan ölçümü etkin.',
    })} onRetry={vi.fn()} />);

    expect(screen.getByText('Ölçüm etkin')).toBeInTheDocument();
    expect(screen.getByText('Alan ölçümü etkin.')).toBeInTheDocument();
  });

  it('renders loading state without recovery controls', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'loading',
      busy: true,
      announcement: 'Ölçüm aracı hazırlanıyor.',
    })} onRetry={vi.fn()} />);

    expect(screen.getByText('Hazırlanıyor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Yeniden dene/ })).not.toBeInTheDocument();
  });

  it('renders assertive recovery content for retryable errors', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'error',
      canRetry: true,
      errorMessage: 'ArcGIS modülü yüklenemedi.',
      errorCode: 'SDK_LOAD_FAILED',
      announcement: 'Ölçüm aracı hazırlanamadı. ArcGIS modülü yüklenemedi.',
    })} onRetry={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Ölçüm aracı kullanılamıyor');
    expect(screen.getByRole('alert')).toHaveTextContent('ArcGIS modülü yüklenemedi.');
    expect(screen.getByText('SDK_LOAD_FAILED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yeniden dene' })).toBeInTheDocument();
  });

  it('invokes the retry action from the recovery surface', () => {
    const onRetry = vi.fn();
    render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'error',
      canRetry: true,
      errorMessage: 'failed',
      announcement: 'failed',
    })} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows retry progress after a previous attempt', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'error',
      canRetry: true,
      retryCount: 1,
      maxRetries: 3,
      errorMessage: 'failed',
      announcement: 'failed',
    })} onRetry={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Yeniden dene (1/3)' })).toBeInTheDocument();
  });

  it('explains exhausted retry state without rendering an unavailable button', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'error',
      canRetry: false,
      retryCount: 3,
      maxRetries: 3,
      errorMessage: 'failed',
      announcement: 'failed',
    })} onRetry={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Yeniden dene/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Yeniden deneme sınırına ulaşıldı/)).toBeInTheDocument();
  });

  it('does not expose an empty diagnostic code', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'error',
      canRetry: true,
      errorMessage: 'failed',
      errorCode: null,
      announcement: 'failed',
    })} onRetry={vi.fn()} />);

    expect(screen.queryByText('Tanı kodu')).not.toBeInTheDocument();
  });

  it('hides activity disclosure when the session has no activity', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({ activity: [] })} onRetry={vi.fn()} />);
    expect(screen.queryByText('Oturum hareketleri')).not.toBeInTheDocument();
  });

  it('renders recent activity in reverse chronological order', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      activity: [
        { id: 1, kind: 'opened', tool: MEASUREMENT_TOOLS.NONE, label: 'Açıldı' },
        { id: 2, kind: 'tool', tool: MEASUREMENT_TOOLS.AREA, label: 'Alan etkin' },
        { id: 3, kind: 'clear', tool: MEASUREMENT_TOOLS.NONE, label: 'Temizlendi' },
      ],
    })} onRetry={vi.fn()} />);

    const list = screen.getByRole('list', { name: 'Son ölçüm oturumu hareketleri' });
    const items = Array.from(list.querySelectorAll('li')).map((item) => item.textContent);
    expect(items).toEqual(['○Temizlendi', '◆Alan etkin', '↗Açıldı']);
  });

  it('shows only the latest five activity records', () => {
    const activity = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      kind: 'tool' as const,
      tool: MEASUREMENT_TOOLS.AREA,
      label: `Hareket ${index + 1}`,
    }));
    render(<MeasurementExperiencePanel snapshot={snapshot({ activity })} onRetry={vi.fn()} />);

    const list = screen.getByRole('list', { name: 'Son ölçüm oturumu hareketleri' });
    expect(list.querySelectorAll('li')).toHaveLength(5);
    expect(list).toHaveTextContent('Hareket 8');
    expect(list).toHaveTextContent('Hareket 4');
    expect(list).not.toHaveTextContent('Hareket 3');
    expect(screen.getByText('8')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    ['opened', '↗'],
    ['tool', '◆'],
    ['clear', '○'],
    ['retry', '↻'],
    ['error', '!'],
    ['closed', '×'],
  ] as const)('uses a decorative activity glyph for %s entries', (kind, glyph) => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      activity: [{ id: 1, kind, tool: MEASUREMENT_TOOLS.NONE, label: 'Hareket' }],
    })} onRetry={vi.fn()} />);

    expect(screen.getByText(glyph)).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps activity disclosure keyboard-native through details and summary', () => {
    render(<MeasurementExperiencePanel snapshot={snapshot({
      activity: [{ id: 1, kind: 'opened', tool: MEASUREMENT_TOOLS.NONE, label: 'Açıldı' }],
    })} onRetry={vi.fn()} />);

    const summary = screen.getByText('Oturum hareketleri').closest('summary');
    expect(summary).not.toBeNull();
    const details = summary?.closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(summary!);
    expect(details).toHaveAttribute('open');
  });

  it('provides stable data hooks for phase and input modality styling', () => {
    const { container } = render(<MeasurementExperiencePanel snapshot={snapshot({
      phase: 'error',
      modality: 'keyboard',
      canRetry: false,
      errorMessage: 'failed',
      announcement: 'failed',
    })} onRetry={vi.fn()} />);

    const root = container.querySelector('.measurement-experience');
    expect(root).toHaveAttribute('data-phase', 'error');
    expect(root).toHaveAttribute('data-input-modality', 'keyboard');
  });
});
