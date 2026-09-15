import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ExperienceUXLayer } from './ExperienceUXLayer';
import { ExperienceThemeProvider } from './ExperienceDesignSystem';

const renderLayer = () => render(
  <ExperienceThemeProvider>
    <ExperienceUXLayer />
  </ExperienceThemeProvider>
);

describe('ExperienceUXLayer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-experience-theme');
  });

  test('renders accessible quick actions', () => {
    renderLayer();
    expect(screen.getByRole('complementary', { name: /kent rehberi yardımcı araçları/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /genel aramayı aç/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /katman yönetimini aç/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /lejandı aç/i })).toBeInTheDocument();
  });

  test('toggles and persists theme', () => {
    renderLayer();
    const button = screen.getByRole('button', { name: /koyu temaya geç|açık temaya geç/i });
    const before = document.documentElement.dataset.experienceTheme;
    fireEvent.click(button);
    expect(document.documentElement.dataset.experienceTheme).not.toBe(before);
    expect(window.localStorage.getItem('kent-rehberi-experience-theme')).toBe(document.documentElement.dataset.experienceTheme);
  });

  test('opens and closes keyboard help with escape', () => {
    renderLayer();
    fireEvent.click(screen.getByRole('button', { name: /kısayolları ve yardım bilgisini aç/i }));
    expect(screen.getByRole('dialog', { name: /hızlı kullanım/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /hızlı kullanım/i })).not.toBeInTheDocument();
  });

  test('emits a search command event', () => {
    const handler = jest.fn();
    window.addEventListener('kentrehberi:command', handler);
    renderLayer();
    fireEvent.click(screen.getByRole('button', { name: /genel aramayı aç/i }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail.name).toBe('search');
    window.removeEventListener('kentrehberi:command', handler);
  });

  test('opens help with keyboard shortcut', () => {
    renderLayer();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog', { name: /hızlı kullanım/i })).toBeInTheDocument();
  });
});
