import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExperienceToolbar } from './ExperienceToolbar';

describe('ExperienceToolbar', () => {
  it('assigns the initial tab stop to the first enabled item', () => {
    render(
      <ExperienceToolbar label="Harita araçları">
        <button type="button" disabled>Pasif</button>
        <button type="button">Katmanlar</button>
        <button type="button">Lejand</button>
      </ExperienceToolbar>,
    );
    expect(screen.getByRole('button', { name: 'Pasif' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'Katmanlar' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Lejand' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus with arrows and wraps enabled items', () => {
    render(
      <ExperienceToolbar label="Harita araçları">
        <button type="button">Arama</button>
        <button type="button" disabled>Pasif</button>
        <button type="button">Katmanlar</button>
      </ExperienceToolbar>,
    );
    const first = screen.getByRole('button', { name: 'Arama' });
    const last = screen.getByRole('button', { name: 'Katmanlar' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'ArrowRight' });
    expect(first).toHaveFocus();
  });

  it('supports Home and End for deterministic navigation', () => {
    render(
      <ExperienceToolbar label="Kamera araçları">
        <button type="button">Geri</button>
        <button type="button">Başlangıç</button>
        <button type="button">Kuzey</button>
      </ExperienceToolbar>,
    );
    const first = screen.getByRole('button', { name: 'Geri' });
    const middle = screen.getByRole('button', { name: 'Başlangıç' });
    const last = screen.getByRole('button', { name: 'Kuzey' });
    middle.focus();
    fireEvent.keyDown(middle, { key: 'End' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();
  });

  it('uses vertical arrow keys when orientation is vertical', () => {
    render(
      <ExperienceToolbar label="Dikey araçlar" orientation="vertical">
        <button type="button">Bir</button>
        <button type="button">İki</button>
      </ExperienceToolbar>,
    );
    const first = screen.getByRole('button', { name: 'Bir' });
    const second = screen.getByRole('button', { name: 'İki' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(second).toHaveFocus();
  });
});
