export interface OwnedArcgisWidgetHost {
  readonly container: HTMLDivElement;
  readonly dispose: () => void;
}

/** ArcGIS Widget.destroy removes its container. Give it a child React does not own. */
export const createArcgisWidgetHost = (parent: HTMLElement, id?: string): OwnedArcgisWidgetHost => {
  const container = parent.ownerDocument.createElement('div');
  if (id) container.id = id;
  parent.appendChild(container);
  return Object.freeze({ container, dispose: () => container.remove() });
};
