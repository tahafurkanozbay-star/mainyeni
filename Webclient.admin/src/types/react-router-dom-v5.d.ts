declare module "react-router-dom" {
  import type { ComponentType, ReactNode } from "react";

  export interface RouterProps {
    readonly children?: ReactNode;
  }

  export const HashRouter: ComponentType<RouterProps>;
  export const BrowserRouter: ComponentType<RouterProps>;
  export const Switch: ComponentType<RouterProps>;

  export interface RouteProps {
    readonly path?: string;
    readonly exact?: boolean;
    readonly component?: ComponentType<Record<string, unknown>>;
    readonly children?: ReactNode;
  }

  export const Route: ComponentType<RouteProps>;
}
