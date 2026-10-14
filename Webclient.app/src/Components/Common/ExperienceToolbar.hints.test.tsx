import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExperienceToolbar } from './ExperienceToolbar';
const items = [{ id: 'map-tool', label: 'Harita aracını aç', tooltip: 'Harita aracının açıklaması' }];
describe('scrolling toolbar hint ownership', () => {
  it('portals a focused hint outside its clipping scroll surface and associates the real button', async () => {
    const { container } = render(<div style={{ overflow: 'hidden', height: 44 }}><ExperienceToolbar label="Harita araçları" orientation="vertical" items={items} tooltipPlacement="left" /></div>);
    const button = screen.getByRole('button', { name: 'Harita aracını aç' });
    fireEvent.focus(button);
    const hint = await screen.findByRole('tooltip');
    expect(hint).toHaveTextContent('Harita aracının açıklaması');
    expect(container.contains(hint)).toBe(false);
    expect(button).toHaveAttribute('aria-describedby', hint.id);
    expect(button).not.toHaveAttribute('title');
    fireEvent.blur(button);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
  it('gives equal action IDs in different toolbar instances distinct hint IDs', async () => {
    render(<><ExperienceToolbar label="Birinci araçlar" items={items} tooltipPlacement="left" /><ExperienceToolbar label="İkinci araçlar" items={items} tooltipPlacement="left" /></>);
    const first = within(screen.getByRole('toolbar', { name: 'Birinci araçlar' })).getByRole('button');
    const second = within(screen.getByRole('toolbar', { name: 'İkinci araçlar' })).getByRole('button');
    fireEvent.focus(first); await screen.findByRole('tooltip'); fireEvent.mouseOver(second);
    await waitFor(() => expect(screen.getAllByRole('tooltip')).toHaveLength(2));
    expect(new Set(screen.getAllByRole('tooltip').map(hint => hint.id)).size).toBe(2);
  });
  it('retains native hints for existing callers that do not opt into portal placement', () => {
    const { container } = render(<ExperienceToolbar label="Mevcut araçlar" items={items} />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Harita aracının açıklaması');
    fireEvent.focus(screen.getByRole('button')); expect(container.querySelector('[data-portal-tooltips="false"]')).not.toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
