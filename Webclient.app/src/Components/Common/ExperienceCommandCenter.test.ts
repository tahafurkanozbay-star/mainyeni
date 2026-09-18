import { describe, expect, it, vi } from 'vitest';
import {
  EXPERIENCE_COMMANDS,
  createExperienceCommandRegistry,
} from './ExperienceCommandCenter';

describe('createExperienceCommandRegistry', () => {
  it('registers every declared command exactly once', () => {
    const registry = createExperienceCommandRegistry({
      windowManager: { ShowWindow: vi.fn(() => true) },
      dispatchCommand: vi.fn(),
      dispatchExecuted: vi.fn(),
    });
    expect(registry.snapshot().commandCount).toBe(EXPERIENCE_COMMANDS.length);
    expect(new Set(EXPERIENCE_COMMANDS.map((command) => command.id)).size)
      .toBe(EXPERIENCE_COMMANDS.length);
  });

  it('contains unique normalized shortcuts', () => {
    const registry = createExperienceCommandRegistry({
      windowManager: { ShowWindow: vi.fn(() => true) },
    });
    expect(registry.snapshot().shortcutCount).toBe(4);
    expect(registry.resolveShortcut('ctrl+k')?.id).toBe('search');
    expect(registry.resolveShortcut('l')?.id).toBe('layers');
    expect(registry.resolveShortcut('g')?.id).toBe('legend');
    expect(registry.resolveShortcut('?')?.id).toBe('help');
  });

  it('executes target commands through WindowManager', async () => {
    const ShowWindow = vi.fn(() => true);
    const dispatchExecuted = vi.fn();
    const registry = createExperienceCommandRegistry({
      windowManager: { ShowWindow },
      dispatchCommand: vi.fn(),
      dispatchExecuted,
    });

    await expect(registry.execute('measure')).resolves.toBe(true);
    expect(ShowWindow).toHaveBeenCalledWith('measurement-widget');
    expect(dispatchExecuted).toHaveBeenCalledWith('measure');
  });

  it('does not report a target command executed when WindowManager rejects it', async () => {
    const dispatchExecuted = vi.fn();
    const registry = createExperienceCommandRegistry({
      windowManager: { ShowWindow: vi.fn(() => false) },
      dispatchExecuted,
    });

    await expect(registry.execute('bookmark')).resolves.toBe(true);
    expect(dispatchExecuted).not.toHaveBeenCalled();
  });

  it('disables target commands without a WindowManager', async () => {
    const registry = createExperienceCommandRegistry();
    expect(registry.search('ölçüm')[0]?.enabled).toBe(false);
    await expect(registry.execute('measure')).resolves.toBe(false);
  });

  it('keeps event commands enabled without a WindowManager', () => {
    const registry = createExperienceCommandRegistry();
    expect(registry.search('katman')[0]?.enabled).toBe(true);
    expect(registry.search('lejand')[0]?.enabled).toBe(true);
    expect(registry.search('klavye')[0]?.enabled).toBe(true);
  });

  it('dispatches event commands and execution evidence', async () => {
    const dispatchCommand = vi.fn();
    const dispatchExecuted = vi.fn();
    const registry = createExperienceCommandRegistry({
      dispatchCommand,
      dispatchExecuted,
    });

    await expect(registry.execute('layers')).resolves.toBe(true);
    expect(dispatchCommand).toHaveBeenCalledWith('layers');
    expect(dispatchExecuted).toHaveBeenCalledWith('layers');
  });

  it('searches Turkish command labels through the typed registry', () => {
    const registry = createExperienceCommandRegistry({
      windowManager: { ShowWindow: vi.fn(() => true) },
    });
    expect(registry.search('olcum').map((command) => command.id)).toContain('measure');
    expect(registry.search('altlik').map((command) => command.id)).toContain('basemap');
  });

  it('searches command keywords', () => {
    const registry = createExperienceCommandRegistry({
      windowManager: { ShowWindow: vi.fn(() => true) },
    });
    expect(registry.search('mesafe').map((command) => command.id)).toContain('measure');
    expect(registry.search('favori').map((command) => command.id)).toContain('bookmark');
    expect(registry.search('layer').map((command) => command.id)).toContain('layers');
  });

  it('keeps help behavior independent of WindowManager', async () => {
    const dispatchCommand = vi.fn();
    const registry = createExperienceCommandRegistry({ dispatchCommand });
    await expect(registry.execute('help')).resolves.toBe(true);
    expect(dispatchCommand).toHaveBeenCalledWith('help');
  });

  it('rejects unknown commands without side effects', async () => {
    const ShowWindow = vi.fn(() => true);
    const dispatchCommand = vi.fn();
    const registry = createExperienceCommandRegistry({
      windowManager: { ShowWindow },
      dispatchCommand,
    });
    await expect(registry.execute('missing')).resolves.toBe(false);
    expect(ShowWindow).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it('keeps the catalog bounded to reviewed command targets and events', () => {
    for (const command of EXPERIENCE_COMMANDS) {
      expect(Boolean(command.target) || Boolean(command.event)).toBe(true);
      expect(Boolean(command.target) && Boolean(command.event)).toBe(false);
      expect(command.id.length).toBeGreaterThan(0);
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.group.length).toBeGreaterThan(0);
    }
  });
});
