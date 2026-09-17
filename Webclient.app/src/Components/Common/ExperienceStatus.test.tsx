import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExperienceProgress, ExperienceStatus } from './ExperienceStatus';

describe('ExperienceStatus', () => {
  it('exposes assertive live errors without duplicating presentation semantics', () => {
    render(<ExperienceStatus tone="danger" live="assertive">Bağlantı kurulamadı.</ExperienceStatus>);
    const status = screen.getByText('Bağlantı kurulamadı.').closest('output');
    expect(status).toHaveAttribute('aria-live', 'assertive');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveAttribute('data-tone', 'danger');
  });

  it('marks asynchronous work busy only while requested', () => {
    const { rerender } = render(<ExperienceStatus busy>Sonuçlar yükleniyor.</ExperienceStatus>);
    expect(screen.getByText('Sonuçlar yükleniyor.').closest('output')).toHaveAttribute('aria-busy', 'true');
    rerender(<ExperienceStatus>Sonuçlar hazır.</ExperienceStatus>);
    expect(screen.getByText('Sonuçlar hazır.').closest('output')).not.toHaveAttribute('aria-busy');
  });
});

describe('ExperienceProgress', () => {
  it('bounds determinate values to the configured maximum', () => {
    render(<ExperienceProgress label="Sorgu ilerlemesi" value={140} max={100} detail="Tamamlanıyor" />);
    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveValue(100);
    expect(progress).toHaveAttribute('max', '100');
    expect(screen.getByText('Sorgu ilerlemesi')).toBeInTheDocument();
    expect(screen.getByText('Tamamlanıyor')).toBeInTheDocument();
  });

  it('normalizes invalid maxima instead of emitting an invalid progress contract', () => {
    render(<ExperienceProgress label="Veri hazırlanıyor" value={25} max={0} />);
    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('max', '100');
    expect(progress).toHaveValue(25);
    expect(screen.getByText('Veri hazırlanıyor')).toBeInTheDocument();
  });

  it('uses an accessible indeterminate progressbar when value is omitted', () => {
    render(<ExperienceProgress label="Katmanlar hazırlanıyor" />);
    const progress = screen.getByRole('progressbar', { name: 'Katmanlar hazırlanıyor' });
    expect(progress).toHaveAttribute('aria-valuetext', 'İşlem sürüyor');
    expect(progress).not.toHaveAttribute('aria-valuenow');
  });
});
