import { forwardRef, useState, type ReactNode } from 'react';

interface AbbLauncherWindowManager {
  readonly ShowWindow: (id: string) => void;
}

export interface ABBQueryWindowProps {
  readonly windowManager: AbbLauncherWindowManager;
}

export const ABBQueryWindow = forwardRef<unknown, ABBQueryWindowProps>(
  ({ windowManager }, _ref): ReactNode => {
    const [visible, setVisible] = useState(true);

    const openHalkEkmek = (): void => {
      windowManager.ShowWindow('halkekmek-query-window');
      setVisible(false);
    };

    if (!visible) return null;

    return (
      <div className="sidebar-container">
        <button
          type="button"
          className="sidebar-button sidebar-button-sub"
          onClick={openHalkEkmek}
          aria-label="Halk Ekmek noktalarını aç"
          title="Halk Ekmek"
        >
          <img
            className="sidebar-button-icon"
            src="images/icons/sidebar/alisveris.png"
            alt=""
            aria-hidden="true"
          />
        </button>
      </div>
    );
  },
);

ABBQueryWindow.displayName = 'ABBQueryWindow';
