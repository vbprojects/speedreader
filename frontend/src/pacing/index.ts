// src/pacing/index.ts
// Public surface of the pacing module.

export { PacingEngine } from "./engine";
export { naiveBackend, baseDurationMs } from "./naive";
export { selectBackend, registerBackend, availableBackends } from "./select";
export * from "./types";
