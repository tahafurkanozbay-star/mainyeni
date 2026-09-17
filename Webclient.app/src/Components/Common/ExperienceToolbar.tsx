import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface ExperienceToolbarItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly title?: string;
  readonly onActivate: () => void;
}

export interface ExperienceToolbarProps {
  readonly label: string;
  readonly items: readonly ExperienceToolbarItem[];
  readonly className?: string;
  readonly orientation?: 'horizontal' | 'vertical';
}

const enabledIndex = (items: readonly ExperienceToolbarItem[], start: number, delta: number): number => {
  if (items.length === 0) return -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const candidate = (start + (delta * offset) + items.length) % items.length;
    if (!items[candidate]?.disabled) return candidate;
  }
  return -1;
};

export function ExperienceToolbar({ label, items, className = '', orientation = 'horizontal' }: ExperienceToolbarProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const firstEnabled = items.findIndex(item => !item.disabled);

  const moveFocus = useCallback((index: number, delta: number) => {
    const next = enabledIndex(items, index, delta);
    if (next >= 0) refs.current[next]?.focus();
  }, [items]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    const index = refs.current.findIndex(item => item === target);
    if (index < 0) return;
    const previousKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    if (event.key === previousKey) { event.preventDefault(); moveFocus(index, -1); }
    else if (event.key === nextKey) { event.preventDefault(); moveFocus(index, 1); }
    else if (event.key === 'Home') { event.preventDefault(); refs.current[firstEnabled]?.focus(); }
    else if (event.key === 'End') {
      event.preventDefault();
      const last = [...items].map((item, itemIndex) => ({ item, itemIndex })).reverse().find(entry => !entry.item.disabled)?.itemIndex;
      if (last !== undefined) refs.current[last]?.focus();
    }
  };

  return (
    <div className={`kr-toolbar ${className}`.trim()} role="toolbar" aria-label={label} aria-orientation={orientation} onKeyDown={onKeyDown}>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={node => { refs.current[index] = node; }}
          type="button"
          className="kr-toolbar__button"
          disabled={item.disabled}
          aria-label={item.label}
          aria-pressed={item.pressed}
          title={item.title ?? item.label}
          tabIndex={index === firstEnabled ? 0 : -1}
          onClick={item.onActivate}
        >
          {item.icon && <span className="kr-toolbar__icon" aria-hidden="true">{item.icon}</span>}
          <span className="kr-toolbar__label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export default ExperienceToolbar;
