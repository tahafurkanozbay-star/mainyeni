import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  createRovingTabIndex,
  focusRovingTarget,
  getInitialRovingIndex,
  reconcileRovingIndex,
  resolveRovingFocusMove,
  type RovingFocusItem,
} from '../../experience/rovingFocusRuntime';
import './ExperiencePrimitives.css';

export type ExperienceMenuDismissReason = 'escape' | 'tab';

export interface ExperienceMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly description?: string;
  readonly className?: string;
  readonly onActivate?: () => void;
}

export interface ExperienceMenuProps {
  readonly id?: string;
  readonly label: string;
  readonly items: readonly ExperienceMenuItem[];
  readonly visible?: boolean;
  readonly className?: string;
  readonly itemClassName?: string;
  readonly style?: CSSProperties;
  readonly focusRequestKey?: number | string;
  readonly autoFocusWhenVisible?: boolean;
  readonly loop?: boolean;
  readonly onDismiss?: (reason: ExperienceMenuDismissReason) => void;
}

const toRovingItems = (items: readonly ExperienceMenuItem[]): readonly RovingFocusItem[] => (
  items.map((item) => ({
    id: item.id,
    disabled: item.disabled,
    hidden: item.hidden,
  }))
);

const findEnabledIndex = (
  items: readonly ExperienceMenuItem[],
  preferredIndex: number,
): number => {
  const preferred = items[preferredIndex];
  if (preferred && !preferred.disabled && !preferred.hidden) return preferredIndex;
  return getInitialRovingIndex(toRovingItems(items));
};

export function ExperienceMenu({
  id,
  label,
  items,
  visible = true,
  className = '',
  itemClassName = '',
  style,
  focusRequestKey,
  autoFocusWhenVisible = false,
  loop = true,
  onDismiss,
}: ExperienceMenuProps): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const previousItemsRef = useRef<readonly RovingFocusItem[]>([]);
  const rovingItems = useMemo(() => toRovingItems(items), [items]);
  const [activeIndex, setActiveIndex] = useState(() => getInitialRovingIndex(rovingItems));

  useEffect(() => {
    setActiveIndex((current) => reconcileRovingIndex(
      previousItemsRef.current,
      rovingItems,
      current,
    ));
    previousItemsRef.current = rovingItems;
  }, [rovingItems]);

  useEffect(() => {
    if (!visible || !autoFocusWhenVisible) return undefined;
    let cancelled = false;
    const nextIndex = findEnabledIndex(items, activeIndex);
    if (nextIndex < 0) return undefined;
    setActiveIndex(nextIndex);
    queueMicrotask(() => {
      if (cancelled) return;
      const targetId = items[nextIndex]?.id;
      if (targetId) focusRovingTarget(rootRef.current, targetId);
    });
    return () => {
      cancelled = true;
    };
    // focusRequestKey intentionally retriggers focus for repeated menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusWhenVisible, focusRequestKey, visible]);

  const tabIndices = createRovingTabIndex(rovingItems, activeIndex);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss?.('escape');
      return;
    }
    if (event.key === 'Tab') {
      onDismiss?.('tab');
      return;
    }

    const move = resolveRovingFocusMove(rovingItems, activeIndex, event.key, {
      orientation: 'vertical',
      direction: 'ltr',
      loop,
    });
    if (!move) return;
    event.preventDefault();
    setActiveIndex(move.index);
    focusRovingTarget(rootRef.current, move.id);
  };

  return (
    <div
      id={id}
      ref={rootRef}
      className={`experience-menu ${className}`.trim()}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      aria-hidden={!visible}
      data-visible={visible ? 'true' : 'false'}
      style={style}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        if (item.hidden) return null;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`experience-menu__item ${itemClassName} ${item.className ?? ''}`.trim()}
            data-roving-focus-id={item.id}
            tabIndex={visible ? (tabIndices[index] ?? -1) : -1}
            disabled={item.disabled}
            aria-label={item.label}
            aria-describedby={item.description ? `${id ?? 'experience-menu'}-${item.id}-description` : undefined}
            onFocus={() => setActiveIndex(index)}
            onClick={item.onActivate}
          >
            {item.icon ? (
              <span className="experience-menu__icon" aria-hidden="true">{item.icon}</span>
            ) : null}
            <span className="experience-menu__copy">
              <span className="experience-menu__label">{item.label}</span>
              {item.description ? (
                <span
                  id={`${id ?? 'experience-menu'}-${item.id}-description`}
                  className="experience-menu__description"
                >
                  {item.description}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default ExperienceMenu;
