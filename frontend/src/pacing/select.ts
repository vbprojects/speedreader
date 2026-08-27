// src/pacing/select.ts
// Factory to pick a pacing backend by name.

import type { PacingBackend } from "./types";
import { naiveBackend } from "./naive";
import { createBayesianBackend, type BayesianPacingOptions } from "./bayesian";
import {
  createExponentialGammaSurprisalBackend,
  createNormalSurprisalBackend,
  type SurprisalPacingOptions,
} from "./surprisal";

type BackendFactory = (options?: unknown) => PacingBackend;

const REGISTRY: Record<string, BackendFactory> = {
  [naiveBackend.name]: () => naiveBackend,
  bayesian: (opts?: unknown) => createBayesianBackend(opts as BayesianPacingOptions | undefined),
  "surprisal-normal": (opts?: unknown) => createNormalSurprisalBackend(opts as SurprisalPacingOptions | undefined),
  "surprisal-exponential-gamma": (opts?: unknown) =>
    createExponentialGammaSurprisalBackend(opts as SurprisalPacingOptions | undefined),
};

/** Select a pacing backend by name. Throws on unknown names. */
export function selectBackend(name: string, options?: unknown): PacingBackend {
  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(`Unknown pacing backend "${name}". Available: ${Object.keys(REGISTRY).join(", ")}`);
  }
  return factory(options);
}

/** Register an additional backend (e.g., syllables, custom models). */
export function registerBackend(backend: PacingBackend | BackendFactory): void {
  if (typeof backend === "function") {
    const instance = backend();
    REGISTRY[instance.name] = backend;
  } else {
    REGISTRY[backend.name] = () => backend;
  }
}

/** List available backend names. */
export function availableBackends(): string[] {
  return Object.keys(REGISTRY);
}
