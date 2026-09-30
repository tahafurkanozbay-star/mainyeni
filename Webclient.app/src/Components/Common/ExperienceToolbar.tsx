import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  createRovingTabIndex,
  focusRovingTarget,
  getInitialRovingIndex,
  reconcileRovingIndex,
  resolveRovingFocusMove,
  type RovingFocusDirection,
  type RovingFocusItem,
  type RovingFocusOrientation,
} from '../../experience/rovingFocusRuntime';
import './ExperiencePrimitives.css';

export interface ExperienceToolbarItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly busy?: boolean;
  readonly tooltip?: string;
  readonly className?: string;
  readonly group?: string;
  readonly groupLabel?: string;
  readonly ariaKeyShortcuts?: string;
  readonly onActivate?: () => void;
}

export interface ExperienceToolbarProps {
  readonly id?: string;
  readonly items: readonly ExperienceToolbarItem[];
  readonly label: string;
  readonly orientation?: RovingFocusOrientation;
  readonly direction?: RovingFocusDirection;
  readonly loop?: boolean;
  readonly className?: string;
  readonly describedBy?: string;
}

const toRovingItems = (
  items: readonly ExperienceToolbarItem[],
): readonly RovingFocusItem[] => items.map((item) => ({
  id: item.id,
  disabled: item.disabled || item.busy,
  hidden: item.hidden,
}));

const hasGroupBoundary = (
  items: readonly ExperienceToolbarItem[],
  index: number,
): boolean => {
  if (index <= 0) return false;
  const current = items[index];
  if (!current || current.hidden || !current.group) return false;
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const previous = items[previousIndex];
    if (!previous || previous.hidden) continue;
    return Boolean(previous.group && previous.group !== current.group);
  }
  return false;
};

export function ExperienceToolbar({
  id,
  items,
  label,
  orientation = 'horizontal',
  direction = 'ltr',
  loop = true,
  className = '',
  describedBy,
}: ExperienceToolbarProps): ReactNode {
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

  const tabIndices = createRovingTabIndex(rovingItems, activeIndex);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = resolveRovingFocusMove(rovingItems, activeIndex, event.key, {
      orientation,
      direction,
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
      className={`experience-toolbar ${className}`.trim()}
      role="toolbar"
      aria-label={label}
      aria-describedby={describedBy}
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      data-orientation={orientation}
      dir={direction}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        if (item.hidden) return null;
        const disabled = Boolean(item.disabled || item.busy);
        const groupBoundary = hasGroupBoundary(items, index);
        return (
          <Fragment key={item.id}>
            {groupBoundary ? (
              <span
                className="experience-toolbar__separator"
                role="separator"
                aria-orientation={orientation === 'vertical' ? 'horizontal' : 'vertical'}
                data-group-start={item.group}
              />
            ) : null}
            <button
              type="button"
              className={`experience-toolbar__button ${item.className ?? ''}`.trim()}
              data-roving-focus-id={item.id}
              data-toolbar-group={item.group}
              data-tooltip={item.tooltip}
              tabIndex={tabIndices[index] ?? -1}
              disabled={disabled}
              aria-label={item.label}
              aria-pressed={item.pressed}
              aria-busy={item.busy || undefined}
              aria-keyshortcuts={item.ariaKeyShortcuts}
              onFocus={() => setActiveIndex(index)}
              onClick={item.onActivate}
            >
              {item.icon ? (
                <span className="experience-toolbar__icon" aria-hidden="true">{item.icon}</span>
              ) : null}
              <span className="experience-toolbar__label">{item.label}</span>
            </button>
            {item.groupLabel ? (
              <span className="experience-sr-only" data-toolbar-group-label={item.group}>
                {item.groupLabel}
              </span>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
