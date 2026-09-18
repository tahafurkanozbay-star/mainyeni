import { AppError, isAbortError } from '../errors/appError';

export const BootstrapStage = Object.freeze({
  IDLE: 'idle',
  LOAD: 'load',
  VALIDATE: 'validate',
  PREPARE: 'prepare',
  PROXY: 'proxy',
  COMMIT: 'commit',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
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
  UNEXPECTED: 'BOOTSTRAP_UNEXPECTED',
} as const);

export type BootstrapErrorCodeValue = typeof BootstrapErrorCode[keyof typeof BootstrapErrorCode];
export type MapConfiguration = Readonly<Record<string, unknown>>;
export type ConfigurationService = Readonly<Record<string, unknown>>;

export interface ServiceResult {
  readonly isSuccess?: boolean;
  readonly data?: unknown;
  readonly message?: unknown;
  readonly type?: unknown;
  readonly resultType?: unknown;
}

export interface BootstrapProxyRule {
  readonly url: string;
  readonly source: string;
  readonly serviceIndex: number;
  readonly serviceIdentity: string;
}

export interface BootstrapPlan {
  readonly mapConfiguration: MapConfiguration;
  readonly configurationServices: readonly ConfigurationService[];
  readonly proxyRules: readonly BootstrapProxyRule[];
  readonly summary: Readonly<{
    serviceCount: number;
    proxyRuleCount: number;
  }>;
}

export interface BootstrapResult {
  readonly status: typeof BootstrapStage.COMPLETED;
  readonly durationMs: number;
  readonly mapConfiguration: MapConfiguration;
  readonly configurationServices: readonly ConfigurationService[];
  readonly proxyRuleCount: number;
  readonly serviceCount: number;
}

export interface BootstrapDiagnostics {
  record(event: string, payload?: Readonly<Record<string, unknown>>): void;
}

export interface BootstrapDependencies {
  readonly loadMapConfiguration: (options?: { readonly signal?: AbortSignal }) => Promise<ServiceResult> | ServiceResult;
  readonly loadConfigurationServices: (options?: { readonly signal?: AbortSignal }) => Promise<ServiceResult> | ServiceResult;
  readonly generateServiceUrl: (service: ConfigurationService) => unknown;
  readonly addProxyRule: (url: string, source: string) => Promise<unknown> | unknown;
  readonly setMapConfiguration: (configuration: MapConfiguration) => Promise<unknown> | unknown;
  readonly setConfigurationServices: (services: readonly ConfigurationService[]) => Promise<unknown> | unknown;
}

export interface BootstrapOptions {
  readonly signal?: AbortSignal;
  readonly diagnostics?: BootstrapDiagnostics | null;
}

const DEFAULT_SOURCE = 'ApplicationBootstrap';
const SERVICE_ID_KEYS = Object.freeze(['id', 'Id', 'code', 'Code', 'title', 'Title', 'name', 'Name'] as const);

type AnyFunction = (...args: any[]) => any;

const asFiniteNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const now = (): number => Date.now();

const requiredFunction = <TFunction extends AnyFunction>(
  dependencies: Partial<Record<keyof BootstrapDependencies, unknown>> | null | undefined,
  key: keyof BootstrapDependencies,
): TFunction => {
  const value = dependencies?.[key];
  if (typeof value !== 'function') {
    throw new AppError(`Bootstrap bağımlılığı eksik: ${key}`, {
      code: BootstrapErrorCode.INVALID_DEPENDENCY,
      retryable: false,
      details: { dependency: key },
    });
  }
  return value as TFunction;
};

const createAbortError = (stage: BootstrapStageValue): AppError => new AppError('Uygulama başlatma işlemi iptal edildi.', {
  code: BootstrapErrorCode.ABORTED,
  retryable: true,
  details: { stage },
});

export const throwIfBootstrapAborted = (
  signal?: AbortSignal,
  stage: BootstrapStageValue = BootstrapStage.IDLE,
): void => {
  if (signal?.aborted) throw createAbortError(stage);
};

export const isBootstrapAbortError = (error: unknown): boolean =>
  (error instanceof AppError && error.code === BootstrapErrorCode.ABORTED) || isAbortError(error);

const resultCandidate = (value: unknown): ServiceResult | null =>
  value && typeof value === 'object' ? value as ServiceResult : null;

const normalizeServiceResultError = (
  result: ServiceResult | null,
  code: BootstrapErrorCodeValue,
  fallbackMessage: string,
): AppError => {
  const candidateMessage = typeof result?.message === 'string' ? result.message.trim() : '';
  return new AppError(candidateMessage || fallbackMessage, {
    code,
    retryable: true,
    details: {
      resultType: result?.type ?? result?.resultType ?? null,
    },
  });
};

export const assertSuccessfulServiceResult = (
  result: unknown,
  options: { readonly code?: BootstrapErrorCodeValue; readonly message?: string } = {},
): ServiceResult => {
  const code = options.code ?? BootstrapErrorCode.UNEXPECTED;
  const message = options.message ?? 'Yapılandırma servisi başarısız oldu.';
  const candidate = resultCandidate(result);

  if (!candidate) {
    throw new AppError(message, {
      code,
      retryable: true,
      details: { reason: 'missing-result' },
    });
  }
  if (candidate.isSuccess !== true) throw normalizeServiceResultError(candidate, code, message);
  return candidate;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizeJsonText = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

export const parseMapConfiguration = (result: unknown): MapConfiguration => {
  const successful = assertSuccessfulServiceResult(result, {
    code: BootstrapErrorCode.MAP_REQUEST_FAILED,
    message: 'Harita yapılandırması alınamadı.',
  });
  const data = isPlainObject(successful.data) ? successful.data : null;
  const rawValue = data?.configValue ?? data?.ConfigValue;
  const normalized = normalizeJsonText(rawValue);

  if (normalized === null || normalized === undefined) {
    throw new AppError('Harita yapılandırması boş döndü.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_MISSING,
      retryable: true,
    });
  }
  if (isPlainObject(normalized)) return normalized;
  if (typeof normalized !== 'string') {
    throw new AppError('Harita yapılandırması desteklenmeyen biçimde döndü.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false,
      details: { payloadType: typeof normalized },
    });
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!isPlainObject(parsed)) throw new Error('Map configuration must be an object');
    return Object.freeze({ ...parsed });
  } catch (error) {
    throw new AppError('Harita yapılandırması geçerli JSON değil.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false,
      cause: error,
    });
  }
};

const serviceIdentity = (service: ConfigurationService, index: number): string => {
  for (const key of SERVICE_ID_KEYS) {
    const value = service[key];
    if (value !== null && value !== undefined && String(value).trim()) {
      return `${key.toLowerCase()}:${String(value).trim()}`;
    }
  }
  return `index:${index}`;
};

export const normalizeConfigurationServices = (result: unknown): readonly ConfigurationService[] => {
  const successful = assertSuccessfulServiceResult(result, {
    code: BootstrapErrorCode.SERVICE_REQUEST_FAILED,
    message: 'CBS servis yapılandırması alınamadı.',
  });
  const rawServices = successful.data;
  if (rawServices === null || rawServices === undefined) return Object.freeze([]);
  if (!Array.isArray(rawServices)) {
    throw new AppError('CBS servis yapılandırması liste biçiminde değil.', {
      code: BootstrapErrorCode.SERVICE_PAYLOAD_INVALID,
      retryable: false,
      details: { payloadType: typeof rawServices },
    });
  }

  const seen = new Set<string>();
  const services: ConfigurationService[] = [];
  rawServices.forEach((service, index) => {
    if (!isPlainObject(service)) {
      throw new AppError('CBS servis kaydı nesne biçiminde değil.', {
        code: BootstrapErrorCode.SERVICE_PAYLOAD_INVALID,
        retryable: false,
        details: { index, payloadType: typeof service },
      });
    }
    const frozen = Object.freeze({ ...service });
    const identity = serviceIdentity(frozen, index);
    if (seen.has(identity)) return;
    seen.add(identity);
    services.push(frozen);
  });
  return Object.freeze(services);
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
  options: { readonly allowEmpty?: boolean; readonly serviceIndex?: number | null } = {},
): string | null => {
  const allowEmpty = options.allowEmpty === true;
  const serviceIndex = options.serviceIndex ?? null;
  if (value === null || value === undefined) {
    if (allowEmpty) return null;
    throw new AppError('CBS servis adresi eksik.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex },
    });
  }

  const rawUrl = String(value);
  if (containsControlCharacter(rawUrl)) {
    throw new AppError('CBS servis adresi geçersiz karakter içeriyor.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex },
    });
  }
  const url = rawUrl.trim();
  if (!url) {
    if (allowEmpty) return null;
    throw new AppError('CBS servis adresi eksik.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex },
    });
  }
  return url;
};

export const createBootstrapPlan = (input: {
  readonly mapConfiguration: unknown;
  readonly configurationServices: unknown;
  readonly generateServiceUrl: unknown;
}): BootstrapPlan => {
  const { mapConfiguration, configurationServices, generateServiceUrl } = input;
  if (!isPlainObject(mapConfiguration)) {
    throw new AppError('Harita yapılandırması hazırlanamadı.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false,
    });
  }
  if (!Array.isArray(configurationServices)) {
    throw new AppError('CBS servis listesi hazırlanamadı.', {
      code: BootstrapErrorCode.SERVICE_PAYLOAD_INVALID,
      retryable: false,
    });
  }
  if (typeof generateServiceUrl !== 'function') {
    throw new AppError('CBS servis adresi üreticisi tanımlı değil.', {
      code: BootstrapErrorCode.INVALID_DEPENDENCY,
      retryable: false,
      details: { dependency: 'generateServiceUrl' },
    });
  }

  const proxyRules: BootstrapProxyRule[] = [];
  const seenUrls = new Set<string>();
  const typedServices = configurationServices as ConfigurationService[];
  typedServices.forEach((service, index) => {
    const url = normalizeProxyUrl((generateServiceUrl as (service: ConfigurationService) => unknown)(service), { serviceIndex: index });
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    proxyRules.push(Object.freeze({
      url,
      source: DEFAULT_SOURCE,
      serviceIndex: index,
      serviceIdentity: serviceIdentity(service, index),
    }));
  });

  const frozenServices = Object.freeze([...typedServices]);
  return Object.freeze({
    mapConfiguration: Object.freeze({ ...mapConfiguration }),
    configurationServices: frozenServices,
    proxyRules: Object.freeze(proxyRules),
    summary: Object.freeze({ serviceCount: frozenServices.length, proxyRuleCount: proxyRules.length }),
  });
};

const emit = (
  diagnostics: BootstrapDiagnostics | null | undefined,
  event: string,
  payload: Readonly<Record<string, unknown>> = {},
): void => {
  if (!diagnostics || typeof diagnostics.record !== 'function') return;
  diagnostics.record(event, payload);
};

const emitStage = (
  diagnostics: BootstrapDiagnostics | null | undefined,
  stage: BootstrapStageValue,
  payload: Readonly<Record<string, unknown>> = {},
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
    details: { stage },
  });
};

const runProxySetup = async (input: {
  readonly plan: BootstrapPlan;
  readonly addProxyRule: BootstrapDependencies['addProxyRule'];
  readonly signal?: AbortSignal;
  readonly diagnostics?: BootstrapDiagnostics | null;
}): Promise<void> => {
  emitStage(input.diagnostics, BootstrapStage.PROXY, { proxyRuleCount: input.plan.proxyRules.length });
  for (const rule of input.plan.proxyRules) {
    throwIfBootstrapAborted(input.signal, BootstrapStage.PROXY);
    await input.addProxyRule(rule.url, rule.source);
    emit(input.diagnostics, 'bootstrap.proxy.ready', {
      serviceIndex: rule.serviceIndex,
      serviceIdentity: rule.serviceIdentity,
    });
  }
};

const commitPlan = async (input: {
  readonly plan: BootstrapPlan;
  readonly setMapConfiguration: BootstrapDependencies['setMapConfiguration'];
  readonly setConfigurationServices: BootstrapDependencies['setConfigurationServices'];
  readonly signal?: AbortSignal;
  readonly diagnostics?: BootstrapDiagnostics | null;
}): Promise<void> => {
  emitStage(input.diagnostics, BootstrapStage.COMMIT, input.plan.summary);
  throwIfBootstrapAborted(input.signal, BootstrapStage.COMMIT);
  await input.setMapConfiguration(input.plan.mapConfiguration);
  throwIfBootstrapAborted(input.signal, BootstrapStage.COMMIT);
  await input.setConfigurationServices(input.plan.configurationServices);
};

export const runApplicationBootstrap = async (
  dependencies: Partial<BootstrapDependencies> = {},
  options: BootstrapOptions = {},
): Promise<BootstrapResult> => {
  const loadMapConfiguration = requiredFunction<BootstrapDependencies['loadMapConfiguration']>(dependencies, 'loadMapConfiguration');
  const loadConfigurationServices = requiredFunction<BootstrapDependencies['loadConfigurationServices']>(dependencies, 'loadConfigurationServices');
  const generateServiceUrl = requiredFunction<BootstrapDependencies['generateServiceUrl']>(dependencies, 'generateServiceUrl');
  const addProxyRule = requiredFunction<BootstrapDependencies['addProxyRule']>(dependencies, 'addProxyRule');
  const setMapConfiguration = requiredFunction<BootstrapDependencies['setMapConfiguration']>(dependencies, 'setMapConfiguration');
  const setConfigurationServices = requiredFunction<BootstrapDependencies['setConfigurationServices']>(dependencies, 'setConfigurationServices');

  const { signal, diagnostics } = options;
  const startedAt = now();
  let stage: BootstrapStageValue = BootstrapStage.LOAD;
  emit(diagnostics, 'bootstrap.started', { startedAt });
  emitStage(diagnostics, stage);

  try {
    throwIfBootstrapAborted(signal, stage);
    const loadOptions = signal === undefined ? {} : { signal };
    const [mapResult, servicesResult] = await Promise.all([
      loadMapConfiguration(loadOptions),
      loadConfigurationServices(loadOptions),
    ]);

    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.VALIDATE;
    emitStage(diagnostics, stage);
    const mapConfiguration = parseMapConfiguration(mapResult);
    const configurationServices = normalizeConfigurationServices(servicesResult);

    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.PREPARE;
    emitStage(diagnostics, stage, { serviceCount: configurationServices.length });
    const plan = createBootstrapPlan({ mapConfiguration, configurationServices, generateServiceUrl });

    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.PROXY;
    await runProxySetup({
      plan,
      addProxyRule,
      ...(signal === undefined ? {} : { signal }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });

    stage = BootstrapStage.COMMIT;
    await commitPlan({
      plan,
      setMapConfiguration,
      setConfigurationServices,
      ...(signal === undefined ? {} : { signal }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });

    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.COMPLETED;
    const durationMs = Math.max(0, now() - startedAt);
    const result: BootstrapResult = Object.freeze({
      status: BootstrapStage.COMPLETED,
      durationMs,
      mapConfiguration: plan.mapConfiguration,
      configurationServices: plan.configurationServices,
      proxyRuleCount: plan.proxyRules.length,
      serviceCount: plan.configurationServices.length,
    });
    emitStage(diagnostics, stage, { durationMs, serviceCount: result.serviceCount, proxyRuleCount: result.proxyRuleCount });
    emit(diagnostics, 'bootstrap.completed', result as unknown as Readonly<Record<string, unknown>>);
    return result;
  } catch (error) {
    const normalized = wrapUnexpectedError(error, stage);
    const aborted = isBootstrapAbortError(normalized);
    const finalStage = aborted ? BootstrapStage.CANCELLED : BootstrapStage.FAILED;
    const durationMs = Math.max(0, now() - startedAt);
    emitStage(diagnostics, finalStage, {
      durationMs,
      failedStage: stage,
      errorCode: normalized.code || BootstrapErrorCode.UNEXPECTED,
    });
    emit(diagnostics, aborted ? 'bootstrap.cancelled' : 'bootstrap.failed', {
      durationMs,
      failedStage: stage,
      errorCode: normalized.code || BootstrapErrorCode.UNEXPECTED,
      retryable: normalized.retryable === true,
    });
    throw normalized;
  }
};

export const createBootstrapDependencies = (
  dependencies: Partial<BootstrapDependencies> = {},
): BootstrapDependencies => ({
  loadMapConfiguration: requiredFunction(dependencies, 'loadMapConfiguration'),
  loadConfigurationServices: requiredFunction(dependencies, 'loadConfigurationServices'),
  generateServiceUrl: requiredFunction(dependencies, 'generateServiceUrl'),
  addProxyRule: requiredFunction(dependencies, 'addProxyRule'),
  setMapConfiguration: requiredFunction(dependencies, 'setMapConfiguration'),
  setConfigurationServices: requiredFunction(dependencies, 'setConfigurationServices'),
});

export const bootstrapDurationBucket = (durationMs: unknown): string => {
  const value = Math.max(0, asFiniteNumber(durationMs));
  if (value < 250) return 'lt-250ms';
  if (value < 1000) return '250ms-1s';
  if (value < 3000) return '1s-3s';
  if (value < 10000) return '3s-10s';
  return 'gte-10s';
};
