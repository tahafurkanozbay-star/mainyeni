import { useId, type ReactNode } from 'react';
import './ExperiencePrimitives.css';

export interface ExperienceQuerySurfaceProps {
  readonly title: string;
  readonly description?: string;
  readonly filters?: ReactNode;
  readonly actions?: ReactNode;
  readonly status?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly busy?: boolean;
  readonly className?: string;
}

export function ExperienceQuerySurface({
  title,
  description,
  filters,
  actions,
  status,
  children,
  footer,
  busy = false,
  className = '',
}: ExperienceQuerySurfaceProps): ReactNode {
  const generatedId = useId().replace(/:/g, '');
  const titleId = `experience-query-${generatedId}-title`;
  const descriptionId = description
    ? `experience-query-${generatedId}-description`
    : undefined;

  return (
    <section
      className={`experience-query-surface ${className}`.trim()}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
    >
      <header className="experience-query-surface__header">
        <div className="experience-query-surface__title-group">
          <h2 id={titleId} className="experience-query-surface__title">{title}</h2>
          {description ? (
            <p id={descriptionId} className="experience-query-surface__description">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div>{actions}</div> : null}
      </header>
      {filters ? <div className="experience-query-surface__filters">{filters}</div> : null}
      {status ? <div>{status}</div> : null}
      <div className="experience-query-surface__body">{children}</div>
      {footer ? <footer className="experience-query-surface__footer">{footer}</footer> : null}
    </section>
  );
}
