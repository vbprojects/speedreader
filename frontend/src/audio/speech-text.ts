import type { Word } from "../epub/types";

/** Ordered, speech-only rules. Source words are never mutated. A rule may return
 * an empty string to suppress text, or multiple spoken words for one source word.
 * Callers can close over source-specific context when constructing a profile. */
export interface SpeechTextRule {
  id: string;
  replace(text: string, source: Readonly<Word>): string;
}
export interface SpeechTextProfile { id: string; rules: readonly SpeechTextRule[]; }
export const DEFAULT_SPEECH_TEXT_PROFILE: SpeechTextProfile = { id: "english-readable-1", rules: [
  { id: "social-markers", replace: text => text.replace(/[@#_]/g, " ") },
  { id: "slash", replace: text => text.replace(/\//g, " slash ") },
  { id: "standalone-currency", replace: text => text.replace(/[$£€](?!\d)/g,
    symbol => ({ "$": " dollars ", "£": " pounds ", "€": " euros " })[symbol]!) },
] };

export function normalizeSpeechText(word: Readonly<Word>, profile = DEFAULT_SPEECH_TEXT_PROFILE): string {
  let text = word.text;
  for (const rule of profile.rules) text = rule.replace(text, word);
  // Replace rather than delete, so "hello😀world" cannot become "helloworld".
  text = text.replace(/[^\p{Script=Latin}\p{M}\d\s.,!?;:'"“”‘’()[\]{}—–…\-$£€%&+=]/gu, " ")
    .replace(/[\uFE0E\uFE0F\u20E3]/g, " ").replace(/\s+/g, " ").trim();
  // Punctuation-only and combining-mark-only tokens have no speech duration.
  return /[\p{Script=Latin}\d$£€%&+=]/u.test(text) ? text : "";
}
