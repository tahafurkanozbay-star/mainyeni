declare module 'esri-loader' {
  export interface LoadModulesOptions {
    css?: boolean | string;
    url?: string;
    version?: string;
    insertCssBefore?: string;
    dojoConfig?: Record<string, unknown>;
  }

  export function setDefaultOptions(options?: LoadModulesOptions): void;

  export function loadModules(
    modules: string[],
    options?: LoadModulesOptions,
  ): Promise<any[]>;
}
