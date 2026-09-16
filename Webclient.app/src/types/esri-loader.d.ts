declare module 'esri-loader' {
  export interface LoadModulesOptions {
    css?: boolean | string;
    url?: string;
    dojoConfig?: Record<string, unknown>;
  }

  export function loadModules(
    modules: string[],
    options?: LoadModulesOptions,
  ): Promise<any[]>;
}
