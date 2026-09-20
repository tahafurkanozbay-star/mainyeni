/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_REQUEST_TIMEOUT_MS?: string;
  readonly VITE_APP_TITLE_PRIMARY?: string;
  readonly VITE_APP_TITLE_SECONDARY?: string;
  readonly REACT_APP_API_URL?: string;
  readonly REACT_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
