import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import type { MapWidgetManagerLike } from '../_shared/MapWidgetSurface';
import FeedbackForm from './FeedbackForm';
import './FeedbackWidget.css';

export interface FeedbackWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

export const FeedbackWidget = forwardRef<ManagedWindowHandle, FeedbackWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => undefined,
      OnClose: () => undefined,
    }), [id]);

    useEffect(() => {
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      return () => windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
    }, [id, ref, windowManager]);

    return (
      <FeedbackForm
        show={windowManager.IsVisible(id)}
        closeWindow={() => windowManager.HideWindow(id)}
      />
    );
  },
);

FeedbackWidget.displayName = 'FeedbackWidget';
