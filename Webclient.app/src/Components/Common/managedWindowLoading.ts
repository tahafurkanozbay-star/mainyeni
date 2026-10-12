import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { withTimeout } from '../../platform/runtime/resilience';

export type ManagedComponent = LazyExoticComponent<ComponentType<Record<string, unknown>>>;
export type ManagedModuleLoader = () => Promise<Readonly<Record<string, unknown>>>;

export const createManagedWindowComponent = (
  loader: ManagedModuleLoader,
  exportName: string,
  timeoutMs = 20_000,
): ManagedComponent => lazy(async () => {
  const module = await withTimeout(loader, timeoutMs);
  const component = module[exportName];
  if (!component || (typeof component !== 'function' && typeof component !== 'object')) {
    throw new TypeError('Araç arayüzü yüklenemedi.');
  }
  return { default: component as ComponentType<Record<string, unknown>> };
});

export interface ManagedWindowDefinition {
  readonly id: string;
  readonly label: string;
  readonly component: ManagedComponent;
  readonly createComponent: () => ManagedComponent;
}

export const defineManagedWindow = (
  id: string,
  label: string,
  loader: ManagedModuleLoader,
  exportName: string,
): ManagedWindowDefinition => {
  const createComponent = (): ManagedComponent => createManagedWindowComponent(loader, exportName);
  return Object.freeze({ id, label, component: createComponent(), createComponent });
};
