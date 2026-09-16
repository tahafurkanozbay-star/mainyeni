import { AppError, isAbortError } from '../errors/appError';
import type { BootstrapDiagnostics } from './bootstrapDiagnostics';

export const BootstrapStage = Object.freeze({
  IDLE: 'idle', LOAD: 'load', VALIDATE: 'validate', PREPARE: 'prepare',
  PROXY: 'proxy', COMMIT: 'commit', COMPLETED: 'completed', CANCELLED: 'cancelled', FAILED: 'failed'
} as const);

export type BootstrapStageValue = typeof BootstrapStage[keyof typeof BootstrapStage];

export const BootstrapErrorCode = Object.freeze({
  INVALID_DEPENDENCY: 'BOOTSTRAP_INVALID_DEPENDENCY',
  MAP_REQUEST_FAILED: 'BOOTSTRAP_MAP_REQUEST_FAILED',
  SERVICE_REQUEST_FAILED: 'BOOTSTRAP_SERVICE_REQUEST_FAILED',
  MAP_PAYLOAD_MISSING: 'BOOTSTRAP_MAP_PAYLOAD_MISSING',
  MAP_PAYLOAD_INVALID: 'BOOTSTRAP_MAP_PAYLOAD_INVALID',
  SERVICE_PAYLOAD_INVALID: 'BOOTSTRAP_SERVICE_PAYLOAD_INVALID',
  SERVICE_URL_INVALID: 'BOOTSTRAP_SERVICE_URL_INVALID',
  PROXY_SETUP_FAILED: 'BOOTSTRAP_PROXY_SETUP_FAILED',
  COMMIT_FAILED: 'BOOTSTRAP_COMMIT_FAILED',
  ABORTED: 'BOOTSTRAP_ABORTED',
  UNEXPECTED: 'BOOTSTRAP_UNEXPECTED'
} as const);

export type BootstrapErrorCodeValue = typeof BootstrapErrorCode[keyof typeof BootstrapErrorCode];
export type PlainRecord = Record<string, unknown>;

export interface ServiceResult<T = unknown> {
  readonly isSuccess?: boolean;
  readonly data?: T;
  readonly message?: string;
  readonly type?: unknown;
  readonly resultType?: unknown;
}

export interface BootstrapDependencies {
  loadMapConfiguration(options: { signal?: AbortSignal }): Promise<ServiceResult>;
  loadConfigurationServices(options: { signal?: AbortSignal }): Promise<ServiceResult>;
  generateServiceUrl(service: PlainRecord): unknown;
  addProxyRule(url: string, source: string): void | Promise<void>;
  setMapConfiguration(configuration: PlainRecord): void | Promise<void>;
  setConfigurationServices(services: readonly PlainRecord[]): void | Promise<void>;
}

export interface BootstrapPlan {
  readonly mapConfiguration: PlainRecord;
  readonly configurationServices: readonly PlainRecord[];
  readonly proxyRules: readonly Readonly<{
    url: string;
    source: string;
    serviceIndex: number;
    serviceIdentity: string;
  }>[];
  readonly summary: Readonly<{ serviceCount: number; proxyRuleCount: number }>;
}

export interface BootstrapRunOptions {
  signal?: AbortSignal;
  diagnostics?: Pick<BootstrapDiagnostics, 'record'>;
}

export interface BootstrapResult {
  readonly status: typeof BootstrapStage.COMPLETED;
  readonly durationMs: number;
  readonly mapConfiguration: PlainRecord;
  readonly configurationServices: readonly PlainRecord[];
  readonly proxyRuleCount: number;
  readonly serviceCount: number;
}

const DEFAULT_SOURCE = 'ApplicationBootstrap';
const SERVICE_ID_KEYS = ['id', 'Id', 'code', 'Code', 'title', 'Title', 'name', 'Name'] as const;
const now = (): number => Date.now();
const isPlainObject = (value: unknown): value is PlainRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const requiredFunction = <K extends keyof BootstrapDependencies>(
  dependencies: Partial<BootstrapDependencies>,
  key: K
): BootstrapDependencies[K] => {
  const value = dependencies?.[key];
  if (typeof value !== 'function') {
    throw new AppError(`Bootstrap bağımlılığı eksik: ${String(key)}`, {
      code: BootstrapErrorCode.INVALID_DEPENDENCY,
      retryable: false,
      details: { dependency: key }
    });
  }
  return value as BootstrapDependencies[K];
};

const createAbortError = (stage: BootstrapStageValue): AppError => new AppError(
  'Uygulama başlatma işlemi iptal edildi.',
  { code: BootstrapErrorCode.ABORTED, retryable: true, details: { stage } }
);

export const throwIfBootstrapAborted = (
  signal?: AbortSignal,
  stage: BootstrapStageValue = BootstrapStage.IDLE
): void => {
  if (signal?.aborted) throw createAbortError(stage);
};

export const isBootstrapAbortError = (error: unknown): boolean =>
  (error instanceof AppError && error.code === BootstrapErrorCode.ABORTED) || isAbortError(error);

const normalizeServiceResultError = (
  result: ServiceResult,
  code: BootstrapErrorCodeValue,
  fallbackMessage: string
): AppError => {
  const message = typeof result?.message === 'string' && result.message.trim()
    ? result.message.trim().slice(0, 240)
    : fallbackMessage;
  return new AppError(message, {
    code,
    retryable: true,
    details: { resultType: result?.type ?? result?.resultType ?? null }
  });
};

export const assertSuccessfulServiceResult = <T = unknown>(
  result: ServiceResult<T> | null | undefined,
  options: { code?: BootstrapErrorCodeValue; message?: string } = {}
): ServiceResult<T> => {
  const code = options.code || BootstrapErrorCode.UNEXPECTED;
  const message = options.message || 'Yapılandırma servisi başarısız oldu.';
  if (!result || typeof result !== 'object') {
    throw new AppError(message, { code, retryable: true, details: { reason: 'missing-result' } });
  }
  if (result.isSuccess !== true) throw normalizeServiceResultError(result, code, message);
  return result;
};

const normalizeJsonText = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

export const parseMapConfiguration = (result: ServiceResult): PlainRecord => {
  const successful = assertSuccessfulServiceResult(result, {
    code: BootstrapErrorCode.MAP_REQUEST_FAILED,
    message: 'Harita yapılandırması alınamadı.'
  });
  const data = isPlainObject(successful.data) ? successful.data : null;
  const rawValue = data?.configValue ?? data?.ConfigValue;
  const normalized = normalizeJsonText(rawValue);
  if (normalized === null || normalized === undefined) {
    throw new AppError('Harita yapılandırması boş döndü.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_MISSING,
      retryable: true
    });
  }
  if (isPlainObject(normalized)) return normalized;
  if (typeof normalized !== 'string') {
    throw new AppError('Harita yapılandırması desteklenmeyen biçimde döndü.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false,
      details: { payloadType: typeof normalized }
    });
  }
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!isPlainObject(parsed)) throw new Error('Map configuration must be an object');
    return parsed;
  } catch (error) {
    throw new AppError('Harita yapılandırması geçerli JSON değil.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false,
      cause: error
    });
  }
};

const serviceIdentity = (service: PlainRecord, index: number): string => {
  for (const key of SERVICE_ID_KEYS) {
    const value = service[key];
    if (value !== null && value !== undefined && String(value).trim()) {
      return `${key.toLowerCase()}:${String(value).trim().slice(0, 160)}`;
    }
  }
  return `index:${index}`;
};

export const normalizeConfigurationServices = (result: ServiceResult): PlainRecord[] => {
  const successful = assertSuccessfulServiceResult(result, {
    code: BootstrapErrorCode.SERVICE_REQUEST_FAILED,
    message: 'CBS servis yapılandırması alınamadı.'
  });
  const rawServices = successful.data;
  if (rawServices === null || rawServices === undefined) return [];
  if (!Array.isArray(rawServices)) {
    throw new AppError('CBS servis yapılandırması liste biçiminde değil.', {
      code: BootstrapErrorCode.SERVICE_PAYLOAD_INVALID,
      retryable: false,
      details: { payloadType: typeof rawServices }
    });
  }
  const seen = new Set<string>();
  const services: PlainRecord[] = [];
  rawServices.forEach((service, index) => {
    if (!isPlainObject(service)) {
      throw new AppError('CBS servis kaydı nesne biçiminde değil.', {
        code: BootstrapErrorCode.SERVICE_PAYLOAD_INVALID,
        retryable: false,
        details: { index, payloadType: typeof service }
      });
    }
    const identity = serviceIdentity(service, index);
    if (seen.has(identity)) return;
    seen.add(identity);
    services.push(service);
  });
  return services;
};

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

export const normalizeProxyUrl = (
  value: unknown,
  options: { allowEmpty?: boolean; serviceIndex?: number | null } = {}
): string | null => {
  const allowEmpty = options.allowEmpty === true;
  const serviceIndex = options.serviceIndex ?? null;
  if (value === null || value === undefined) {
    if (allowEmpty) return null;
    throw new AppError('CBS servis adresi eksik.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex }
    });
  }
  const rawUrl = String(value);
  if (containsControlCharacter(rawUrl)) {
    throw new AppError('CBS servis adresi geçersiz karakter içeriyor.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex }
    });
  }
  const url = rawUrl.trim();
  if (!url) {
    if (allowEmpty) return null;
    throw new AppError('CBS servis adresi eksik.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex }
    });
  }
  return url;
};

export const createBootstrapPlan = (input: {
  mapConfiguration: PlainRecord;
  configurationServices: readonly PlainRecord[];
  generateServiceUrl: (service: PlainRecord) => unknown;
}): BootstrapPlan => {
  if (!isPlainObject(input.mapConfiguration)) {
    throw new AppError('Harita yapılandırması hazırlanamadı.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false
    });
  }
  if (!Array.isArray(input.configurationServices)) {
    throw new AppError('CBS servis listesi hazırlanamadı.', {
      code: BootstrapErrorCode.SERVICE_PAYLOAD_INVALID,
      retryable: false
    });
  }
  if (typeof input.generateServiceUrl !== 'function') {
    throw new AppError('CBS servis adresi üreticisi tanımlı değil.', {
      code: BootstrapErrorCode.INVALID_DEPENDENCY,
      retryable: false,
      details: { dependency: 'generateServiceUrl' }
    });
  }

  const proxyRules: BootstrapPlan['proxyRules'][number][] = [];
  const seenUrls = new Set<string>();
  input.configurationServices.forEach((service, index) => {
    const url = normalizeProxyUrl(input.generateServiceUrl(service), { serviceIndex: index });
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    proxyRules.push(Object.freeze({
      url,
      source: DEFAULT_SOURCE,
      serviceIndex: index,
      serviceIdentity: serviceIdentity(service, index)
    }));
  });

  return Object.freeze({
    mapConfiguration: input.mapConfiguration,
    configurationServices: Object.freeze([...input.configurationServices]),
    proxyRules: Object.freeze(proxyRules),
    summary: Object.freeze({
      serviceCount: input.configurationServices.length,
      proxyRuleCount: proxyRules.length
    })
  });
};

const emit = (diagnostics: BootstrapRunOptions['diagnostics'], event: string, payload: unknown = {}): void => {
  if (!diagnostics || typeof diagnostics.record !== 'function') return;
  diagnostics.record(event, payload);
};

const emitStage = (
  diagnostics: BootstrapRunOptions['diagnostics'],
  stage: BootstrapStageValue,
  payload: PlainRecord = {}
): void => emit(diagnostics, 'bootstrap.stage', { stage, ...payload });

const wrapUnexpectedError = (error: unknown, stage: BootstrapStageValue): AppError => {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) return createAbortError(stage);
  const code = stage === BootstrapStage.PROXY
    ? BootstrapErrorCode.PROXY_SETUP_FAILED
    : stage === BootstrapStage.COMMIT
      ? BootstrapErrorCode.COMMIT_FAILED
      : BootstrapErrorCode.UNEXPECTED;
  return new AppError('Uygulama yapılandırması tamamlanamadı.', {
    code,
    retryable: true,
    cause: error,
    details: { stage }
  });
};

const runProxySetup = async (
  plan: BootstrapPlan,
  addProxyRule: BootstrapDependencies['addProxyRule'],
  signal: AbortSignal | undefined,
  diagnostics: BootstrapRunOptions['diagnostics']
): Promise<void> => {
  emitStage(diagnostics, BootstrapStage.PROXY, { proxyRuleCount: plan.proxyRules.length });
  for (const rule of plan.proxyRules) {
    throwIfBootstrapAborted(signal, BootstrapStage.PROXY);
    await addProxyRule(rule.url, rule.source);
    emit(diagnostics, 'bootstrap.proxy.ready', {
      serviceIndex: rule.serviceIndex,
      serviceIdentity: rule.serviceIdentity
    });
  }
};

export const runApplicationBootstrap = async (
  dependencies: Partial<BootstrapDependencies> = {},
  options: BootstrapRunOptions = {}
): Promise<BootstrapResult> => {
  const loadMapConfiguration = requiredFunction(dependencies, 'loadMapConfiguration');
  const loadConfigurationServices = requiredFunction(dependencies, 'loadConfigurationServices');
  const generateServiceUrl = requiredFunction(dependencies, 'generateServiceUrl');
  const addProxyRule = requiredFunction(dependencies, 'addProxyRule');
  const setMapConfiguration = requiredFunction(dependencies, 'setMapConfiguration');
  const setConfigurationServices = requiredFunction(dependencies, 'setConfigurationServices');
  const signal = options.signal;
  const diagnostics = options.diagnostics;
  const startedAt = now();
  let stage: BootstrapStageValue = BootstrapStage.LOAD;
  emit(diagnostics, 'bootstrap.started', { startedAt });
  emitStage(diagnostics, stage);

  try {
    throwIfBootstrapAborted(signal, stage);
    const [mapResult, servicesResult] = await Promise.all([
      loadMapConfiguration({ signal }),
      loadConfigurationServices({ signal })
    ]);
    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.VALIDATE;
    emitStage(diagnostics, stage);
    const mapConfiguration = parseMapConfiguration(mapResult);
    const configurationServices = normalizeConfigurationServices(servicesResult);

    stage = BootstrapStage.PREPARE;
    emitStage(diagnostics, stage, { serviceCount: configurationServices.length });
    const plan = createBootstrapPlan({ mapConfiguration, configurationServices, generateServiceUrl });

    stage = BootstrapStage.PROXY;
    await runProxySetup(plan, addProxyRule, signal, diagnostics);
    stage = BootstrapStage.COMMIT;
    emitStage(diagnostics, stage, plan.summary as PlainRecord);
    throwIfBootstrapAborted(signal, stage);
    await setMapConfiguration(plan.mapConfiguration);
    throwIfBootstrapAborted(signal, stage);
    await setConfigurationServices(plan.configurationServices);
    throwIfBootstrapAborted(signal, stage);

    stage = BootstrapStage.COMPLETED;
    const durationMs = Math.max(0, now() - startedAt);
    const result: BootstrapResult = Object.freeze({
      status: BootstrapStage.COMPLETED,
      durationMs,
      mapConfiguration: plan.mapConfiguration,
      configurationServices: plan.configurationServices,
      proxyRuleCount: plan.proxyRules.length,
      serviceCount: plan.configurationServices.length
    });
    emitStage(diagnostics, stage, {
      durationMs,
      serviceCount: result.serviceCount,
      proxyRuleCount: result.proxyRuleCount
    });
    emit(diagnostics, 'bootstrap.completed', result);
    return result;
  } catch (error) {
    const normalized = wrapUnexpectedError(error, stage);
    const aborted = isBootstrapAbortError(normalized);
    const finalStage = aborted ? BootstrapStage.CANCELLED : BootstrapStage.FAILED;
    const durationMs = Math.max(0, now() - startedAt);
    emitStage(diagnostics, finalStage, {
      durationMs,
      failedStage: stage,
      errorCode: normalized.code || BootstrapErrorCode.UNEXPECTED
    });
    emit(diagnostics, aborted ? 'bootstrap.cancelled' : 'bootstrap.failed', {
      durationMs,
      failedStage: stage,
      errorCode: normalized.code || BootstrapErrorCode.UNEXPECTED,
      retryable: normalized.retryable === true
    });
    throw normalized;
  }
};

export const createBootstrapDependencies = (
  dependencies: Partial<BootstrapDependencies> = {}
): BootstrapDependencies => Object.freeze({
  loadMapConfiguration: requiredFunction(dependencies, 'loadMapConfiguration'),
  loadConfigurationServices: requiredFunction(dependencies, 'loadConfigurationServices'),
  generateServiceUrl: requiredFunction(dependencies, 'generateServiceUrl'),
  addProxyRule: requiredFunction(dependencies, 'addProxyRule'),
  setMapConfiguration: requiredFunction(dependencies, 'setMapConfiguration'),
  setConfigurationServices: requiredFunction(dependencies, 'setConfigurationServices')
});

export const bootstrapDurationBucket = (durationMs: unknown): string => {
  const value = Math.max(0, asFiniteNumber(durationMs));
  if (value < 250) return 'lt-250ms';
  if (value < 1000) return '250ms-1s';
  if (value < 3000) return '1s-3s';
  if (value < 10000) return '3s-10s';
  return 'gte-10s';
};
