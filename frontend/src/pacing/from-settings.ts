import type { GlobalSettings } from "../settings/types";
import { PacingEngine } from "./engine";
import { selectBackend } from "./select";

/**
 * Build a fresh pacing engine from persisted reader settings.
 *
 * Keeping this mapping in one place ensures the live reader and the settings
 * preview exercise the same backend options. Stateful backends are always
 * newly instantiated, so a preview cannot train or mutate the reader engine.
 */
export function createPacingEngine(settings: GlobalSettings): PacingEngine {
  const backendOptions = settings.pacingModel === "bayesian"
    ? { gamma: settings.bayesianGamma ?? 0.98 }
    : settings.pacingModel.startsWith("surprisal-")
      ? {
          n: settings.surprisalNGramSize ?? 3,
          sensitivity: settings.surprisalSensitivity ?? 0.25,
          ...(settings.pacingModel === "surprisal-lognormal-nig"
            ? { scoreHalfLifeWords: -1 / Math.log2(settings.bayesianGamma ?? 0.98) }
            : {}),
        }
      : undefined;

  return new PacingEngine({
    backend: selectBackend(settings.pacingModel ?? "naive", backendOptions),
    profile: {
      wpm: settings.wpm,
      sentencePauseMs: settings.sentencePauseMs,
      paragraphPauseMs: settings.paragraphPauseMs,
      gamma: settings.bayesianGamma ?? 0.98,
    },
  });
}
