import {
  createContext,
  useContext,
  useMemo,
  type ButtonHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  resolveEffectiveTheme,
  type ExperienceTheme,
} from '../../experience/experienceRuntime';
import {
  patchExperiencePreferences,
} from '../../experience/experienceSession';
import {
  useExperienceMediaPreferences,
  useExperiencePreferences,
} from '../../experience/workspace/useExperienceEnvironment';
import {
  nextExplicitTheme,
  type WorkspaceTheme,
  type WorkspaceTone,
} from '../../experience/workspace/experienceWorkspaceModel';

export const EXPERIENCE_TOKENS = Object.freeze({
  spacing: Object.freeze({ xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 }),
  radius: Object.freeze({ control: 8, card: 12, panel: 16, modal: 18, pill: 999 }),
  control: Object.freeze({ height: 40, touchTarget: 44 }),
  z: Object.freeze({ map: 0, overlay: 10, controls: 20, panel: 30, dialog: 100 }),
  motion: Object.freeze({ fast: 120, standard: 180, deliberate: 260 }),
  breakpoint: Object.freeze({ compact: 640, medium: 1024, wide: 1440 }),
} as const);

export interface ExperienceThemeContextValue {
  readonly theme: WorkspaceTheme;
  readonly preference: ExperienceTheme;
  readonly setTheme: (theme: ExperienceTheme) => void;
  readonly toggleTheme: () => void;
}

const ThemeContext = createContext<ExperienceThemeContextValue | null>(null);

export const ExperienceThemeProvider = ({ children }: PropsWithChildren): ReactNode => {
  const preferences = useExperiencePreferences();
  const media = useExperienceMediaPreferences();
  const theme = resolveEffectiveTheme(preferences.theme, media.prefersDark) as WorkspaceTheme;

  const value = useMemo<ExperienceThemeContextValue>(() => ({
    theme,
    preference: preferences.theme,
    setTheme: (nextTheme: ExperienceTheme) => {
      patchExperiencePreferences({ theme: nextTheme });
    },
    toggleTheme: () => {
      patchExperiencePreferences({ theme: nextExplicitTheme(theme) });
    },
  }), [preferences.theme, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useExperienceTheme = (): ExperienceThemeContextValue => {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useExperienceTheme must be used inside ExperienceThemeProvider');
  }
  return value;
};

export interface StatusPillProps {
  readonly tone?: WorkspaceTone;
  readonly children: ReactNode;
  readonly label?: string;
}

export const StatusPill = ({
  tone = 'neutral',
  children,
  label,
}: StatusPillProps): ReactNode => (
  <span
    className={`experience-status-pill experience-status-pill--${tone}`}
    aria-label={label}
  >
    <span aria-hidden="true" className="experience-status-pill__dot" />
    {children}
  </span>
);

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}

export const EmptyState = ({
  title,
  description,
  action,
  icon,
}: EmptyStateProps): ReactNode => (
  <section className="experience-empty-state" aria-labelledby="experience-empty-state-title">
    <div className="experience-empty-state__icon" aria-hidden="true">{icon ?? '—'}</div>
    <h3 id="experience-empty-state-title">{title}</h3>
    {description ? <p>{description}</p> : null}
    {action ?? null}
  </section>
);

export interface LoadingStateProps {
  readonly label?: string;
  readonly rows?: number;
}

const normalizeSkeletonRows = (rows: number | undefined): number => {
  const numeric = Number(rows);
  if (!Number.isFinite(numeric)) return 3;
  return Math.max(1, Math.min(12, Math.floor(numeric)));
};

export const LoadingState = ({
  label = 'Yükleniyor',
  rows = 3,
}: LoadingStateProps): ReactNode => (
  <section
    className="experience-loading-state"
    role="status"
    aria-live="polite"
    aria-busy="true"
    aria-label={label}
  >
    <span className="experience-sr-only">{label}</span>
    <div className="experience-loading-state__head" aria-hidden="true">
      <span className="experience-skeleton experience-skeleton--title" />
      <span className="experience-skeleton experience-skeleton--control" />
    </div>
    <div className="experience-loading-state__rows" aria-hidden="true">
      {Array.from({ length: normalizeSkeletonRows(rows) }, (_, index) => (
        <span key={index} className="experience-skeleton" />
      ))}
    </div>
  </section>
);

export interface ErrorStateProps {
  readonly title?: string;
  readonly description?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

export const ErrorState = ({
  title = 'Bir sorun oluştu',
  description,
  onRetry,
  retryLabel = 'Tekrar dene',
}: ErrorStateProps): ReactNode => (
  <section className="experience-error-state" role="alert" aria-live="assertive">
    <div className="experience-error-state__badge" aria-hidden="true">!</div>
    <div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {onRetry ? (
        <button
          type="button"
          className="experience-btn experience-btn--secondary"
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  </section>
);

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  readonly label: string;
  readonly icon: ReactNode;
  readonly pressed?: boolean;
}

export const IconButton = ({
  label,
  icon,
  pressed,
  className = '',
  ...props
}: IconButtonProps): ReactNode => (
  <button
    {...props}
    type="button"
    className={`experience-icon-button ${className}`.trim()}
    aria-label={label}
    aria-pressed={pressed}
  >
    <span aria-hidden="true">{icon}</span>
  </button>
);

export default ExperienceThemeProvider;
