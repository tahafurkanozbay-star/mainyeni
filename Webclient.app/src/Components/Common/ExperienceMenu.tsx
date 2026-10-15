import {
  useEffect,
  useId,
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
  resolveRovingTypeaheadMove,
  type RovingFocusItem,
} from '../../experience/rovingFocusRuntime';
import { getDeepActiveElement } from '../../experience/focusCandidate';
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
  const generatedId = useId();
  const descriptionIdPrefix = id ?? `experience-menu-${generatedId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const previousItemsRef = useRef<readonly RovingFocusItem[]>([]);
  const typeaheadRef = useRef({ sequence: '', timestamp: 0 });
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
    const focusDocument = rootRef.current?.ownerDocument;
    const focusBeforeSchedule = focusDocument ? getDeepActiveElement(focusDocument) : null;
    queueMicrotask(() => {
      if (cancelled) return;
      // A menu opening must not override a later user-initiated focus move.
      // A detached opener may legitimately fall back to document.body.
      const currentFocus = focusDocument ? getDeepActiveElement(focusDocument) : null;
      if (currentFocus !== focusBeforeSchedule && !(
        currentFocus === focusDocument?.body && focusBeforeSchedule && !focusBeforeSchedule.isConnected
      )) return;
      const targetId = items[nextIndex]?.id;
      if (targetId) focusRovingTarget(rootRef.current, targetId);
    });
    return () => {
      cancelled = true;
    };
    // focusRequestKey intentionally retriggers focus for repeated menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusWhenVisible, focusRequestKey, visible]);

  useEffect(() => {
    typeaheadRef.current = { sequence: '', timestamp: 0 };
  }, [visible, focusRequestKey]);

  const tabIndices = createRovingTabIndex(rovingItems, activeIndex);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!visible || event.defaultPrevented || event.nativeEvent.isComposing) return;
    // OS/browser modified Escape shortcuts belong to the platform, not the menu.
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onDismiss?.('escape');
      return;
    }
    if (event.key === 'Tab') {
      onDismiss?.('tab');
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;

    const move = resolveRovingFocusMove(rovingItems, activeIndex, event.key, {
      orientation: 'vertical',
      direction: 'ltr',
      loop,
    });
    if (move) {
      typeaheadRef.current = { sequence: '', timestamp: 0 };
      event.preventDefault();
      setActiveIndex(move.index);
      focusRovingTarget(rootRef.current, move.id);
      return;
    }

    // Keep printable-character navigation separate from native Space/Enter
    // activation, editor shortcuts and in-progress IME composition.
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing
      || event.key.length !== 1 || event.key.trim() === '') return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return;

    const timestamp = Date.now();
    const previous = typeaheadRef.current;
    const sequence = timestamp - previous.timestamp < 700
      ? previous.sequence + event.key
      : event.key;
    const match = resolveRovingTypeaheadMove(items, activeIndex, sequence);
    const resolved = match ?? resolveRovingTypeaheadMove(items, activeIndex, event.key);
    typeaheadRef.current = {
      sequence: match ? sequence : event.key,
      timestamp,
    };
    if (!resolved) return;
    event.preventDefault();
    setActiveIndex(resolved.index);
    focusRovingTarget(rootRef.current, resolved.id);
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
            aria-describedby={item.description ? `${descriptionIdPrefix}-${item.id}-description` : undefined}
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
                  id={`${descriptionIdPrefix}-${item.id}-description`}
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
