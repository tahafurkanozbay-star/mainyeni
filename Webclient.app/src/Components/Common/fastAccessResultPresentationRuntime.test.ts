import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindFastAccessResultPresentation } from './fastAccessResultPresentationRuntime';

const createSurface = () => {
  const host = document.createElement('section');
  host.className = 'kr-fast-query';
  host.setAttribute('aria-busy', 'false');

  const header = document.createElement('header');
  header.className = 'kr-fast-query__header';
  const heading = document.createElement('h2');
  heading.textContent = 'Parklar';
  header.append(heading);

  const filter = document.createElement('div');
  filter.className = 'kr-fast-query__filter';
  const input = document.createElement('input');
  input.type = 'search';
  filter.append(input);

  const status = document.createElement('div');
  status.className = 'kr-fast-query__status';

  const live = document.createElement('p');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  const list = document.createElement('ul');
  list.className = 'kr-fast-query__results';
  list.setAttribute('aria-label', 'Park sonuçları');

  host.append(header, filter, status, live, list);
  document.body.append(host);
  return { host, input, status, live, list };
};

const flushDom = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('bindFastAccessResultPresentation', () => {
  it('writes deterministic ready-state facts to the production result list', () => {
    const { list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);

    binding.update({ totalRows: 5, visibleRows: 5, activeIndex: 0 });

    expect(list.getAttribute('aria-busy')).toBe('false');
    expect(list.dataset.experienceResultStatus).toBe('ready');
    expect(list.dataset.experienceResultCount).toBe('5');
    expect(list.dataset.experienceActivePosition).toBe('1');
    expect(live.textContent).toBe('5 sonuç gösteriliyor.');
    binding.dispose();
  });

  it('derives collection label from the existing aria-label without replacing it', () => {
    const { list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 1, visibleRows: 1, activeIndex: 0 });

    expect(binding.snapshot().collectionLabel).toBe('Park sonuçları');
    expect(list.getAttribute('aria-label')).toBe('Park sonuçları');
    binding.dispose();
  });

  it('falls back to the production heading when the list has no explicit label', () => {
    const { list, live } = createSurface();
    list.removeAttribute('aria-label');
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 1, visibleRows: 1, activeIndex: 0 });

    expect(binding.snapshot().collectionLabel).toBe('Parklar sonuçları');
    binding.dispose();
  });

  it('reflects loading state from the existing host aria-busy contract', async () => {
    const { host, list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    host.setAttribute('aria-busy', 'true');
    await flushDom();

    expect(binding.snapshot().status).toBe('loading');
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(live.textContent).toContain('yükleniyor');
    binding.dispose();
  });

  it('reflects existing error copy assertively without inventing a new error channel', async () => {
    const { status, list, live } = createSurface();
    const error = document.createElement('div');
    error.className = 'kr-fast-query__error';
    const text = document.createElement('span');
    text.textContent = 'Sunucu yanıt vermedi';
    error.append(text);
    status.append(error);

    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 3, visibleRows: 3, activeIndex: null });
    await flushDom();

    expect(binding.snapshot().status).toBe('error');
    expect(live.getAttribute('aria-live')).toBe('assertive');
    expect(live.textContent).toBe('Sunucu yanıt vermedi');
    binding.dispose();
  });

  it('tracks filter input changes from the real result surface', async () => {
    const { input, list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 4, visibleRows: 4, activeIndex: null });

    input.value = 'çankaya';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushDom();

    expect(binding.snapshot().filterText).toBe('çankaya');
    expect(live.textContent).toContain('“çankaya” filtresi etkin.');
    binding.dispose();
  });

  it('exposes has-more state when the production load-more action exists', async () => {
    const { host, list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 60, visibleRows: 60, activeIndex: null });

    const more = document.createElement('button');
    more.className = 'kr-fast-query__more';
    more.type = 'button';
    more.textContent = 'Daha fazla sonuç göster';
    host.append(more);
    await flushDom();

    expect(binding.snapshot().hasMore).toBe(true);
    binding.dispose();
  });

  it('announces active-position changes without replacing the collection label', () => {
    const { list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 10, visibleRows: 10, activeIndex: 0 });
    binding.update({ totalRows: 10, visibleRows: 10, activeIndex: 4 });

    expect(live.textContent).toBe('Sonuç 5 / 10');
    expect(live.getAttribute('aria-atomic')).toBe('false');
    expect(list.getAttribute('aria-label')).toBe('Park sonuçları');
    binding.dispose();
  });

  it('announces page expansion when visible count increases', () => {
    const { list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 100, visibleRows: 60, activeIndex: 0 });
    binding.update({ totalRows: 100, visibleRows: 100, activeIndex: 0 });

    expect(live.textContent).toBe('100 sonuç gösteriliyor.');
    binding.dispose();
  });

  it('removes active-position data when there is no active row', () => {
    const { list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 3, visibleRows: 3, activeIndex: 1 });
    expect(list.dataset.experienceActivePosition).toBe('2');

    binding.update({ totalRows: 3, visibleRows: 3, activeIndex: null });
    expect(list.dataset.experienceActivePosition).toBeUndefined();
    binding.dispose();
  });

  it('restores presentation-owned attributes exactly on disposal', () => {
    const { list, live } = createSurface();
    list.setAttribute('aria-busy', 'mixed');
    list.setAttribute('data-experience-result-status', 'legacy');
    list.setAttribute('data-experience-result-count', '77');
    list.setAttribute('data-experience-active-position', '9');

    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 2, visibleRows: 2, activeIndex: 0 });
    binding.dispose();

    expect(list.getAttribute('aria-busy')).toBe('mixed');
    expect(list.dataset.experienceResultStatus).toBe('legacy');
    expect(list.dataset.experienceResultCount).toBe('77');
    expect(list.dataset.experienceActivePosition).toBe('9');
  });

  it('is idempotent when disposal repeats', () => {
    const { list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    expect(() => binding.dispose()).not.toThrow();
    expect(() => binding.dispose()).not.toThrow();
  });

  it('does not update after disposal', async () => {
    const { host, list, live } = createSurface();
    const binding = bindFastAccessResultPresentation(list, live);
    binding.update({ totalRows: 2, visibleRows: 2, activeIndex: 0 });
    binding.dispose();

    host.setAttribute('aria-busy', 'true');
    await flushDom();
    expect(binding.snapshot().status).toBe('ready');
  });

  it('reports setup failures without throwing through the production surface', () => {
    const { list, live } = createSurface();
    const errors: unknown[] = [];
    const original = MutationObserver.prototype.observe;
    MutationObserver.prototype.observe = () => {
      throw new Error('observer unavailable');
    };

    try {
      expect(() => bindFastAccessResultPresentation(list, live, {
        onError: (error) => errors.push(error),
      })).not.toThrow();
      expect(errors).toHaveLength(1);
    } finally {
      MutationObserver.prototype.observe = original;
    }
  });

  it('contains reporter failures and keeps binding creation safe', () => {
    const { list, live } = createSurface();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = MutationObserver.prototype.observe;
    MutationObserver.prototype.observe = () => {
      throw new Error('observer unavailable');
    };

    try {
      expect(() => bindFastAccessResultPresentation(list, live, {
        onError: () => {
          throw new Error('reporter unavailable');
        },
      })).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      MutationObserver.prototype.observe = original;
      warn.mockRestore();
    }
  });
});
