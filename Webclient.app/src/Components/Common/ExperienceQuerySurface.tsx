import { useId, type ReactNode } from 'react';
import { ExperienceStatus, type ExperienceStatusTone } from './ExperienceStatus';

export interface ExperienceQuerySurfaceStatus {
  readonly tone: ExperienceStatusTone;
  readonly title: string;
  readonly description?: ReactNode;
  readonly live?: 'off' | 'polite' | 'assertive';
  readonly actions?: ReactNode;
}

export interface ExperienceQuerySurfaceProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly eyebrow?: string;
  readonly count?: number;
  readonly headerActions?: ReactNode;
  readonly filters?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly status?: ExperienceQuerySurfaceStatus;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly busy?: boolean;
  readonly className?: string;
}

export function ExperienceQuerySurface({ title, description, eyebrow, count, headerActions, filters, toolbar, status, children, footer, busy = false, className = '' }: ExperienceQuerySurfaceProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <section className={`experience-query-surface ${className}`.trim()} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={busy || undefined}>
      <header className="experience-query-surface__header">
        <div className="experience-query-surface__heading">
          {eyebrow ? <span className="experience-eyebrow">{eyebrow}</span> : null}
          <div className="experience-query-surface__title-row">
            <h2 id={titleId}>{title}</h2>
            {typeof count === 'number' ? <span className="experience-query-surface__count" aria-label={`${count} kayıt`}>{count.toLocaleString('tr-TR')}</span> : null}
          </div>
          {description ? <div id={descriptionId} className="experience-query-surface__description">{description}</div> : null}
        </div>
        {headerActions ? <div className="experience-query-surface__header-actions">{headerActions}</div> : null}
      </header>
      {filters ? <div className="experience-query-surface__filters">{filters}</div> : null}
      {toolbar ? <div className="experience-query-surface__toolbar">{toolbar}</div> : null}
      {status ? <ExperienceStatus tone={status.tone} title={status.title} live={status.live ?? 'off'} actions={status.actions}>{status.description}</ExperienceStatus> : null}
      <div className="experience-query-surface__content">{children}</div>
      {footer ? <footer className="experience-query-surface__footer">{footer}</footer> : null}
    </section>
  );
}
