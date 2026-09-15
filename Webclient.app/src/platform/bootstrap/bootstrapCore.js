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
  FAILED: 'failed'
});

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
});

const DEFAULT_SOURCE = 'ApplicationBootstrap';
const SERVICE_ID_KEYS = ['id', 'Id', 'code', 'Code', 'title', 'Title', 'name', 'Name'];

const asFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const now = () => Date.now();

const requiredFunction = (dependencies, key) => {
  const value = dependencies?.[key];
  if (typeof value !== 'function') {
    throw new AppError(`Bootstrap bağımlılığı eksik: ${key}`, {
      code: BootstrapErrorCode.INVALID_DEPENDENCY,
      retryable: false,
      details: { dependency: key }
    });
  }
  return value;
};

const createAbortError = (stage) => new AppError('Uygulama başlatma işlemi iptal edildi.', {
  code: BootstrapErrorCode.ABORTED,
  retryable: true,
  details: { stage }
});

export const throwIfBootstrapAborted = (signal, stage = BootstrapStage.IDLE) => {
  if (signal?.aborted) throw createAbortError(stage);
};

export const isBootstrapAbortError = (error) =>
  error?.code === BootstrapErrorCode.ABORTED || isAbortError(error);

const normalizeServiceResultError = (result, code, fallbackMessage) => {
  const message = typeof result?.message === 'string' && result.message.trim()
    ? result.message.trim()
    : fallbackMessage;

  return new AppError(message, {
    code,
    retryable: true,
    details: {
      resultType: result?.type ?? result?.resultType ?? null
    }
  });
};

export const assertSuccessfulServiceResult = (result, options = {}) => {
  const {
    code = BootstrapErrorCode.UNEXPECTED,
    message = 'Yapılandırma servisi başarısız oldu.'
  } = options;

  if (!result || typeof result !== 'object') {
    throw new AppError(message, {
      code,
      retryable: true,
      details: { reason: 'missing-result' }
    });
  }

  if (result.isSuccess !== true) {
    throw normalizeServiceResultError(result, code, message);
  }

  return result;
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeJsonText = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

export const parseMapConfiguration = (result) => {
  const successful = assertSuccessfulServiceResult(result, {
    code: BootstrapErrorCode.MAP_REQUEST_FAILED,
    message: 'Harita yapılandırması alınamadı.'
  });

  const rawValue = successful?.data?.configValue ?? successful?.data?.ConfigValue;
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
    const parsed = JSON.parse(normalized);
    if (!isPlainObject(parsed)) {
      throw new Error('Map configuration must be an object');
    }
    return parsed;
  } catch (error) {
    throw new AppError('Harita yapılandırması geçerli JSON değil.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false,
      cause: error
    });
  }
};

const serviceIdentity = (service, index) => {
  for (const key of SERVICE_ID_KEYS) {
    const value = service?.[key];
    if (value !== null && value !== undefined && String(value).trim()) {
      return `${key.toLowerCase()}:${String(value).trim()}`;
    }
  }
  return `index:${index}`;
};

export const normalizeConfigurationServices = (result) => {
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

  const seen = new Set();
  const services = [];

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

export const normalizeProxyUrl = (value, options = {}) => {
  const { allowEmpty = false, serviceIndex = null } = options;

  if (value === null || value === undefined || String(value).trim() === '') {
    if (allowEmpty) return null;
    throw new AppError('CBS servis adresi eksik.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex }
    });
  }

  const url = String(value).trim();
  if (/^[\u0000-\u001F\u007F]/.test(url) || /[\r\n]/.test(url)) {
    throw new AppError('CBS servis adresi geçersiz karakter içeriyor.', {
      code: BootstrapErrorCode.SERVICE_URL_INVALID,
      retryable: false,
      details: { serviceIndex }
    });
  }

  return url;
};

export const createBootstrapPlan = ({
  mapConfiguration,
  configurationServices,
  generateServiceUrl
}) => {
  if (!isPlainObject(mapConfiguration)) {
    throw new AppError('Harita yapılandırması hazırlanamadı.', {
      code: BootstrapErrorCode.MAP_PAYLOAD_INVALID,
      retryable: false
    });
  }

  if (!Array.isArray(configurationServices)) {
    throw new AppError('CBS servis listesi hazırlanamadı.', {
      code: BootstrapErrorCode.SERVICE_PAYLOAD_INVALID,
      retryable: false
    });
  }

  if (typeof generateServiceUrl !== 'function') {
    throw new AppError('CBS servis adresi üreticisi tanımlı değil.', {
      code: BootstrapErrorCode.INVALID_DEPENDENCY,
      retryable: false,
      details: { dependency: 'generateServiceUrl' }
    });
  }

  const proxyRules = [];
  const seenUrls = new Set();

  configurationServices.forEach((service, index) => {
    const url = normalizeProxyUrl(generateServiceUrl(service), { serviceIndex: index });
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    proxyRules.push({
      url,
      source: DEFAULT_SOURCE,
      serviceIndex: index,
      serviceIdentity: serviceIdentity(service, index)
    });
  });

  return Object.freeze({
    mapConfiguration,
    configurationServices: Object.freeze([...configurationServices]),
    proxyRules: Object.freeze(proxyRules),
    summary: Object.freeze({
      serviceCount: configurationServices.length,
      proxyRuleCount: proxyRules.length
    })
  });
};

const emit = (diagnostics, event, payload = {}) => {
  if (!diagnostics || typeof diagnostics.record !== 'function') return;
  diagnostics.record(event, payload);
};

const emitStage = (diagnostics, stage, payload = {}) =>
  emit(diagnostics, 'bootstrap.stage', { stage, ...payload });

const wrapUnexpectedError = (error, stage) => {
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

const runProxySetup = async ({ plan, addProxyRule, signal, diagnostics }) => {
  emitStage(diagnostics, BootstrapStage.PROXY, {
    proxyRuleCount: plan.proxyRules.length
  });

  for (const rule of plan.proxyRules) {
    throwIfBootstrapAborted(signal, BootstrapStage.PROXY);
    await addProxyRule(rule.url, rule.source);
    emit(diagnostics, 'bootstrap.proxy.ready', {
      serviceIndex: rule.serviceIndex,
      serviceIdentity: rule.serviceIdentity
    });
  }
};

const commitPlan = async ({
  plan,
  setMapConfiguration,
  setConfigurationServices,
  signal,
  diagnostics
}) => {
  emitStage(diagnostics, BootstrapStage.COMMIT, plan.summary);
  throwIfBootstrapAborted(signal, BootstrapStage.COMMIT);

  await setMapConfiguration(plan.mapConfiguration);
  throwIfBootstrapAborted(signal, BootstrapStage.COMMIT);
  await setConfigurationServices(plan.configurationServices);
};

export const runApplicationBootstrap = async (dependencies = {}, options = {}) => {
  const loadMapConfiguration = requiredFunction(dependencies, 'loadMapConfiguration');
  const loadConfigurationServices = requiredFunction(dependencies, 'loadConfigurationServices');
  const generateServiceUrl = requiredFunction(dependencies, 'generateServiceUrl');
  const addProxyRule = requiredFunction(dependencies, 'addProxyRule');
  const setMapConfiguration = requiredFunction(dependencies, 'setMapConfiguration');
  const setConfigurationServices = requiredFunction(dependencies, 'setConfigurationServices');

  const signal = options.signal;
  const diagnostics = options.diagnostics;
  const startedAt = now();
  let stage = BootstrapStage.LOAD;

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

    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.PREPARE;
    emitStage(diagnostics, stage, { serviceCount: configurationServices.length });

    const plan = createBootstrapPlan({
      mapConfiguration,
      configurationServices,
      generateServiceUrl
    });

    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.PROXY;
    await runProxySetup({ plan, addProxyRule, signal, diagnostics });

    stage = BootstrapStage.COMMIT;
    await commitPlan({
      plan,
      setMapConfiguration,
      setConfigurationServices,
      signal,
      diagnostics
    });

    throwIfBootstrapAborted(signal, stage);
    stage = BootstrapStage.COMPLETED;
    const durationMs = Math.max(0, now() - startedAt);
    const result = Object.freeze({
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

export const createBootstrapDependencies = (dependencies = {}) => ({
  loadMapConfiguration: requiredFunction(dependencies, 'loadMapConfiguration'),
  loadConfigurationServices: requiredFunction(dependencies, 'loadConfigurationServices'),
  generateServiceUrl: requiredFunction(dependencies, 'generateServiceUrl'),
  addProxyRule: requiredFunction(dependencies, 'addProxyRule'),
  setMapConfiguration: requiredFunction(dependencies, 'setMapConfiguration'),
  setConfigurationServices: requiredFunction(dependencies, 'setConfigurationServices')
});

export const bootstrapDurationBucket = (durationMs) => {
  const value = Math.max(0, asFiniteNumber(durationMs));
  if (value < 250) return 'lt-250ms';
  if (value < 1000) return '250ms-1s';
  if (value < 3000) return '1s-3s';
  if (value < 10000) return '3s-10s';
  return 'gte-10s';
};
