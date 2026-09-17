import { useId, type ReactNode } from 'react';

export type ExperienceStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface ExperienceStatusProps {
  readonly title: string;
  readonly children?: ReactNode;
  readonly tone?: ExperienceStatusTone;
  readonly live?: 'off' | 'polite' | 'assertive';
  readonly actions?: ReactNode;
  readonly compact?: boolean;
}

export const ExperienceStatus = ({ title, children, tone = 'neutral', live = 'off', actions, compact = false }: ExperienceStatusProps): ReactNode => {
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  return (
    <section className={`experience-status experience-status--${tone}${compact ? ' experience-status--compact' : ''}`} role={role} aria-live={live === 'off' ? undefined : live} aria-atomic={live === 'off' ? undefined : true}>
      <div className="experience-status__marker" aria-hidden="true" />
      <div className="experience-status__body">
        <h3 className="experience-status__title">{title}</h3>
        {children ? <div className="experience-status__content">{children}</div> : null}
      </div>
      {actions ? <div className="experience-status__actions">{actions}</div> : null}
    </section>
  );
};

export interface ExperienceEmptyStateProps {
  readonly title: string;
  readonly description: ReactNode;
  readonly action?: ReactNode;
  readonly secondaryAction?: ReactNode;
}

export const ExperienceEmptyState = ({ title, description, action, secondaryAction }: ExperienceEmptyStateProps): ReactNode => {
  const titleId = useId();
  return (
    <section className="experience-empty" aria-labelledby={titleId}>
      <div className="experience-empty__symbol" aria-hidden="true">◇</div>
      <h3 id={titleId} className="experience-empty__title">{title}</h3>
      <div className="experience-empty__description">{description}</div>
      {action || secondaryAction ? <div className="experience-empty__actions">{action}{secondaryAction}</div> : null}
    </section>
  );
};

export interface ExperienceProgressProps {
  readonly label: string;
  readonly value?: number;
  readonly max?: number;
  readonly description?: string;
}

export const ExperienceProgress = ({ label, value, max = 100, description }: ExperienceProgressProps): ReactNode => {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const boundedValue = value === undefined || !Number.isFinite(value) ? undefined : Math.min(Math.max(value, 0), safeMax);
  const percentage = boundedValue === undefined ? undefined : (boundedValue / safeMax) * 100;
  return (
    <div className="experience-progress">
      <div className="experience-progress__header">
        <span className="experience-progress__label">{label}</span>
        {percentage === undefined ? null : <span className="experience-progress__value">{Math.round(percentage)}%</span>}
      </div>
      <div className={`experience-progress__track${boundedValue === undefined ? ' experience-progress__track--indeterminate' : ''}`} role="progressbar" aria-label={label} aria-valuemin={boundedValue === undefined ? undefined : 0} aria-valuemax={boundedValue === undefined ? undefined : safeMax} aria-valuenow={boundedValue}>
        {percentage === undefined ? <span className="experience-progress__indeterminate" /> : <span className="experience-progress__bar" style={{ inlineSize: `${percentage}%` }} />}
      </div>
      {description ? <p className="experience-progress__description">{description}</p> : null}
    </div>
  );
};
