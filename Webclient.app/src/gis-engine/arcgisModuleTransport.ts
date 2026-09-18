import type { ArcgisModuleTransport } from './arcgisModuleRuntime';

const validateModuleIds = (moduleIdsInput: readonly string[]): readonly string[] => {
  if (!Array.isArray(moduleIdsInput)) {
    throw new TypeError('ArcGIS module transport batch must be an array.');
  }
  const moduleIds = moduleIdsInput.map((moduleIdInput) => {
    const moduleId = String(moduleIdInput ?? '').trim();
    if (!moduleId) throw new Error('ArcGIS module id is required.');
    return moduleId;
  });
  return Object.freeze(moduleIds);
};

/**
 * The only production boundary allowed to invoke a transport's low-level
 * module acquisition hook. Runtime/cache consumers call this helper instead of
 * reaching through the transport object directly.
 */
export const invokeArcgisModuleTransportBatch = async (
  transport: ArcgisModuleTransport,
  moduleIdsInput: readonly string[],
): Promise<readonly unknown[]> => {
  if (!transport || typeof transport.loadModules !== 'function') {
    throw new TypeError('ArcGIS module transport does not provide a batch loader.');
  }
  const moduleIds = validateModuleIds(moduleIdsInput);
  if (moduleIds.length === 0) return Object.freeze([]);
  return transport.loadModules(moduleIds);
};
