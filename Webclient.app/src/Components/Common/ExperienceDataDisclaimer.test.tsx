import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ExperienceDataDisclaimer } from './ExperienceDataDisclaimer';

describe('ExperienceDataDisclaimer', () => {
  test('renders a named note landmark with the canonical warning', () => {
    render(<ExperienceDataDisclaimer />);

    const note = screen.getByRole('note', { name: 'Veri kullanım uyarısı' });
    expect(note).toBeInTheDocument();
    expect(note).toHaveAttribute('data-compact', 'false');
    expect(note).toHaveTextContent('Sitede gösterilen veriler bilgi amaçlıdır.');
    expect(note).toHaveTextContent('Resmî işlemlerde kullanılamaz.');
  });

  test('marks the decorative information glyph as hidden from assistive technology', () => {
    const { container } = render(<ExperienceDataDisclaimer />);
    const icon = container.querySelector('.experience-data-disclaimer__icon');

    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveTextContent('i');
  });

  test('exposes compact presentation state without changing semantics', () => {
    render(<ExperienceDataDisclaimer compact />);

    const note = screen.getByRole('note', { name: 'Veri kullanım uyarısı' });
    expect(note).toHaveAttribute('data-compact', 'true');
    expect(note).toHaveTextContent('Resmî işlemlerde kullanılamaz.');
  });

  test('keeps the legal restriction visually emphasized in semantic strong text', () => {
    const { container } = render(<ExperienceDataDisclaimer />);
    const strong = container.querySelector('.experience-data-disclaimer__copy strong');

    expect(strong?.tagName).toBe('STRONG');
    expect(strong).toHaveTextContent('Resmî işlemlerde kullanılamaz.');
  });
});
