import type { ReactNode } from 'react';
import { ExperienceRuntimeRecoveryBoundary } from '../../Components/Common/ExperienceRuntimeRecoveryBoundary';

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
}

/**
 * Root compatibility boundary.
 *
 * The application previously maintained a second, reload-only error boundary
 * with its own inline fallback UI. Root recovery is now delegated to the
 * shared Experience runtime authority so render failures have one bounded
 * recovery policy, one accessible surface and one diagnostics path.
 */
export const AppErrorBoundary = ({ children }: AppErrorBoundaryProps): ReactNode => (
  <ExperienceRuntimeRecoveryBoundary>
    {children}
  </ExperienceRuntimeRecoveryBoundary>
);
