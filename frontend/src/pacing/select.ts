// src/pacing/select.ts
// Factory to pick a pacing backend by name.

import type { PacingBackend } from "./types";
import { naiveBackend } from "./naive";

const REGISTRY: Record<string, PacingBackend> = {
  [naiveBackend.name]: naiveBackend,
};

/** Select a pacing backend by name. Throws on unknown names. */
export function selectBackend(name: string): PacingBackend {
  const backend = REGISTRY[name];
  if (!backend) {
    throw new Error(`Unknown pacing backend "${name}". Available: ${Object.keys(REGISTRY).join(", ")}`);
  }
  return backend;
}

/** Register an additional backend (e.g., syllables, bayesian later). */
export function registerBackend(backend: PacingBackend): void {
  REGISTRY[backend.name] = backend;
}

/** List available backend names. */
export function availableBackends(): string[] {
  return Object.keys(REGISTRY);
}
