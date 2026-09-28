import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindFastAccessResultList,
  installFastAccessResultAccessibilityBridge,
} from './FastAccessResultAccessibilityBridge';

const createRow = (
  title: string,
  address = 'Çankaya',
  options: { readonly id?: string; readonly tabIndex?: number } = {},
): HTMLLIElement => {
  const row = document.createElement('li');
  row.className = 'result-item-container kr-fast-query__item';
  if (options.id) row.id = options.id;
  if (options.tabIndex !== undefined) row.tabIndex = options.tabIndex;

  const copy = document.createElement('div');
  copy.className = 'result-item-info kr-fast-query__copy';

  const heading = document.createElement('h3');
  heading.className = 'result-item-info-title';
  heading.textContent = title;

  const paragraph = document.createElement('p');
  paragraph.className = 'result-item-info-address';
  paragraph.textContent = address;

  const actions = document.createElement('div');
  actions.className = 'kr-fast-query__actions';

  const mapButton = document.createElement('button');
  mapButton.type = 'button';
  mapButton.textContent = 'Haritada göster';

  const routeButton = document.createElement('button');
  routeButton.type = 'button';
  routeButton.textContent = 'Yol tarifi';

  actions.append(mapButton, routeButton);
  copy.append(heading, paragraph);
  row.append(copy, actions);
  return row;
};

const createList = (...rows: HTMLLIElement[]): HTMLUListElement => {
  const list = document.createElement('ul');
  list.className = 'results-container kr-fast-query__results';
  list.setAttribute('aria-label', 'Park sonuçları');
  list.append(...rows);
  document.body.append(list);
  return list;
};

const flushDom = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const keyboard = (
  target: HTMLElement,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('bindFastAccessResultList', () => {
  it('adds roving focus and collection position facts to the production result rows', () => {
    const list = createList(
      createRow('Kuğulu Park'),
      createRow('Gençlik Parkı'),
      createRow('Botanik Parkı'),
    );

    const binding = bindFastAccessResultList(list);
    const rows = Array.from(list.children) as HTMLElement[];

    expect(list.dataset.experienceResultsA11y).toBe('true');
    expect(list.getAttribute('aria-keyshortcuts')).toContain('ArrowDown');
    expect(list.getAttribute('aria-describedby')).toContain('keyboard-status');
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    expect(rows.map((row) => row.getAttribute('aria-posinset'))).toEqual(['1', '2', '3']);
    expect(rows.every((row) => row.getAttribute('aria-setsize') === '3')).toBe(true);
    expect(rows[0]?.dataset.experienceRowActive).toBe('true');
    expect(document.getElementById(`${list.id}-keyboard-status`)?.textContent)
      .toContain('3 kayıt');

    binding.dispose();
  });

  it('moves active focus with ArrowDown and ArrowUp without selecting a row', () => {
    const first = createRow('Bir');
    const second = createRow('İki');
    const third = createRow('Üç');
    const list = createList(first, second, third);
    const binding = bindFastAccessResultList(list);

    first.focus();
    const down = keyboard(first, 'ArrowDown');

    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);
    expect(second.dataset.experienceRowActive).toBe('true');

    const up = keyboard(second, 'ArrowUp');
    expect(up.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(0);

    binding.dispose();
  });

  it('supports Ctrl+Home and Ctrl+End boundary navigation', () => {
    const rows = [
      createRow('Bir'),
      createRow('İki'),
      createRow('Üç'),
      createRow('Dört'),
    ];
    const list = createList(...rows);
    const binding = bindFastAccessResultList(list);

    rows[0]?.focus();
    keyboard(rows[0]!, 'End', { ctrlKey: true });
    expect(document.activeElement).toBe(rows[3]);
    expect(rows[3]?.dataset.experienceRowActive).toBe('true');

    keyboard(rows[3]!, 'Home', { ctrlKey: true });
    expect(document.activeElement).toBe(rows[0]);
    expect(rows[0]?.dataset.experienceRowActive).toBe('true');

    binding.dispose();
  });

  it('does not hijack keyboard events from nested map and route action buttons', () => {
    const first = createRow('Bir');
    const second = createRow('İki');
    const list = createList(first, second);
    const binding = bindFastAccessResultList(list);
    const button = first.querySelector<HTMLButtonElement>('button');

    expect(button).not.toBeNull();
    button!.focus();
    const event = keyboard(button!, 'ArrowDown');

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);

    binding.dispose();
  });

  it('activates a row on direct focus while leaving child focus semantics intact', () => {
    const first = createRow('Bir');
    const second = createRow('İki');
    const list = createList(first, second);
    const binding = bindFastAccessResultList(list);

    second.tabIndex = 0;
    second.focus();

    expect(second.dataset.experienceRowActive).toBe('true');
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);

    const nestedButton = first.querySelector<HTMLButtonElement>('button')!;
    nestedButton.focus();
    expect(document.activeElement).toBe(nestedButton);
    expect(second.dataset.experienceRowActive).toBe('true');

    binding.dispose();
  });

  it('activates pointer-targeted row copy but ignores nested interactive actions', () => {
    const first = createRow('Bir');
    const second = createRow('İki');
    const list = createList(first, second);
    const binding = bindFastAccessResultList(list);

    const secondCopy = second.querySelector<HTMLElement>('.kr-fast-query__copy')!;
    secondCopy.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(second.dataset.experienceRowActive).toBe('true');

    const firstButton = first.querySelector<HTMLButtonElement>('button')!;
    firstButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(second.dataset.experienceRowActive).toBe('true');

    binding.dispose();
  });

  it('resynchronizes direct rows after React-style append and removal mutations', async () => {
    const first = createRow('Bir');
    const second = createRow('İki');
    const list = createList(first, second);
    const binding = bindFastAccessResultList(list);

    const third = createRow('Üç');
    list.append(third);
    await flushDom();

    expect(third.getAttribute('aria-posinset')).toBe('3');
    expect(third.getAttribute('aria-setsize')).toBe('3');

    first.remove();
    await flushDom();

    expect(second.getAttribute('aria-posinset')).toBe('1');
    expect(second.getAttribute('aria-setsize')).toBe('2');
    expect(third.getAttribute('aria-posinset')).toBe('2');

    binding.dispose();
  });

  it('keeps stable bridge row identity when an existing DOM row is reordered', async () => {
    const first = createRow('Bir');
    const second = createRow('İki');
    const list = createList(first, second);
    const binding = bindFastAccessResultList(list);
    const firstKey = first.dataset.experienceRowKey;
    const secondKey = second.dataset.experienceRowKey;

    list.prepend(second);
    await flushDom();

    expect(first.dataset.experienceRowKey).toBe(firstKey);
    expect(second.dataset.experienceRowKey).toBe(secondKey);
    expect(second.getAttribute('aria-posinset')).toBe('1');
    expect(first.getAttribute('aria-posinset')).toBe('2');

    binding.dispose();
  });

  it('uses readable row copy for live model facts without altering visible copy', () => {
    const row = createRow('Anıtkabir', 'Mebusevleri');
    const list = createList(row);
    const binding = bindFastAccessResultList(list);

    expect(row.querySelector('.result-item-info-title')?.textContent).toBe('Anıtkabir');
    expect(row.querySelector('.result-item-info-address')?.textContent).toBe('Mebusevleri');
    expect(document.querySelector('.kr-fast-query__a11y-status')?.textContent)
      .toMatch(/1 kayıt|1 sonuç/);

    binding.dispose();
  });

  it('preserves pre-existing list description tokens when adding status guidance', () => {
    const list = createList(createRow('Bir'));
    list.setAttribute('aria-describedby', 'existing-help');
    list.setAttribute('aria-keyshortcuts', 'Escape');
    const binding = bindFastAccessResultList(list);

    expect(list.getAttribute('aria-describedby')).toContain('existing-help');
    expect(list.getAttribute('aria-describedby')).toContain('keyboard-status');
    expect(list.getAttribute('aria-keyshortcuts')).toContain('Escape');
    expect(list.getAttribute('aria-keyshortcuts')).toContain('ArrowDown');

    binding.dispose();
    expect(list.getAttribute('aria-describedby')).toBe('existing-help');
    expect(list.getAttribute('aria-keyshortcuts')).toBe('Escape');
  });

  it('restores row and list attributes exactly on disposal', () => {
    const row = createRow('Bir', 'Adres', { id: 'legacy-row', tabIndex: 7 });
    row.setAttribute('aria-posinset', '8');
    row.setAttribute('aria-setsize', '9');
    row.setAttribute('aria-keyshortcuts', 'Enter');
    row.setAttribute('data-experience-row-key', 'legacy-key');
    row.setAttribute('data-experience-row-active', 'legacy-active');

    const list = createList(row);
    list.id = 'legacy-list';
    list.setAttribute('role', 'group');
    list.setAttribute('data-experience-results-a11y', 'legacy');
    const binding = bindFastAccessResultList(list);

    expect(row.id).not.toBe('legacy-row');
    expect(row.tabIndex).toBe(0);

    binding.dispose();

    expect(list.id).toBe('legacy-list');
    expect(list.getAttribute('role')).toBe('group');
    expect(list.dataset.experienceResultsA11y).toBe('legacy');
    expect(row.id).toBe('legacy-row');
    expect(row.tabIndex).toBe(7);
    expect(row.getAttribute('aria-posinset')).toBe('8');
    expect(row.getAttribute('aria-setsize')).toBe('9');
    expect(row.getAttribute('aria-keyshortcuts')).toBe('Enter');
    expect(row.dataset.experienceRowKey).toBe('legacy-key');
    expect(row.dataset.experienceRowActive).toBe('legacy-active');
    expect(document.querySelector('.kr-fast-query__a11y-status')).toBeNull();
  });

  it('is idempotent when dispose is called repeatedly', () => {
    const list = createList(createRow('Bir'));
    const binding = bindFastAccessResultList(list);

    expect(() => binding.dispose()).not.toThrow();
    expect(() => binding.dispose()).not.toThrow();
    expect(document.querySelector('.kr-fast-query__a11y-status')).toBeNull();
  });

  it('reports focus failures without breaking keyboard state transitions', () => {
    const first = createRow('Bir');
    const second = createRow('İki');
    const list = createList(first, second);
    const errors: unknown[] = [];
    const originalFocus = second.focus;

    second.focus = () => {
      throw new Error('focus unavailable');
    };

    const binding = bindFastAccessResultList(list, {
      onError: (error) => errors.push(error),
    });

    first.focus();
    expect(() => keyboard(first, 'ArrowDown')).not.toThrow();
    expect(second.dataset.experienceRowActive).toBe('true');
    expect(errors).toHaveLength(1);

    second.focus = originalFocus;
    binding.dispose();
  });

  it('does not add selectable-row semantics because the production list has action controls instead', () => {
    const row = createRow('Bir');
    const list = createList(row);
    const binding = bindFastAccessResultList(list);

    expect(row.hasAttribute('aria-selected')).toBe(false);
    keyboard(row, ' ');
    expect(row.hasAttribute('aria-selected')).toBe(false);

    binding.dispose();
  });
});

describe('installFastAccessResultAccessibilityBridge', () => {
  it('binds result lists that already exist at installation time', () => {
    const list = createList(createRow('Bir'));
    const dispose = installFastAccessResultAccessibilityBridge(document);

    expect(list.dataset.experienceResultsA11y).toBe('true');
    expect(list.firstElementChild?.getAttribute('tabindex')).toBe('0');

    dispose();
    expect(list.dataset.experienceResultsA11y).toBeUndefined();
  });

  it('discovers a result list mounted after application bootstrap', async () => {
    const dispose = installFastAccessResultAccessibilityBridge(document);
    const list = createList(createRow('Bir'), createRow('İki'));

    await flushDom();

    expect(list.dataset.experienceResultsA11y).toBe('true');
    expect(list.children[0]?.getAttribute('tabindex')).toBe('0');
    expect(list.children[1]?.getAttribute('tabindex')).toBe('-1');

    dispose();
  });

  it('manages multiple query result surfaces independently', async () => {
    const first = createList(createRow('Park 1'), createRow('Park 2'));
    const second = createList(createRow('Tesis 1'), createRow('Tesis 2'));
    const dispose = installFastAccessResultAccessibilityBridge(document);

    await flushDom();

    const firstRows = Array.from(first.children) as HTMLElement[];
    const secondRows = Array.from(second.children) as HTMLElement[];
    keyboard(firstRows[0]!, 'ArrowDown');

    expect(firstRows[1]?.tabIndex).toBe(0);
    expect(secondRows[0]?.tabIndex).toBe(0);
    expect(first.id).not.toBe(second.id);

    dispose();
  });

  it('disposes a detached result surface without affecting another live surface', async () => {
    const first = createList(createRow('Park'));
    const second = createList(createRow('Tesis'));
    const dispose = installFastAccessResultAccessibilityBridge(document);

    await flushDom();
    first.remove();
    await flushDom();

    expect(first.dataset.experienceResultsA11y).toBeUndefined();
    expect(second.dataset.experienceResultsA11y).toBe('true');

    dispose();
  });

  it('does not bind unrelated lists', () => {
    const unrelated = document.createElement('ul');
    unrelated.className = 'ordinary-list';
    unrelated.append(createRow('Bir'));
    document.body.append(unrelated);

    const dispose = installFastAccessResultAccessibilityBridge(document);

    expect(unrelated.dataset.experienceResultsA11y).toBeUndefined();
    expect(document.querySelector('.kr-fast-query__a11y-status')).toBeNull();

    dispose();
  });

  it('stops observing future surfaces after global disposal', async () => {
    const dispose = installFastAccessResultAccessibilityBridge(document);
    dispose();

    const list = createList(createRow('Bir'));
    await flushDom();

    expect(list.dataset.experienceResultsA11y).toBeUndefined();
  });

  it('isolates binding failures and keeps discovering later surfaces', async () => {
    const onError = vi.fn();
    const dispose = installFastAccessResultAccessibilityBridge(document, { onError });

    const malformed = document.createElement('div');
    malformed.className = 'kr-fast-query__results';
    document.body.append(malformed);
    await flushDom();

    const valid = createList(createRow('Bir'));
    await flushDom();

    expect(valid.dataset.experienceResultsA11y).toBe('true');
    expect(onError).not.toHaveBeenCalled();

    dispose();
  });

  it('does not duplicate live status nodes during unrelated subtree mutations', async () => {
    const list = createList(createRow('Bir'));
    const dispose = installFastAccessResultAccessibilityBridge(document);
    const unrelated = document.createElement('div');

    document.body.append(unrelated);
    unrelated.append(document.createElement('span'));
    await flushDom();

    expect(document.querySelectorAll('.kr-fast-query__a11y-status')).toHaveLength(1);
    expect(list.dataset.experienceResultsA11y).toBe('true');

    dispose();
  });
});