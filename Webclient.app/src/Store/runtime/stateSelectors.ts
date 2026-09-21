import type { ServiceDescriptor } from '../../Business/contracts';
import type { RootState, WindowRegistration } from '../contracts';

export interface MapRuntimeSummary {
  readonly hasView: boolean;
  readonly updating: boolean;
  readonly graphicsCount: number;
  readonly mobileRightClickEnabled: boolean;
}

export interface DynamicLayerRuntimeSummary {
  readonly count: number;
  readonly empty: boolean;
}

export const selectWindows = (state: RootState): readonly WindowRegistration[] =>
  state.Common.WindowList;

export const selectVisibleWindows = (state: RootState): readonly WindowRegistration[] =>
  state.Common.WindowList.filter((item) => item.visible === true);

export const selectActiveWindow = (state: RootState): WindowRegistration | null =>
  state.Common.WindowList.find((item) => item.visible === true) ?? null;

export const selectMessage = (state: RootState) => state.Common.Message;

export const selectConfigurationServices = (
  state: RootState,
): readonly ServiceDescriptor[] => state.Common.ConfigurationServices ?? [];

export const selectMapRuntimeSummary = (
  state: RootState,
): MapRuntimeSummary => Object.freeze({
  hasView: state.Map.MapView !== null && state.Map.MapView !== undefined,
  updating: state.Map.IsUpdating === true,
  graphicsCount: state.Map.Graphics.length,
  mobileRightClickEnabled: state.Map.MobileRightClickEnabled === true,
});

export const selectDynamicLayerRuntimeSummary = (
  state: RootState,
): DynamicLayerRuntimeSummary => Object.freeze({
  count: state.DynamicLayers.List.length,
  empty: state.DynamicLayers.List.length === 0,
});

export const createWindowSelector = (
  windowIdInput: string,
): ((state: RootState) => WindowRegistration | null) => {
  const windowId = String(windowIdInput ?? '').trim();
  return (state) => state.Common.WindowList.find((item) => item.id === windowId) ?? null;
};

export const createServiceSelector = (
  serviceKeyInput: string,
): ((state: RootState) => ServiceDescriptor | null) => {
  const serviceKey = String(serviceKeyInput ?? '').trim().toLowerCase();
  return (state) => {
    const services = state.Common.ConfigurationServices ?? [];
    for (const service of services) {
      const record = service as Readonly<Record<string, unknown>>;
      const values = [record.key, record.id, record.name, record.title, record.Title]
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean);
      if (values.includes(serviceKey)) return service;
    }
    return null;
  };
};

export const createSingleEntrySelector = <TSelected>(
  selector: (state: RootState) => TSelected,
): ((state: RootState) => TSelected) => {
  let previousState: RootState | null = null;
  let previousSelected: TSelected | undefined;
  return (state) => {
    if (previousState === state && previousSelected !== undefined) return previousSelected;
    previousState = state;
    previousSelected = selector(state);
    return previousSelected;
  };
};
