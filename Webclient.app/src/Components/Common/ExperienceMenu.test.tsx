import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExperienceMenu } from './ExperienceMenu';

describe('ExperienceMenu', () => {
  it('renders menu semantics and one roving tab stop', () => {
    render(
      <ExperienceMenu
        id="test-menu"
        label="Harita işlemleri"
        items={[
          { id: 'identify', label: 'Bilgi Al' },
          { id: 'nearby', label: 'Yakınımda Ara' },
          { id: 'route', label: 'Yol Tarifi Al' },
        ]}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'Harita işlemleri' });
    expect(menu.id).toBe('test-menu');
    expect(menu.getAttribute('aria-orientation')).toBe('vertical');
    const items = screen.getAllByRole('menuitem') as HTMLButtonElement[];
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it('moves focus with vertical arrows and wraps by default', () => {
    render(
      <ExperienceMenu
        label="Menü"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
          { id: 'three', label: 'Üç' },
        ]}
      />,
    );
    const menu = screen.getByRole('menu');
    const first = screen.getByRole('menuitem', { name: 'Bir' });
    const second = screen.getByRole('menuitem', { name: 'İki' });
    const third = screen.getByRole('menuitem', { name: 'Üç' });
    first.focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('skips disabled and hidden items during focus movement', () => {
    render(
      <ExperienceMenu
        label="Menü"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'disabled', label: 'Devre dışı', disabled: true },
          { id: 'hidden', label: 'Gizli', hidden: true },
          { id: 'four', label: 'Dört' },
        ]}
      />,
    );
    const first = screen.getByRole('menuitem', { name: 'Bir' });
    const fourth = screen.getByRole('menuitem', { name: 'Dört' });
    first.focus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(fourth);
    expect(screen.queryByRole('menuitem', { name: 'Gizli' })).toBeNull();
    expect((screen.getByRole('menuitem', { name: 'Devre dışı' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not expose hidden menus in the tab order', () => {
    render(
      <ExperienceMenu
        label="Menü"
        visible={false}
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
        ]}
      />,
    );
    const menu = screen.getByRole('menu', { hidden: true });
    expect(menu.getAttribute('aria-hidden')).toBe('true');
    expect(menu.getAttribute('data-visible')).toBe('false');
    const items = screen.getAllByRole('menuitem', { hidden: true }) as HTMLButtonElement[];
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
  });

  it('autofocuses the first enabled item when requested', async () => {
    render(
      <ExperienceMenu
        label="Menü"
        autoFocusWhenVisible
        focusRequestKey={1}
        items={[
          { id: 'disabled', label: 'Devre dışı', disabled: true },
          { id: 'first-enabled', label: 'İlk etkin' },
          { id: 'last', label: 'Son' },
        ]}
      />,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'İlk etkin' }));
    });
  });

  it('re-focuses on a repeated open request key', async () => {
    const { rerender } = render(
      <ExperienceMenu
        label="Menü"
        autoFocusWhenVisible
        focusRequestKey={1}
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
        ]}
      />,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bir' })));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    rerender(
      <ExperienceMenu
        label="Menü"
        autoFocusWhenVisible
        focusRequestKey={2}
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
        ]}
      />,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bir' })));
    outside.remove();
  });

  it('reports Escape dismissal and prevents default', () => {
    const onDismiss = vi.fn();
    render(
      <ExperienceMenu
        label="Menü"
        onDismiss={onDismiss}
        items={[{ id: 'one', label: 'Bir' }]}
      />,
    );
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    screen.getByRole('menu').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onDismiss).toHaveBeenCalledWith('escape');
  });

  it('reports Tab dismissal without trapping focus', () => {
    const onDismiss = vi.fn();
    render(
      <ExperienceMenu
        label="Menü"
        onDismiss={onDismiss}
        items={[{ id: 'one', label: 'Bir' }]}
      />,
    );
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    screen.getByRole('menu').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onDismiss).toHaveBeenCalledWith('tab');
  });

  it('activates menu items with native button semantics', () => {
    const onActivate = vi.fn();
    render(
      <ExperienceMenu
        label="Menü"
        items={[{ id: 'one', label: 'Bir', onActivate }]}
      />,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bir' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('connects optional descriptions to their menu items', () => {
    render(
      <ExperienceMenu
        id="described-menu"
        label="Menü"
        items={[
          { id: 'identify', label: 'Bilgi Al', description: 'Noktadaki harita detaylarını açar.' },
        ]}
      />,
    );
    const item = screen.getByRole('menuitem', { name: 'Bilgi Al' });
    const describedBy = item.getAttribute('aria-describedby');
    expect(describedBy).toBe('described-menu-identify-description');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Noktadaki harita detaylarını açar.');
  });

  it('supports non-looping menus', () => {
    render(
      <ExperienceMenu
        label="Menü"
        loop={false}
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
        ]}
      />,
    );
    const menu = screen.getByRole('menu');
    const last = screen.getByRole('menuitem', { name: 'İki' });
    last.focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
  });
});
