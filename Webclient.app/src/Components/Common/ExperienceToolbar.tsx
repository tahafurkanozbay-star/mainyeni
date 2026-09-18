import {
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
  readonly onActivate?: () => void;
}

export interface ExperienceToolbarProps {
  readonly items: readonly ExperienceToolbarItem[];
  readonly label: string;
  readonly orientation?: RovingFocusOrientation;
  readonly direction?: RovingFocusDirection;
  readonly loop?: boolean;
  readonly className?: string;
}

const toRovingItems = (
  items: readonly ExperienceToolbarItem[],
): readonly RovingFocusItem[] => items.map((item) => ({
  id: item.id,
  disabled: item.disabled,
  hidden: item.hidden,
}));

export function ExperienceToolbar({
  items,
  label,
  orientation = 'horizontal',
  direction = 'ltr',
  loop = true,
  className = '',
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
      ref={rootRef}
      className={`experience-toolbar ${className}`.trim()}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      data-orientation={orientation}
      dir={direction}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        if (item.hidden) return null;
        return (
          <button
            key={item.id}
            type="button"
            className="experience-toolbar__button"
            data-roving-focus-id={item.id}
            tabIndex={tabIndices[index] ?? -1}
            disabled={item.disabled}
            aria-label={item.label}
            aria-pressed={item.pressed}
            onFocus={() => setActiveIndex(index)}
            onClick={item.onActivate}
          >
            {item.icon ? (
              <span className="experience-toolbar__icon" aria-hidden="true">{item.icon}</span>
            ) : null}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
