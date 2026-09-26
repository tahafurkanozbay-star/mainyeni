import { useCallback, type MouseEvent, type ReactNode } from 'react';
import './experience-skip-navigation.css';

export interface ExperienceSkipNavigationTarget {
  readonly id: string;
  readonly label: string;
}

export interface ExperienceSkipNavigationProps {
  readonly targets?: readonly ExperienceSkipNavigationTarget[];
}

const DEFAULT_TARGETS: readonly ExperienceSkipNavigationTarget[] = Object.freeze([
  Object.freeze({ id: 'esri-map-container', label: 'Harita çalışma alanına geç' }),
  Object.freeze({ id: 'sidebar', label: 'Katman ve gezinme menüsüne geç' }),
  Object.freeze({ id: 'toolbar-widget', label: 'Harita araçlarına geç' }),
]);

const TEMPORARY_TABINDEX = 'data-exp-skip-temporary-tabindex';

const isNaturallyFocusable = (element: HTMLElement): boolean => {
  if (element.tabIndex >= 0) return true;
  const tag = element.tagName.toLowerCase();
  if (tag === 'a') return element.hasAttribute('href');
  return ['button', 'input', 'select', 'textarea', 'summary'].includes(tag)
    && !element.hasAttribute('disabled');
};

const focusTarget = (id: string): boolean => {
  const target = document.getElementById(id);
  if (!(target instanceof HTMLElement)) return false;

  if (!isNaturallyFocusable(target) && !target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1');
    target.setAttribute(TEMPORARY_TABINDEX, 'true');
    const cleanup = (): void => {
      if (target.getAttribute(TEMPORARY_TABINDEX) !== 'true') return;
      target.removeAttribute(TEMPORARY_TABINDEX);
      target.removeAttribute('tabindex');
      target.removeEventListener('blur', cleanup);
    };
    target.addEventListener('blur', cleanup);
  }

  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }

  if (typeof target.scrollIntoView === 'function') {
    try {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      target.scrollIntoView();
    }
  }

  return document.activeElement === target;
};

export const ExperienceSkipNavigation = ({
  targets = DEFAULT_TARGETS,
}: ExperienceSkipNavigationProps): ReactNode => {
  const activate = useCallback((event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    event.preventDefault();
    if (typeof document === 'undefined') return;
    focusTarget(id);
  }, []);

  const normalizedTargets = targets.filter((target, index, all) => (
    target.id.trim().length > 0
    && target.label.trim().length > 0
    && all.findIndex((candidate) => candidate.id === target.id) === index
  ));

  if (normalizedTargets.length === 0) return null;

  return (
    <nav className="experience-skip-navigation" aria-label="Hızlı erişim">
      {normalizedTargets.map((target) => (
        <a
          key={target.id}
          className="experience-skip-navigation__link"
          href={`#${target.id}`}
          onClick={(event) => activate(event, target.id)}
        >
          {target.label}
        </a>
      ))}
    </nav>
  );
};

export default ExperienceSkipNavigation;
