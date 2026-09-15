import { runtimeConfig } from './platform/config/runtimeConfig';
import { logger } from './platform/observability/logger';

const reportWebVitals = (onPerfEntry) => {
  if (!runtimeConfig.telemetryEnabled || typeof onPerfEntry !== 'function') return;

  import('web-vitals').then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
    const metrics = [getCLS, getFID, getFCP, getLCP, getTTFB];
    metrics.forEach((getMetric) => getMetric(onPerfEntry));
  }).catch((error) => {
    logger.warn('web_vitals_loader_failed', { message: error?.message });
  });
};

export const logWebVital = (metric) => {
  logger.info('web_vital', {
    name: metric?.name,
    value: metric?.value,
    rating: metric?.rating,
    navigationType: metric?.navigationType
  });
};

export default reportWebVitals;
