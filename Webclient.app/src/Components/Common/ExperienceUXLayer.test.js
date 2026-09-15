import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ExperienceUXLayer } from './ExperienceUXLayer';

describe('ExperienceUXLayer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-experience-theme');
  });

  test('renders accessible quick actions', () => {
    render(<ExperienceUXLayer />);
    expect(screen.getByRole('complementary', { name: /kent rehberi yardımcı araçları/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /aramayı aç/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /katmanlar panelini aç/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /lejandı aç/i })).toBeInTheDocument();
  });

  test('toggles and persists theme', () => {
    render(<ExperienceUXLayer />);
    const button = screen.getByRole('button', { name: /koyu temaya geç|açık temaya geç/i });
    const before = document.documentElement.dataset.experienceTheme;
    fireEvent.click(button);
    expect(document.documentElement.dataset.experienceTheme).not.toBe(before);
    expect(window.localStorage.getItem('kent-rehberi-experience-theme')).toBe(document.documentElement.dataset.experienceTheme);
  });

  test('opens and closes keyboard help with escape', () => {
    render(<ExperienceUXLayer />);
    fireEvent.click(screen.getByRole('button', { name: /klavye kısayollarını aç/i }));
    expect(screen.getByRole('dialog', { name: /hızlı kullanım/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /hızlı kullanım/i })).not.toBeInTheDocument();
  });

  test('emits a search command event', () => {
    const handler = jest.fn();
    window.addEventListener('kentrehberi:command', handler);
    render(<ExperienceUXLayer />);
    fireEvent.click(screen.getByRole('button', { name: /aramayı aç/i }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail.name).toBe('search');
    window.removeEventListener('kentrehberi:command', handler);
  });
});
