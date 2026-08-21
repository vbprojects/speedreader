/// <reference types="vite/client" />

// Type declarations for Vite virtual modules used by vite-plugin-pwa.
// `virtual:pwa-register` is resolved by the plugin at build time; this
// declaration lets TypeScript type-check the import in main.tsx.

declare module "virtual:pwa-register" {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRegistration?: (shouldRegister: boolean) => void;
    onOfflineReady?: () => void;
  }

  export function registerSW(options?: RegisterSWOptions): void;
}
