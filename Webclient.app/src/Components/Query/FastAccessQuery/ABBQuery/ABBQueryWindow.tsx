import React, { useState, type ForwardedRef } from 'react';

interface FastAccessWindowManager {
  readonly ShowWindow: (id: string) => void;
}

interface ABBQueryWindowProps {
  readonly windowManager: FastAccessWindowManager;
}

/**
 * Accessible fast-access launcher for the municipal Halk Ekmek query.
 *
 * The legacy implementation rendered a clickable div and imported the full
 * query/GIS stack even though this surface only delegates to WindowManager.
 * Keeping this launcher intentionally small prevents unnecessary coupling and
 * gives keyboard and assistive-technology users a native button contract.
 */
export const ABBQueryWindow = React.forwardRef(function ABBQueryWindow(
  props: ABBQueryWindowProps,
  _ref: ForwardedRef<unknown>
) {
  const [isVisible, setIsVisible] = useState(true);

  const openHalkEkmek = () => {
    props.windowManager.ShowWindow('halkekmek-query-window');
    setIsVisible(false);
  };

  if (!isVisible) return null;

  return (
    <aside className="sidebar-container" aria-label="Hızlı erişim">
      <button
        type="button"
        className="sidebar-button sidebar-button-sub"
        onClick={openHalkEkmek}
        aria-label="Halk Ekmek noktalarını aç"
      >
        <img
          className="sidebar-button-icon"
          src="images/icons/sidebar/alisveris.png"
          alt=""
          aria-hidden="true"
        />
        <span className="experience-sr-only">Halk Ekmek noktaları</span>
      </button>
    </aside>
  );
});

ABBQueryWindow.displayName = 'ABBQueryWindow';

export default ABBQueryWindow;
