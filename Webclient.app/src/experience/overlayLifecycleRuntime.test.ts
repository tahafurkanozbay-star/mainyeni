import {
  acquireOverlayLease,
  getOverlayLifecycleSnapshot,
} from './overlayLifecycleRuntime';

describe('overlayLifecycleRuntime', () => {
  afterEach(() => {
    delete document.documentElement.dataset.experienceOverlayCount;
    delete document.documentElement.dataset.experienceModalOpen;
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    document.body.replaceChildren();
  });

  test('publishes deterministic overlay and modal counts', () => {
    const first = acquireOverlayLease({
      document,
      id: 'help',
    });
    const second = acquireOverlayLease({
      document,
      id: 'command-center',
      modal: true,
    });

    expect(first.getSnapshot()).toEqual({
      overlayCount: 2,
      modalCount: 2,
      scrollLockCount: 2,
      activeIds: ['help', 'command-center'],
    });
    expect(document.documentElement).toHaveAttribute(
      'data-experience-overlay-count',
      '2',
    );
    expect(document.documentElement).toHaveAttribute(
      'data-experience-modal-open',
      'true',
    );

    second.release();
    first.release();
  });

  test('locks scrolling while at least one scroll-locking overlay exists', () => {
    document.body.style.overflow = 'auto';
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overscrollBehavior = 'auto';

    const first = acquireOverlayLease({
      document,
      id: 'one',
    });
    const second = acquireOverlayLease({
      document,
      id: 'two',
    });

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.overscrollBehavior).toBe('contain');
    expect(document.documentElement.style.overscrollBehavior).toBe('contain');

    first.release();
    expect(document.body.style.overflow).toBe('hidden');

    second.release();
    expect(document.body.style.overflow).toBe('auto');
    expect(document.body.style.overscrollBehavior).toBe('none');
    expect(document.documentElement.style.overscrollBehavior).toBe('auto');
  });

  test('non-locking overlays do not modify scroll styles', () => {
    document.body.style.overflow = 'scroll';

    const lease = acquireOverlayLease({
      document,
      id: 'popover',
      modal: false,
      lockScroll: false,
    });

    expect(document.body.style.overflow).toBe('scroll');
    expect(lease.getSnapshot()).toEqual({
      overlayCount: 1,
      modalCount: 0,
      scrollLockCount: 0,
      activeIds: ['popover'],
    });
    expect(document.documentElement).not.toHaveAttribute(
      'data-experience-modal-open',
    );

    lease.release();
  });

  test('mixed overlays keep the lock only for locking leases', () => {
    const popover = acquireOverlayLease({
      document,
      id: 'popover',
      modal: false,
      lockScroll: false,
    });
    const modal = acquireOverlayLease({
      document,
      id: 'modal',
      modal: true,
      lockScroll: true,
    });

    expect(document.body.style.overflow).toBe('hidden');
    expect(modal.getSnapshot().scrollLockCount).toBe(1);

    modal.release();
    expect(document.body.style.overflow).toBe('');
    expect(popover.getSnapshot()).toEqual({
      overlayCount: 1,
      modalCount: 0,
      scrollLockCount: 0,
      activeIds: ['popover'],
    });

    popover.release();
  });

  test('marks an overlay root while it has a live lease', () => {
    const root = document.createElement('section');
    document.body.appendChild(root);

    const lease = acquireOverlayLease({
      document,
      id: 'dialog',
      root,
    });

    expect(root).toHaveAttribute('data-experience-overlay-active', 'true');
    lease.release();
    expect(root).not.toHaveAttribute('data-experience-overlay-active');
  });

  test('keeps root marker until the final lease for that root is released', () => {
    const root = document.createElement('section');
    document.body.appendChild(root);

    const first = acquireOverlayLease({
      document,
      id: 'first',
      root,
    });
    const second = acquireOverlayLease({
      document,
      id: 'second',
      root,
    });

    first.release();
    expect(root).toHaveAttribute('data-experience-overlay-active', 'true');

    second.release();
    expect(root).not.toHaveAttribute('data-experience-overlay-active');
  });

  test('does not fail when the root is detached before release', () => {
    const root = document.createElement('section');
    document.body.appendChild(root);

    const lease = acquireOverlayLease({
      document,
      id: 'detached',
      root,
    });
    root.remove();

    expect(() => lease.release()).not.toThrow();
    expect(getOverlayLifecycleSnapshot(document).overlayCount).toBe(0);
  });

  test('release is idempotent', () => {
    const lease = acquireOverlayLease({
      document,
      id: 'modal',
    });

    lease.release();
    lease.release();

    expect(getOverlayLifecycleSnapshot(document)).toEqual({
      overlayCount: 0,
      modalCount: 0,
      scrollLockCount: 0,
      activeIds: [],
    });
  });

  test('restores empty styles without leaving inline lock artifacts', () => {
    const lease = acquireOverlayLease({
      document,
      id: 'modal',
    });

    expect(document.body.style.overflow).toBe('hidden');
    lease.release();

    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');
    expect(document.documentElement.style.overscrollBehavior).toBe('');
  });

  test('preserves active id insertion order for diagnostics', () => {
    const releases = [
      acquireOverlayLease({ document, id: 'zeta' }),
      acquireOverlayLease({ document, id: 'alpha' }),
      acquireOverlayLease({ document, id: 'middle' }),
    ];

    expect(getOverlayLifecycleSnapshot(document).activeIds).toEqual([
      'zeta',
      'alpha',
      'middle',
    ]);

    releases.forEach(lease => lease.release());
  });

  test('allows duplicate semantic ids because leases are independently owned', () => {
    const first = acquireOverlayLease({
      document,
      id: 'dialog',
    });
    const second = acquireOverlayLease({
      document,
      id: 'dialog',
    });

    expect(second.getSnapshot()).toEqual({
      overlayCount: 2,
      modalCount: 2,
      scrollLockCount: 2,
      activeIds: ['dialog', 'dialog'],
    });

    first.release();
    expect(second.getSnapshot().overlayCount).toBe(1);
    second.release();
  });

  test('validates overlay ids', () => {
    expect(() => acquireOverlayLease({
      document,
      id: '   ',
    })).toThrow('Overlay id is required');

    expect(() => acquireOverlayLease({
      document,
      id: 'x'.repeat(97),
    })).toThrow('96 characters or fewer');
  });
});
