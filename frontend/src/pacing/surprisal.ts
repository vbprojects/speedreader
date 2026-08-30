// Experimental character n-gram surprisal pacing.
//
// Each n-gram has an exponentially-forgotten Gamma posterior over its
// recurrence rate. Observed recurrence gaps use an Exponential likelihood;
// integrating out the rate gives a Lomax posterior-predictive density. Word
// difficulty is the SUM of n-gram surprisals, intentionally retaining a
// length effect. A second online model calibrates word surprisal to a bounded
// duration multiplier. Available calibrations include Exponential-Gamma,
// Normal, and a length-conditioned Lognormal model with discounted conjugate
// Normal-Inverse-Gamma updates.

import type { Word } from "../epub/types";
import type { PacingBackend, PacingContext } from "./types";

export interface SurprisalPacingOptions {
  /** Character n-gram width. */
  n?: number;
  /** Evidence half-life, measured in words. */
  halfLifeWords?: number;
  /** Gamma prior shape for recurrence rate (shape-rate convention). */
  alpha0?: number;
  /** Gamma prior rate for recurrence rate (shape-rate convention). */
  beta0?: number;
  /** EWMA learning rate for the Normal score approximation. */
  scoreLearningRate?: number;
  /** Distribution used to calibrate raw word surprisal. */
  scoreModel?: "exponential-gamma" | "normal" | "lognormal-nig";
  /** Gamma shape prior for the Exponential word-surprisal rate. Must exceed 1. */
  scoreAlpha0?: number;
  /** Gamma rate prior for the Exponential word-surprisal rate. */
  scoreBeta0?: number;
  /** Evidence half-life for the word-surprisal model. */
  scoreHalfLifeWords?: number;
  /** NIG prior effective sample size for each length-conditioned log-score model. */
  scorePriorStrength?: number;
  /** NIG prior shape for log-score variance. Must exceed 1. */
  scorePriorAlpha?: number;
  /** Strength of the exponential z-score-to-duration mapping. */
  sensitivity?: number;
  /** Number of observations over which to fade in score adaptation. */
  warmupWords?: number;
  /** Bounds for the adaptive multiplier, before punctuation pauses. */
  minMultiplier?: number;
  maxMultiplier?: number;
  /** Maximum sparse n-gram entries retained. */
  maxEntries?: number;
}

export interface SurprisalPacingStats {
  position: number;
  entries: number;
  scoreMean: number;
  scoreStdDev: number;
  scoreModel: "exponential-gamma" | "normal" | "lognormal-nig";
  expectedScore: number;
  scoreAlpha: number;
  scoreBeta: number;
  /** Active length band for the most recently scored word. */
  scoreBucket: "short" | "medium" | "long";
  /** Discounted effective observations in the active length band. */
  scoreBucketEvidence: number;
  lastRawSurprisal: number;
  /** Centered calibration value: z-score, or S/E[S] - 1. */
  lastRelativeDifficulty: number;
  lastMultiplier: number;
  prunedEntries: number;
}

interface NGramState {
  alpha: number;
  beta: number;
  lastPosition: number;
}

type ScoreBucket = "short" | "medium" | "long";

interface LogScoreState {
  count: number;
  sum: number;
  sumSquares: number;
  lastPosition: number;
}

const SENTENCE_END = /[.!?…]$/;

function metaValue(word: Word, attribute: string): string | number | undefined {
  return word.metadata.find((m) => m.attribute === attribute)?.value;
}

function isParagraphBoundary(word: Word, next?: Word): boolean {
  if (!next) return false;
  const current = metaValue(word, "paragraphId");
  const following = metaValue(next, "paragraphId");
  return current !== undefined && following !== undefined && current !== following;
}

/** Normalized, boundary-aware, overlapping character n-grams. */
export function characterNGrams(text: string, n = 3): string[] {
  if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!normalized) return [];

  const padded = `^${normalized}$`;
  if (padded.length <= n) return [padded];

  const grams: string[] = [];
  for (let offset = 0; offset <= padded.length - n; offset += 1) {
    grams.push(padded.slice(offset, offset + n));
  }
  return grams;
}

function lomaxSurprisal(gap: number, alpha: number, beta: number): number {
  // -log(alpha * beta^alpha / (beta + gap)^(alpha + 1)), rearranged
  // to avoid exponentiation and underflow.
  return -Math.log(alpha) - alpha * Math.log(beta) + (alpha + 1) * Math.log(beta + gap);
}

function scoreBucketFor(text: string): ScoreBucket {
  const length = [...text.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "")].length;
  if (length <= 4) return "short";
  if (length <= 8) return "medium";
  return "long";
}

export function createSurprisalPacingFn(options: SurprisalPacingOptions = {}): {
  (word: Word, ctx: PacingContext): number;
  reset(): void;
  getStats(): SurprisalPacingStats;
} {
  const n = options.n ?? 3;
  const halfLifeWords = options.halfLifeWords ?? 250;
  const alpha0 = options.alpha0 ?? 1;
  const beta0 = options.beta0 ?? 50;
  const scoreLearningRate = options.scoreLearningRate ?? 0.02;
  const scoreModel = options.scoreModel ?? "exponential-gamma";
  const scoreAlpha0 = options.scoreAlpha0 ?? 2;
  const scoreBeta0 = options.scoreBeta0 ?? 20;
  const scoreHalfLifeWords = options.scoreHalfLifeWords ?? 250;
  const scorePriorStrength = options.scorePriorStrength ?? 4;
  const scorePriorAlpha = options.scorePriorAlpha ?? 3;
  const sensitivity = options.sensitivity ?? 0.25;
  const warmupWords = options.warmupWords ?? 30;
  const minMultiplier = options.minMultiplier ?? 0.5;
  const maxMultiplier = options.maxMultiplier ?? 3;
  const maxEntries = options.maxEntries ?? 10_000;

  if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
  if (!(halfLifeWords > 0)) throw new Error("halfLifeWords must be positive");
  if (!(alpha0 > 0 && beta0 > 0)) throw new Error("Gamma prior parameters must be positive");
  if (!(scoreLearningRate > 0 && scoreLearningRate <= 1)) throw new Error("scoreLearningRate must be in (0, 1]");
  if (!(scoreAlpha0 > 1 && scoreBeta0 > 0)) throw new Error("score Gamma prior requires scoreAlpha0 > 1 and scoreBeta0 > 0");
  if (!(scoreHalfLifeWords > 0)) throw new Error("scoreHalfLifeWords must be positive");
  if (!(scorePriorStrength > 0)) throw new Error("scorePriorStrength must be positive");
  if (!(scorePriorAlpha > 1)) throw new Error("scorePriorAlpha must exceed 1");
  if (!Number.isFinite(sensitivity) || sensitivity < 0) throw new Error("sensitivity must be finite and non-negative");
  if (!(minMultiplier > 0 && maxMultiplier >= minMultiplier)) throw new Error("invalid multiplier bounds");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");

  const table = new Map<string, NGramState>();
  let position = 0;
  let scoreCount = 0;
  let scoreMean = 0;
  let scoreVariance = 1;
  let scoreAlpha = scoreAlpha0;
  let scoreBeta = scoreBeta0;
  let lastRawSurprisal = 0;
  let expectedScore = scoreBeta0 / (scoreAlpha0 - 1);
  let lastRelativeDifficulty = 0;
  let lastMultiplier = 1;
  let prunedEntries = 0;
  let scoreBucket: ScoreBucket = "short";
  let scoreBucketEvidence = 0;
  const logScoreStates: Record<ScoreBucket, LogScoreState> = {
    short: { count: 0, sum: 0, sumSquares: 0, lastPosition: 0 },
    medium: { count: 0, sum: 0, sumSquares: 0, lastPosition: 0 },
    long: { count: 0, sum: 0, sumSquares: 0, lastPosition: 0 },
  };
  // Centers taken from the experiment's three length strata. They only
  // govern burn-in; discounted observations rapidly replace their influence.
  const logScorePriorMean: Record<ScoreBucket, number> = {
    short: Math.log(18),
    medium: Math.log(40),
    long: Math.log(72),
  };
  const logScorePriorBeta = scorePriorAlpha - 1;

  const retention = (gap: number): number => 2 ** (-gap / halfLifeWords);

  function pruneIfNeeded(): void {
    if (table.size <= maxEntries) return;
    const removeCount = Math.max(table.size - maxEntries, Math.ceil(maxEntries * 0.1));
    const ranked = [...table.entries()].map(([gram, state]) => {
      const rho = retention(Math.max(0, position - state.lastPosition));
      const evidence = rho * (Math.abs(state.alpha - alpha0) + Math.abs(state.beta - beta0) / beta0);
      return { gram, evidence };
    });
    ranked.sort((a, b) => a.evidence - b.evidence);
    for (let i = 0; i < removeCount && i < ranked.length; i += 1) {
      table.delete(ranked[i].gram);
      prunedEntries += 1;
    }
  }

  const fn = (word: Word, ctx: PacingContext): number => {
    const grams = characterNGrams(word.text, n);
    const occurrences = new Map<string, number>();
    for (const gram of grams) occurrences.set(gram, (occurrences.get(gram) ?? 0) + 1);

    let rawSurprisal = 0;
    const updates: Array<{ gram: string; alpha: number; beta: number }> = [];

    for (const [gram, multiplicity] of occurrences) {
      const previous = table.get(gram);
      // For an unseen gram, elapsed session positions are a left-censored gap
      // approximation. This assumption is intentionally visible in the experiment.
      const gap = previous ? Math.max(1, position - previous.lastPosition) : position + 1;
      const rho = previous ? retention(gap) : 0;
      const alpha = alpha0 + rho * ((previous?.alpha ?? alpha0) - alpha0);
      const beta = beta0 + rho * ((previous?.beta ?? beta0) - beta0);

      rawSurprisal += multiplicity * lomaxSurprisal(gap, alpha, beta);
      // A gram is one recurrence event at this word position, even if its
      // character pattern appears more than once inside the word.
      updates.push({ gram, alpha: alpha + 1, beta: beta + gap });
    }

    const scoreStdDev = Math.sqrt(Math.max(scoreVariance, 1e-6));
    let rawRelativeDifficulty: number;
    let discountedScoreAlpha = scoreAlpha;
    let discountedScoreBeta = scoreBeta;
    if (scoreModel === "exponential-gamma") {
      const scoreRetention = 2 ** (-1 / scoreHalfLifeWords);
      discountedScoreAlpha = scoreAlpha0 + scoreRetention * (scoreAlpha - scoreAlpha0);
      discountedScoreBeta = scoreBeta0 + scoreRetention * (scoreBeta - scoreBeta0);
      // Marginally S follows Lomax(a, b), whose mean is b / (a - 1).
      expectedScore = discountedScoreBeta / (discountedScoreAlpha - 1);
      rawRelativeDifficulty = rawSurprisal / expectedScore - 1;
    } else if (scoreModel === "normal") {
      expectedScore = scoreCount === 0 ? rawSurprisal : scoreMean;
      rawRelativeDifficulty = scoreCount === 0 ? 0 : (rawSurprisal - scoreMean) / scoreStdDev;
    } else {
      scoreBucket = scoreBucketFor(word.text);
      const state = logScoreStates[scoreBucket];
      const gap = Math.max(0, position - state.lastPosition);
      const rho = 2 ** (-gap / scoreHalfLifeWords);
      const count = rho * state.count;
      const sum = rho * state.sum;
      const sumSquares = rho * state.sumSquares;
      const priorMean = logScorePriorMean[scoreBucket];
      const kappa = scorePriorStrength + count;
      const posteriorMean = (scorePriorStrength * priorMean + sum) / kappa;
      const posteriorAlpha = scorePriorAlpha + count / 2;
      const posteriorBeta = Math.max(
        1e-6,
        logScorePriorBeta + 0.5 * (sumSquares + scorePriorStrength * priorMean * priorMean - kappa * posteriorMean * posteriorMean),
      );
      // Student-t posterior-predictive variance on log(S). alpha > 1 keeps
      // this finite, allowing a direct standardized pacing signal.
      const predictiveVariance = posteriorBeta * (kappa + 1) / (kappa * (posteriorAlpha - 1));
      const predictiveStdDev = Math.sqrt(Math.max(predictiveVariance, 1e-6));
      const logScore = Math.log(Math.max(rawSurprisal, 1e-9));
      expectedScore = Math.exp(posteriorMean);
      rawRelativeDifficulty = (logScore - posteriorMean) / predictiveStdDev;
      scoreMean = posteriorMean;
      scoreVariance = predictiveVariance;
      scoreAlpha = posteriorAlpha;
      scoreBeta = posteriorBeta;
      scoreBucketEvidence = count;

      state.count = count + 1;
      state.sum = sum + logScore;
      state.sumSquares = sumSquares + logScore * logScore;
      state.lastPosition = position;
    }
    const warmupWeight = warmupWords <= 0 ? 1 : Math.min(1, scoreCount / warmupWords);
    const relativeDifficulty = Math.max(-3, Math.min(3, rawRelativeDifficulty * warmupWeight));
    const multiplier = Math.max(minMultiplier, Math.min(maxMultiplier, Math.exp(sensitivity * relativeDifficulty)));

    let duration = (60_000 / ctx.profile.wpm) * multiplier;
    if (SENTENCE_END.test(word.text)) duration += ctx.profile.sentencePauseMs;
    if (isParagraphBoundary(word, ctx.neighbors.next)) duration += ctx.profile.paragraphPauseMs;

    for (const update of updates) {
      table.set(update.gram, { alpha: update.alpha, beta: update.beta, lastPosition: position });
    }
    pruneIfNeeded();

    if (scoreModel === "normal") {
      if (scoreCount === 0) {
        scoreMean = rawSurprisal;
        scoreVariance = 1;
      } else {
        const delta = rawSurprisal - scoreMean;
        scoreMean += scoreLearningRate * delta;
        scoreVariance = (1 - scoreLearningRate) * (scoreVariance + scoreLearningRate * delta * delta);
      }
    }
    if (scoreModel === "exponential-gamma") {
      // Conjugate update for S | eta ~ Exponential(eta), eta ~ Gamma(a, b).
      scoreAlpha = discountedScoreAlpha + 1;
      scoreBeta = discountedScoreBeta + rawSurprisal;
    }

    scoreCount += 1;
    position += 1;
    lastRawSurprisal = rawSurprisal;
    lastRelativeDifficulty = relativeDifficulty;
    lastMultiplier = multiplier;
    return duration;
  };

  fn.reset = () => {
    table.clear();
    position = 0;
    scoreCount = 0;
    scoreMean = 0;
    scoreVariance = 1;
    scoreAlpha = scoreAlpha0;
    scoreBeta = scoreBeta0;
    lastRawSurprisal = 0;
    expectedScore = scoreBeta0 / (scoreAlpha0 - 1);
    lastRelativeDifficulty = 0;
    lastMultiplier = 1;
    prunedEntries = 0;
    scoreBucket = "short";
    scoreBucketEvidence = 0;
    for (const state of Object.values(logScoreStates)) {
      state.count = 0;
      state.sum = 0;
      state.sumSquares = 0;
      state.lastPosition = 0;
    }
  };

  fn.getStats = () => ({
    position,
    entries: table.size,
    scoreMean,
    scoreStdDev: Math.sqrt(Math.max(scoreVariance, 0)),
    scoreModel,
    expectedScore,
    scoreAlpha,
    scoreBeta,
    scoreBucket,
    scoreBucketEvidence,
    lastRawSurprisal,
    lastRelativeDifficulty,
    lastMultiplier,
    prunedEntries,
  });

  return fn;
}

export function createSurprisalBackend(options: SurprisalPacingOptions = {}): PacingBackend {
  const scoreModel = options.scoreModel ?? "exponential-gamma";
  return { name: `surprisal-${scoreModel}`, fn: createSurprisalPacingFn({ ...options, scoreModel }) };
}

/** Production backend using an online Normal approximation of word surprisal. */
export function createNormalSurprisalBackend(options: SurprisalPacingOptions = {}): PacingBackend {
  return createSurprisalBackend({ ...options, scoreModel: "normal" });
}

/** Production backend using an Exponential likelihood with a Gamma rate prior. */
export function createExponentialGammaSurprisalBackend(options: SurprisalPacingOptions = {}): PacingBackend {
  return createSurprisalBackend({ ...options, scoreModel: "exponential-gamma" });
}

/** Length-conditioned Lognormal calibration with discounted NIG updates. */
export function createLognormalNIGSurprisalBackend(options: SurprisalPacingOptions = {}): PacingBackend {
  return createSurprisalBackend({ ...options, scoreModel: "lognormal-nig" });
}
