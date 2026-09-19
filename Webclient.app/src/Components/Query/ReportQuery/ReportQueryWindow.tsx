import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  type ReactNode,
} from 'react';
import { CommonQueryWindowTools } from '../_Common/CommonQueryWindowTools';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
} from '../_Common/QuerySurfaceContracts';
import './ReportQueryWindow.css';

const WINDOW_TITLE = 'Rapor';
const WINDOW_LOGO = 'images/icons/common/rapor.png';
const REPORT_URL =
  'https://cbsportal.shkbilisim.com/portal/apps/dashboards/18385387c4c94f418a0b80caa30225aa';

interface ReportQueryWindowProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

export const ReportQueryWindow = forwardRef<
  ManagedQueryWindowHandle,
  ReportQueryWindowProps
>(({ id, windowManager }, ref): ReactNode => {
  const isVisible = windowManager.IsVisible(id);
  const isMinimized = windowManager.IsMinimized(id);

  useImperativeHandle(ref, () => ({
    id,
    visible: isVisible,
    minimized: isMinimized,
    OnShow: () => undefined,
    OnClose: () => undefined,
  }), [id, isMinimized, isVisible]);

  useEffect(() => {
    windowManager.RegisterWindow(ref);
    return () => {
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [id, ref, windowManager]);

  return (
    <section
      className="common-query-window"
      style={{
        maxWidth: '100%',
        width: 'calc(100vw - 140px)',
        height: 'calc(100vh - 90px)',
        visibility: isVisible ? 'visible' : 'hidden',
      }}
      aria-label={WINDOW_TITLE}
      aria-hidden={!isVisible}
    >
      <header className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src={WINDOW_LOGO}
          alt=""
          aria-hidden="true"
          decoding="async"
        />
        <span>{WINDOW_TITLE}</span>
        <CommonQueryWindowTools
          windowManager={windowManager}
          windowId={id}
          showNearbySearch={false}
          showMapSelect={false}
        />
      </header>
      <div
        className={`common-query-window-body ${isMinimized
          ? 'common-query-window-body-collapsed'
          : ''}`}
      >
        <iframe
          src={REPORT_URL}
          className="report-frame"
          title="Kent Rehberi rapor panosu"
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </section>
  );
});

ReportQueryWindow.displayName = 'ReportQueryWindow';
