import type { ReactNode } from 'react';

export type ExperienceStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface ExperienceStatusProps {
  readonly children: ReactNode;
  readonly tone?: ExperienceStatusTone;
  readonly live?: 'off' | 'polite' | 'assertive';
  readonly busy?: boolean;
  readonly className?: string;
}

export function ExperienceStatus({ children, tone = 'neutral', live = 'off', busy = false, className = '' }: ExperienceStatusProps): ReactNode {
  const liveProps = live === 'off' ? {} : { 'aria-live': live, 'aria-atomic': true as const };
  return (
    <output
      className={`experience-status experience-status--${tone} ${className}`.trim()}
      aria-busy={busy || undefined}
      data-tone={tone}
      {...liveProps}
    >
      <span className="experience-status__dot" aria-hidden="true" />
      <span className="experience-status__content">{children}</span>
    </output>
  );
}

export interface ExperienceProgressProps {
  readonly value?: number;
  readonly max?: number;
  readonly label: string;
  readonly detail?: ReactNode;
}

export function ExperienceProgress({ value, max = 100, label, detail }: ExperienceProgressProps): ReactNode {
  const boundedMax = Number.isFinite(max) && max > 0 ? max : 100;
  const determinate = Number.isFinite(value);
  const boundedValue = determinate ? Math.min(boundedMax, Math.max(0, Number(value))) : undefined;
  return (
    <div className="experience-progress" aria-label={label}>
      <div className="experience-progress__meta">
        <span>{label}</span>
        {detail ? <span>{detail}</span> : null}
      </div>
      {determinate ? (
        <progress value={boundedValue} max={boundedMax}>{Math.round((boundedValue! / boundedMax) * 100)}%</progress>
      ) : (
        <div className="experience-progress__indeterminate" role="progressbar" aria-label={label} aria-valuetext="İşlem sürüyor">
          <span aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
