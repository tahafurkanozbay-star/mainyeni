import { type ReactNode } from 'react';
import './Error.css';

export interface FullScreenErrorProps {
  readonly message?: string;
  readonly action?: ReactNode;
}

export const FullScreenError = ({ message = 'Beklenmeyen bir hata oluştu.', action }: FullScreenErrorProps): ReactNode => (
  <div className="w-100 h-100 full-screen-div" role="alert" aria-live="assertive" aria-atomic="true">
    <div className="ErrorFullScreenText">{message}</div>
    {action ? <div className="experience-error-action">{action}</div> : null}
  </div>
);
