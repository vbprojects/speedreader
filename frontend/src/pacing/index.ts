// src/pacing/index.ts
// Public surface of the pacing module.

export { PacingEngine } from "./engine";
export { naiveBackend, baseDurationMs } from "./naive";
export { bayesianBackend, createBayesianBackend, createBayesianPacingFn } from "./bayesian";
export type { BayesianPacingOptions } from "./bayesian";
export {
  createSurprisalBackend,
  createNormalSurprisalBackend,
  createExponentialGammaSurprisalBackend,
  createLognormalNIGSurprisalBackend,
  createSurprisalPacingFn,
  characterNGrams,
} from "./surprisal";
export type { SurprisalPacingOptions, SurprisalPacingStats } from "./surprisal";
export { selectBackend, registerBackend, availableBackends } from "./select";
export * from "./types";
