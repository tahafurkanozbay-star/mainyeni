import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExperienceMenu } from './ExperienceMenu';

const items = [
  { id: 'identify', label: 'Bilgi Al' },
  { id: 'nearby', label: 'Yakınımda Ara' },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ExperienceMenu pending autofocus ownership', () => {
  it('does not steal focus when a user moves elsewhere before the microtask', () => {
    const opener = document.createElement('button');
    const outside = document.createElement('button');
    document.body.append(opener, outside);
    const view = render(
      <ExperienceMenu label="Harita işlemleri" items={items} visible={false} autoFocusWhenVisible />,
    );
    const pending: VoidFunction[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      pending.push(callback);
    });
    try {
      opener.focus();
      view.rerender(
        <ExperienceMenu label="Harita işlemleri" items={items} visible autoFocusWhenVisible />,
      );
      expect(pending.length).toBeGreaterThan(0);
      outside.focus();
      act(() => { pending.splice(0).forEach((callback) => callback()); });
      expect(document.activeElement).toBe(outside);
    } finally {
      spy.mockRestore();
      view.unmount();
    }
  });

  it('still moves focus to the first available menu action when ownership is retained', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const view = render(
      <ExperienceMenu label="Harita işlemleri" items={items} visible={false} autoFocusWhenVisible />,
    );
    const pending: VoidFunction[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      pending.push(callback);
    });
    try {
      opener.focus();
      view.rerender(
        <ExperienceMenu label="Harita işlemleri" items={items} visible autoFocusWhenVisible />,
      );
      act(() => { pending.splice(0).forEach((callback) => callback()); });
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bilgi Al' }));
    } finally {
      spy.mockRestore();
      view.unmount();
    }
  });

  it('does not focus a menu after its pending request was dismissed', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const view = render(
      <ExperienceMenu label="Harita işlemleri" items={items} visible={false} autoFocusWhenVisible />,
    );
    const pending: VoidFunction[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      pending.push(callback);
    });
    try {
      opener.focus();
      view.rerender(
        <ExperienceMenu label="Harita işlemleri" items={items} visible autoFocusWhenVisible />,
      );
      view.rerender(
        <ExperienceMenu label="Harita işlemleri" items={items} visible={false} autoFocusWhenVisible />,
      );
      act(() => { pending.splice(0).forEach((callback) => callback()); });
      expect(document.activeElement).toBe(opener);
    } finally {
      spy.mockRestore();
      view.unmount();
    }
  });
});
