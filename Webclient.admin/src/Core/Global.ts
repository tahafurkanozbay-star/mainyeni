import { runtimeConfig } from "../platform/runtimeConfig";

export const Global = Object.freeze({
  App: Object.freeze({
    Title1: runtimeConfig.appTitlePrimary,
    Title2: runtimeConfig.appTitleSecondary,
  }),
  API_URL: runtimeConfig.apiBaseUrl,
  APP_VERSION: runtimeConfig.appVersion,
});
