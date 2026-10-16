import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from './Checkbox';

describe('Admin Checkbox native keyboard and accessibility contract', () => {
  test('exposes a named button with an accurate pressed state', () => {
    const toggle = vi.fn();
    const { rerender } = render(<Checkbox checked={false} text="Katmanı göster" toggle={toggle} />);
    const control = screen.getByRole('button', { name: 'Katmanı göster' });

    expect(control).toHaveAttribute('type', 'button');
    expect(control).toHaveAttribute('aria-pressed', 'false');
    expect(control.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    rerender(<Checkbox checked text="Katmanı göster" toggle={toggle} />);
    expect(screen.getByRole('button', { name: 'Katmanı göster' })).toHaveAttribute('aria-pressed', 'true');
    expect(control.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  test('is reachable with Tab and activates with Enter', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(<Checkbox checked={false} text="Parklar" toggle={toggle} />);
    const control = screen.getByRole('button', { name: 'Parklar' });

    await user.tab();
    expect(control).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  test('activates with Space without a custom keydown handler', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(<Checkbox checked={false} text="Servis" toggle={toggle} />);
    const control = screen.getByRole('button', { name: 'Servis' });

    control.focus();
    await user.keyboard(' ');
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  test('does not submit an enclosing form when toggled', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    const submit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <Checkbox checked={false} text="Etkin" toggle={toggle} />
      </form>,
    );
    await user.click(screen.getByRole('button', { name: 'Etkin' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  test('preserves the existing click-event callback contract', async () => {
    const user = userEvent.setup();
    let observedType: string | undefined;
    let observedTag: string | undefined;
    const toggle = vi.fn((event: { type: string; currentTarget: HTMLElement }) => {
      observedType = event.type;
      observedTag = event.currentTarget.tagName;
    });
    render(<Checkbox checked={false} text="Kullan" toggle={toggle} />);

    await user.click(screen.getByRole('button', { name: 'Kullan' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(observedType).toBe('click');
    expect(observedTag).toBe('BUTTON');
  });
});
