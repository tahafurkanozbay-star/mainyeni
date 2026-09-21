import { adminRuntimeEnvironment } from '../runtime/adminEnvironment';

export const Global = Object.freeze({
  App: Object.freeze({
    Title1: 'ABB Rehber ',
    Title2: 'Admin',
  }),
  API_URL: adminRuntimeEnvironment.apiBaseUrl,
  APP_VERSION: adminRuntimeEnvironment.appVersion,
});
