import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMapInteractionExperienceModel } from '../../experience/mapInteractionExperienceModel';
import { ExperienceMapInteractionGuide } from './ExperienceMapInteractionGuide';

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: vi.fn(),
    record: vi.fn(),
  },
}));

const mountMap = (id = 'esri-map-container'): HTMLElement => {
  const map = document.createElement('div');
  map.id = id;
  map.tabIndex = -1;
  const control = document.createElement('button');
  control.textContent = 'Harita kontrolü';
  map.appendChild(control);
  document.body.appendChild(map);
  return map;
};

describe('ExperienceMapInteractionGuide', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  test('renders a named note with concise keyboard instructions', () => {
    mountMap();
    render(<ExperienceMapInteractionGuide />);

    const guide = screen.getByRole('note', { name: 'Harita klavye kullanım rehberi' });
    expect(guide).toHaveAttribute('id', 'experience-map-interaction-guide');
    expect(guide).toHaveAttribute('data-visible', 'false');
    expect(guide).toHaveTextContent('Tab ile harita kontrollerine geçin');
    expect(guide).toHaveTextContent('yön tuşlarıyla gezinme yapın');
  });

  test('adds the guide id to the map accessible description and restores it on unmount', () => {
    const map = mountMap();
    map.setAttribute('aria-describedby', 'existing-description');

    const { unmount } = render(<ExperienceMapInteractionGuide />);
    expect(map).toHaveAttribute(
      'aria-describedby',
      'existing-description experience-map-interaction-guide',
    );

    unmount();
    expect(map).toHaveAttribute('aria-describedby', 'existing-description');
  });

  test('removes only its own description token when no prior description existed', () => {
    const map = mountMap();
    const { unmount } = render(<ExperienceMapInteractionGuide />);
    expect(map).toHaveAttribute('aria-describedby', 'experience-map-interaction-guide');

    unmount();
    expect(map).not.toHaveAttribute('aria-describedby');
  });

  test('shows keyboard guidance when a map child receives keyboard focus', () => {
    const map = mountMap();
    const control = map.querySelector('button') as HTMLButtonElement;
    render(<ExperienceMapInteractionGuide />);

    fireEvent.keyDown(control, { key: 'Tab' });
    fireEvent.focusIn(control);

    const guide = screen.getByRole('note', { name: 'Harita klavye kullanım rehberi' });
    expect(guide).toHaveAttribute('data-input-modality', 'keyboard');
    expect(guide).toHaveAttribute('data-map-focused', 'true');
    expect(guide).toHaveAttribute('data-visible', 'true');
    expect(guide).toHaveTextContent('Tab tuşlarıyla harita kontrolleri arasında ilerleyebilirsiniz.');
  });

  test('hides visual keyboard guidance after pointer input', () => {
    const map = mountMap();
    const control = map.querySelector('button') as HTMLButtonElement;
    render(<ExperienceMapInteractionGuide />);

    fireEvent.keyDown(control, { key: 'ArrowRight' });
    fireEvent.focusIn(control);
    expect(screen.getByRole('note', { name: 'Harita klavye kullanım rehberi' })).toHaveAttribute(
      'data-visible',
      'true',
    );

    fireEvent.pointerDown(document.body);
    const guide = screen.getByRole('note', { name: 'Harita klavye kullanım rehberi' });
    expect(guide).toHaveAttribute('data-input-modality', 'pointer');
    expect(guide).toHaveAttribute('data-visible', 'false');
  });

  test('clears map focus state when focus moves outside the map shell', () => {
    const map = mountMap();
    const control = map.querySelector('button') as HTMLButtonElement;
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    render(<ExperienceMapInteractionGuide />);

    fireEvent.keyDown(control, { key: 'Tab' });
    fireEvent.focusIn(control);
    fireEvent.focusOut(control, { relatedTarget: outside });

    const guide = screen.getByRole('note', { name: 'Harita klavye kullanım rehberi' });
    expect(guide).toHaveAttribute('data-map-focused', 'false');
    expect(guide).toHaveAttribute('data-visible', 'false');
  });

  test('ignores character typing inside text-entry controls', () => {
    mountMap();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const model = createMapInteractionExperienceModel();
    render(<ExperienceMapInteractionGuide model={model} />);

    fireEvent.keyDown(input, { key: 'A' });
    expect(model.snapshot()).toMatchObject({
      modality: 'unknown',
      interactionCount: 0,
      lastIntent: null,
    });
  });

  test('uses a caller supplied map target id', () => {
    const map = mountMap('custom-map');
    render(<ExperienceMapInteractionGuide mapTargetId="custom-map" />);

    expect(map).toHaveAttribute('aria-describedby', 'experience-map-interaction-guide');
  });

  test('gracefully renders when the map target is not mounted', () => {
    expect(() => render(<ExperienceMapInteractionGuide />)).not.toThrow();
    expect(screen.getByRole('note', { name: 'Harita klavye kullanım rehberi' })).toBeInTheDocument();
  });

  test('reflects external model transitions without owning input events', () => {
    mountMap();
    const model = createMapInteractionExperienceModel();
    render(<ExperienceMapInteractionGuide model={model} />);

    model.recordKeyboard('ArrowUp');
    model.setMapFocused(true);

    const guide = screen.getByRole('note', { name: 'Harita klavye kullanım rehberi' });
    expect(guide).toHaveAttribute('data-visible', 'true');
    expect(guide).toHaveTextContent('Haritada yön tuşlarıyla gezinme etkin.');
  });
});
