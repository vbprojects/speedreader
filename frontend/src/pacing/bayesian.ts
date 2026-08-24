// src/pacing/bayesian.ts
// Online Bayesian parameter estimation with exponential memory discounting
// for dynamic RSVP display duration calculation.
//
// Model (Shifted Poisson–Gamma with Discounting):
//   Let Y_t = L_t - 1 >= 0 be the excess character count of word t, with Y_t ~ Poisson(lambda).
//   Prior: lambda ~ Gamma(alpha_0, beta_0), with prior mean mu_hat_0 = 1 + alpha_0 / beta_0.
//
//   Online step for word t (length L_t):
//     1. Estimate local mean: mu_hat_t = 1 + (alpha_{t-1} / beta_{t-1})
//     2. Base duration: T_t = (60000 / (W * mu_hat_t)) * L_t   [in ms]
//     3. Add boundary pauses (sentence/paragraph).
//     4. Discount & Update:
//          alpha_t = gamma * alpha_{t-1} + (L_t - 1)
//          beta_t  = gamma * beta_{t-1} + 1

import type { PacingBackend, PacingContext } from "./types";
import type { Word } from "../epub/types";

export interface BayesianPacingOptions {
  /** Forgetting / discounting factor gamma in (0, 1). Default: 0.98 (~50 words memory window). */
  gamma?: number;
  /** Prior pseudo-word counts beta_0. Default: 10. */
  beta0?: number;
  /** Prior excess characters alpha_0. Default: 50 (so mu_hat_0 = 1 + 50/10 = 6.0 chars/word). */
  alpha0?: number;
}

const SENTENCE_END = /[.!?…]$/;

function metaValue(word: Word, attribute: string): string | number | undefined {
  return word.metadata.find((m) => m.attribute === attribute)?.value;
}

function isParagraphBoundary(word: Word, next?: Word): boolean {
  if (!next) return false;
  const a = metaValue(word, "paragraphId");
  const b = metaValue(next, "paragraphId");
  return a !== undefined && b !== undefined && a !== b;
}

/**
 * Creates a stateful Bayesian pacing function (or functor).
 * Maintains internal alpha and beta sufficient statistics with exponential discounting.
 */
export function createBayesianPacingFn(options: BayesianPacingOptions = {}): {
  (word: Word, ctx: PacingContext): number;
  reset(): void;
  getStats(): { alpha: number; beta: number; muHat: number };
} {
  const gamma = options.gamma ?? 0.98;
  const beta0 = options.beta0 ?? 10;
  const alpha0 = options.alpha0 ?? 50;

  let alpha = alpha0;
  let beta = beta0;

  const fn = (word: Word, ctx: PacingContext): number => {
    // 1. Current estimate of expected character length per word
    const muHat = 1 + (beta > 0 ? alpha / beta : alpha0 / beta0);

    // 2. Compute word length (at least 1)
    const len = Math.max(1, word.text.length);

    // 3. Compute base word duration in milliseconds: (60_000 / (W * muHat)) * len
    const wpm = ctx.profile.wpm;
    let duration = (60000 / (wpm * muHat)) * len;

    // 4. Boundary pauses
    if (SENTENCE_END.test(word.text)) {
      duration += ctx.profile.sentencePauseMs;
    }
    if (isParagraphBoundary(word, ctx.neighbors.next)) {
      duration += ctx.profile.paragraphPauseMs;
    }

    // 5. Discount and Bayesian update
    const excessChars = len - 1;
    alpha = gamma * alpha + excessChars;
    beta = gamma * beta + 1;

    return duration;
  };

  fn.reset = () => {
    alpha = alpha0;
    beta = beta0;
  };

  fn.getStats = () => ({
    alpha,
    beta,
    muHat: 1 + (beta > 0 ? alpha / beta : alpha0 / beta0),
  });

  return fn;
}

/**
 * Default stateless factory for the Bayesian pacing backend.
 * Each durations() pass or fresh evaluation gets its own stateful instance.
 */
export function createBayesianBackend(options: BayesianPacingOptions = {}): PacingBackend {
  const statefulFn = createBayesianPacingFn(options);
  return {
    name: "bayesian",
    fn: statefulFn,
  };
}

export const bayesianBackend: PacingBackend = createBayesianBackend();
