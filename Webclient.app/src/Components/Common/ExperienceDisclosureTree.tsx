import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  type DisclosureTreeItem,
  type DisclosureTreeModel,
  type DisclosureTreeSnapshot,
} from '../../experience/disclosureTreeModel';
import './experience-disclosure-tree.css';

export interface ExperienceDisclosureTreeProps {
  readonly model: DisclosureTreeModel;
  readonly label: string;
  readonly selectionLabel?: string;
  readonly renderLeading?: (item: DisclosureTreeItem) => ReactNode;
  readonly renderTrailing?: (item: DisclosureTreeItem) => ReactNode;
  readonly onActivate?: (item: DisclosureTreeItem) => void;
}

const selectorForId = (id: string): string => {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
  return `[data-experience-tree-item="${escaped}"]`;
};

type TreeStyle = CSSProperties & { '--experience-tree-level': number };

export const ExperienceDisclosureTree = ({
  model,
  label,
  selectionLabel = 'Seçili',
  renderLeading,
  renderTrailing,
  onActivate,
}: ExperienceDisclosureTreeProps): ReactNode => {
  const [snapshot, setSnapshot] = useState<DisclosureTreeSnapshot>(() => model.snapshot());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => model.subscribe(setSnapshot), [model]);

  const focusActive = (): void => {
    const id = model.snapshot().activeId;
    if (!id) return;
    rootRef.current?.querySelector<HTMLElement>(selectorForId(id))?.focus({ preventScroll: true });
  };

  const move = (direction: Parameters<DisclosureTreeModel['moveActive']>[0]): void => {
    model.moveActive(direction);
    focusActive();
  };

  const activateCurrent = (): void => {
    const current = model.snapshot();
    const item = current.items.find((candidate) => candidate.id === current.activeId);
    if (!item || item.disabled) return;
    model.toggleSelected(item.id);
    onActivate?.(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move('next'); return;
      case 'ArrowUp': event.preventDefault(); move('previous'); return;
      case 'ArrowLeft': event.preventDefault(); move('parent'); return;
      case 'ArrowRight': event.preventDefault(); move('child'); return;
      case 'Home': event.preventDefault(); move('first'); return;
      case 'End': event.preventDefault(); move('last'); return;
      case 'Enter':
      case ' ': event.preventDefault(); activateCurrent(); return;
      default:
        if (event.key.length === 1 && !event.shiftKey) {
          model.typeahead(event.key);
          focusActive();
        }
    }
  };

  const onItemFocus = (item: DisclosureTreeItem): void => {
    if (!item.disabled) model.setActive(item.id);
  };

  const onItemClick = (item: DisclosureTreeItem): void => {
    if (item.disabled) return;
    model.setActive(item.id);
    model.toggleSelected(item.id);
    onActivate?.(item);
  };

  return (
    <div ref={rootRef} className="experience-disclosure-tree" role="tree" aria-label={label}
      aria-multiselectable={snapshot.selectedIds.length > 1 ? true : undefined} onKeyDown={onKeyDown}>
      {snapshot.items.length === 0 ? (
        <div className="experience-disclosure-tree__empty" role="status">Gösterilecek öğe yok.</div>
      ) : snapshot.items.map((item) => (
        <div key={item.id} className="experience-disclosure-tree__item" role="treeitem"
          data-experience-tree-item={item.id} data-active={String(item.active)} data-selected={String(item.selected)}
          aria-level={item.level} aria-posinset={item.positionInSet} aria-setsize={item.setSize}
          aria-expanded={item.expandable ? item.expanded : undefined} aria-selected={item.selected}
          aria-disabled={item.disabled || undefined} tabIndex={item.active && !item.disabled ? 0 : -1}
          style={{ '--experience-tree-level': item.level } as TreeStyle}
          onFocus={() => onItemFocus(item)} onClick={() => onItemClick(item)}>
          <span className="experience-disclosure-tree__indent" aria-hidden="true" />
          {item.expandable ? (
            <button type="button" className="experience-disclosure-tree__toggle" tabIndex={-1}
              aria-label={`${item.label}: ${item.expanded ? 'daralt' : 'genişlet'}`}
              onClick={(event) => { event.stopPropagation(); model.setActive(item.id); model.toggleExpanded(item.id); focusActive(); }}>
              <span aria-hidden="true">{item.expanded ? '▾' : '▸'}</span>
            </button>
          ) : <span className="experience-disclosure-tree__toggle-placeholder" aria-hidden="true" />}
          {renderLeading ? <span className="experience-disclosure-tree__leading">{renderLeading(item)}</span> : null}
          <span className="experience-disclosure-tree__label">{item.label}</span>
          {item.selected ? <span className="experience-disclosure-tree__selected-text">{selectionLabel}</span> : null}
          {renderTrailing ? <span className="experience-disclosure-tree__trailing">{renderTrailing(item)}</span> : null}
        </div>
      ))}
    </div>
  );
};

export default ExperienceDisclosureTree;
