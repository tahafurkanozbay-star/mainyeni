import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface ExperienceToolbarProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly orientation?: 'horizontal' | 'vertical';
  readonly className?: string;
}

type ToolbarChildProps = {
  readonly disabled?: boolean;
  readonly tabIndex?: number;
  readonly onFocus?: () => void;
};

const isEnabled = (element: Element | null): element is HTMLElement => (
  element instanceof HTMLElement
  && !element.hasAttribute('disabled')
  && element.getAttribute('aria-disabled') !== 'true'
);

const focusAt = (items: readonly HTMLElement[], index: number): void => {
  if (items.length === 0) return;
  const bounded = ((index % items.length) + items.length) % items.length;
  items[bounded]?.focus({ preventScroll: true });
};

export function ExperienceToolbar({
  label,
  children,
  orientation = 'horizontal',
  className = '',
}: ExperienceToolbarProps): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeIndexRef = useRef(0);

  const enabledItems = useCallback((): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('[data-experience-toolbar-item="true"]')).filter(isEnabled);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const horizontal = orientation === 'horizontal';
    const previousKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return;

    const items = enabledItems();
    if (items.length === 0) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = Math.max(0, items.indexOf(focused ?? items[0]!));
    event.preventDefault();

    if (event.key === 'Home') focusAt(items, 0);
    else if (event.key === 'End') focusAt(items, items.length - 1);
    else focusAt(items, current + (event.key === nextKey ? 1 : -1));
  };

  const items = Children.toArray(children);
  let firstEnabledAssigned = false;
  const enhanced = items.map((child, index) => {
    if (!isValidElement<ToolbarChildProps>(child)) return child;
    const disabled = Boolean(child.props.disabled);
    const tabIndex = !disabled && !firstEnabledAssigned ? 0 : -1;
    if (!disabled) firstEnabledAssigned = true;
    const originalFocus = child.props.onFocus;
    return cloneElement(child as ReactElement<ToolbarChildProps>, {
      tabIndex,
      'data-experience-toolbar-item': 'true',
      onFocus: () => {
        activeIndexRef.current = index;
        originalFocus?.();
      },
    } as ToolbarChildProps & Record<string, unknown>);
  });

  return (
    <div
      ref={rootRef}
      className={`experience-toolbar ${className}`.trim()}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
    >
      {enhanced}
    </div>
  );
}

export default ExperienceToolbar;
