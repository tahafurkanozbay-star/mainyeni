import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ExperienceSkipNavigation } from './ExperienceSkipNavigation';

const appendTarget = (id: string, options: { focusable?: boolean } = {}): HTMLElement => {
  const target = document.createElement(options.focusable ? 'button' : 'div');
  target.id = id;
  if (options.focusable) target.textContent = id;
  Object.defineProperty(target, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  document.body.appendChild(target);
  return target;
};

describe('ExperienceSkipNavigation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('renders the canonical map, navigation and tool shortcuts', () => {
    render(<ExperienceSkipNavigation />);

    const navigation = screen.getByRole('navigation', { name: 'Hızlı erişim' });
    expect(navigation).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Harita çalışma alanına geç' })).toHaveAttribute(
      'href',
      '#esri-map-container',
    );
    expect(screen.getByRole('link', { name: 'Katman ve gezinme menüsüne geç' })).toHaveAttribute(
      'href',
      '#sidebar',
    );
    expect(screen.getByRole('link', { name: 'Harita araçlarına geç' })).toHaveAttribute(
      'href',
      '#toolbar-widget',
    );
  });

  test('focuses an existing naturally focusable target', () => {
    const target = appendTarget('sidebar', { focusable: true });
    render(<ExperienceSkipNavigation />);

    fireEvent.click(screen.getByRole('link', { name: 'Katman ve gezinme menüsüne geç' }));

    expect(document.activeElement).toBe(target);
    expect(target).not.toHaveAttribute('data-exp-skip-temporary-tabindex');
    expect(target.scrollIntoView).toHaveBeenCalled();
  });

  test('temporarily makes a non-focusable landmark programmatically focusable', () => {
    const target = appendTarget('toolbar-widget');
    render(<ExperienceSkipNavigation />);

    fireEvent.click(screen.getByRole('link', { name: 'Harita araçlarına geç' }));

    expect(document.activeElement).toBe(target);
    expect(target).toHaveAttribute('tabindex', '-1');
    expect(target).toHaveAttribute('data-exp-skip-temporary-tabindex', 'true');

    fireEvent.blur(target);
    expect(target).not.toHaveAttribute('tabindex');
    expect(target).not.toHaveAttribute('data-exp-skip-temporary-tabindex');
  });

  test('preserves an existing negative tabindex owned by the target', () => {
    const target = appendTarget('esri-map-container');
    target.setAttribute('tabindex', '-1');
    render(<ExperienceSkipNavigation />);

    fireEvent.click(screen.getByRole('link', { name: 'Harita çalışma alanına geç' }));

    expect(document.activeElement).toBe(target);
    expect(target).toHaveAttribute('tabindex', '-1');
    expect(target).not.toHaveAttribute('data-exp-skip-temporary-tabindex');
  });

  test('does not throw when a target is not mounted yet', () => {
    render(<ExperienceSkipNavigation />);
    const link = screen.getByRole('link', { name: 'Harita araçlarına geç' });

    expect(() => fireEvent.click(link)).not.toThrow();
  });

  test('deduplicates caller supplied target identifiers', () => {
    render(
      <ExperienceSkipNavigation
        targets={[
          { id: 'one', label: 'Birinci hedef' },
          { id: 'one', label: 'Tekrarlanan hedef' },
          { id: 'two', label: 'İkinci hedef' },
        ]}
      />,
    );

    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Birinci hedef' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tekrarlanan hedef' })).not.toBeInTheDocument();
  });

  test('drops empty target definitions instead of rendering broken anchors', () => {
    render(
      <ExperienceSkipNavigation
        targets={[
          { id: '', label: 'Eksik kimlik' },
          { id: 'valid', label: 'Geçerli hedef' },
          { id: 'blank-label', label: '   ' },
        ]}
      />,
    );

    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Geçerli hedef' })).toHaveAttribute('href', '#valid');
  });

  test('returns no navigation landmark when no valid target remains', () => {
    render(<ExperienceSkipNavigation targets={[{ id: '', label: '' }]} />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  test('keeps href semantics even when click handling manages focus', () => {
    const target = appendTarget('custom-target');
    render(
      <ExperienceSkipNavigation targets={[{ id: 'custom-target', label: 'Özel hedefe geç' }]} />,
    );

    const link = screen.getByRole('link', { name: 'Özel hedefe geç' });
    expect(link).toHaveAttribute('href', '#custom-target');
    fireEvent.click(link);
    expect(document.activeElement).toBe(target);
  });
});
