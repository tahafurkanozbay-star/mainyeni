import { useId, type KeyboardEvent, type ReactNode } from 'react';

export interface ExperienceToolbarAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly badge?: string;
  readonly onActivate: () => void;
}

export interface ExperienceToolbarProps {
  readonly label: string;
  readonly actions: readonly ExperienceToolbarAction[];
  readonly orientation?: 'horizontal' | 'vertical';
  readonly className?: string;
}

const enabledButtons = (current: HTMLButtonElement): HTMLButtonElement[] => {
  const toolbar = current.closest('[role="toolbar"]');
  return toolbar ? Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')) : [];
};

const focusSibling = (current: HTMLButtonElement, direction: 1 | -1): void => {
  const buttons = enabledButtons(current);
  const currentIndex = buttons.indexOf(current);
  if (currentIndex < 0 || buttons.length < 2) return;
  buttons[(currentIndex + direction + buttons.length) % buttons.length]?.focus();
};

const handleToolbarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, orientation: 'horizontal' | 'vertical'): void => {
  const previousKey = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const nextKey = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  if (event.key === previousKey || event.key === nextKey) {
    event.preventDefault();
    focusSibling(event.currentTarget, event.key === nextKey ? 1 : -1);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const buttons = enabledButtons(event.currentTarget);
    (event.key === 'Home' ? buttons[0] : buttons.at(-1))?.focus();
  }
};

export const ExperienceToolbar = ({ label, actions, orientation = 'horizontal', className = '' }: ExperienceToolbarProps): ReactNode => {
  const id = useId();
  const firstEnabledIndex = actions.findIndex((action) => !action.disabled);
  return (
    <div className={`experience-toolbar experience-toolbar--${orientation} ${className}`.trim()} role="toolbar" aria-label={label} aria-orientation={orientation}>
      {actions.map((action, index) => (
        <button
          key={action.id}
          id={`${id}-${action.id}`}
          type="button"
          className="experience-toolbar__action"
          aria-label={action.label}
          aria-pressed={action.pressed}
          disabled={action.disabled}
          tabIndex={index === firstEnabledIndex ? 0 : -1}
          onClick={action.onActivate}
          onKeyDown={(event) => handleToolbarKeyDown(event, orientation)}
        >
          {action.icon ? <span className="experience-toolbar__icon" aria-hidden="true">{action.icon}</span> : null}
          <span className="experience-toolbar__label">{action.label}</span>
          {action.badge ? <span className="experience-toolbar__badge" aria-hidden="true">{action.badge}</span> : null}
        </button>
      ))}
    </div>
  );
};
