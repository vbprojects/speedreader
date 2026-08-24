// src/pacing/select.ts
// Factory to pick a pacing backend by name.

import type { PacingBackend } from "./types";
import { naiveBackend } from "./naive";
import { createBayesianBackend } from "./bayesian";

const REGISTRY: Record<string, () => PacingBackend> = {
  [naiveBackend.name]: () => naiveBackend,
  bayesian: () => createBayesianBackend(),
};

/** Select a pacing backend by name. Throws on unknown names. */
export function selectBackend(name: string): PacingBackend {
  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(`Unknown pacing backend "${name}". Available: ${Object.keys(REGISTRY).join(", ")}`);
  }
  return factory();
}

/** Register an additional backend (e.g., syllables, custom models). */
export function registerBackend(backend: PacingBackend | (() => PacingBackend)): void {
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
