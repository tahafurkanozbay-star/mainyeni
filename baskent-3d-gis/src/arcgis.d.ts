export {};

declare global {
  const $arcgis: {
    import<T = unknown>(moduleId: string): Promise<T>;
  };
}
