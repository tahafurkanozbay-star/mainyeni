import { describe, expect, it } from 'vitest';
import { LegendPanelModel } from './legendPanelModel';
import { ShortcutHelpModel } from './shortcutHelpModel';

describe('workspace keyboard wrap contracts', () => {
  it('wraps collection focus in both legend and shortcut help', () => {
    const legend = new LegendPanelModel({ items: [
      { id: 'a', layerId: 'l', layerLabel: 'Katman', label: 'A', symbolKind: 'fill' },
      { id: 'b', layerId: 'l', layerLabel: 'Katman', label: 'B', symbolKind: 'line' },
    ] });
    legend.focusPrevious();
    expect(legend.snapshot.focusedId).toBe('b');

    const help = new ShortcutHelpModel({ items: [
      { id: 'a', label: 'A', keys: ['a'], scope: 'global', category: 'Genel' },
      { id: 'b', label: 'B', keys: ['b'], scope: 'global', category: 'Genel' },
    ] });
    help.open();
    help.focusPrevious();
    expect(help.snapshot.focusedId).toBe('b');
    help.focusNext();
    expect(help.snapshot.focusedId).toBe('a');
  });
});
