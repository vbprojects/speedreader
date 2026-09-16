import { encodePhonemes } from "./phoneme-tokens";
import { normalizeSpeechText, DEFAULT_SPEECH_TEXT_PROFILE, type SpeechTextProfile } from "./speech-text";
import { Language, type Part } from "./vendor/headtts/language-en-us.mjs";
import type { Word } from "../epub/types";
import { sourcePhrase, type WordTokenSpan } from "./alignment";
export const PHONEMIZER_REVISION = "headtts-c08f4ca8-english-normalization-3";

/** Preserve the original subtitle while expanding spoken forms before G2P. */
class EnglishLanguage extends Language {
  normalizedParts: string[] = [];
  // Upstream joins a final single-character word to the previous part. Keep
  // exact source boundaries, including trailing whitespace, for provenance.
  override splitText(text: string): string[] {
    return text.match(/(?:^\s*)?\S+\s*/gu) ?? (text ? [text] : []);
  }
  override partSetText(part: Part, index: number, parts: Part[]): void {
    const original = part.value;
    if (part.type === "text") {
      part.value = original
        .replace(/\bDr\.(?=\s|$)/g, "doctor")
        .replace(/\bMr\.(?=\s|$)/g, "mister")
        .replace(/\bMrs\.(?=\s|$)/g, "missus")
        .replace(/\bMs\.(?=\s|$)/g, "miz")
        .replace(/([$£€])(\d[\d,]*(?:\.\d+)?)/g, (_, currency: string, number: string) =>
          `${number} ${{ "$": "dollars", "£": "pounds", "€": "euros" }[currency]}`)
        .replace(/%/g, " percent ").replace(/&/g, " and ").replace(/\+/g, " plus ").replace(/=/g, " equals ");
    }
    if (/[$£€/]/.test(part.value)) throw new Error("Unsupported currency or slash notation in this passage");
    super.partSetText(part, index, parts);
    this.normalizedParts.push(part.text);
    part.value = original;
    part.subtitles = original;
  }
}
export interface PhonemizedPhrase {
  text: string; phonemes: string; ids: number[]; words: WordTokenSpan[];
  normalization: { wordIndex: number; originalStart: number; originalEnd: number; spokenText: string }[];
}
/** One phrase call, with original offsets retained through normalization expansions. */
export class EnglishPhonemizer {
  private language = new EnglishLanguage();
  constructor(dictionary: string, private vocabulary: Readonly<Record<string, number>>,
    private profile: SpeechTextProfile = DEFAULT_SPEECH_TEXT_PROFILE) {
    this.language.dictionary = {};
    for (const line of dictionary.split(/\r?\n/)) this.language.addToDictionary(line);
    if (Object.keys(this.language.dictionary).length < 1000) throw new Error("Incomplete English pronunciation dictionary");
    if (vocabulary.$ !== 0) throw new Error("Unexpected tokenizer boundary token");
  }
  phonemize(words: readonly Word[]): PhonemizedPhrase {
    const { text, spans } = sourcePhrase(words);
    const spoken: Word[] = [];
    const ranges = words.map(word => {
      const start = spoken.length;
      const normalized = normalizeSpeechText(word, this.profile);
      for (const part of normalized.split(/\s+/).filter(Boolean)) {
        spoken.push({ ...word, text: part, index: spoken.length });
      }
      return { start, end: spoken.length };
    });
    const phrase = spoken.length ? this.phonemizeSupported(spoken) :
      { phonemes: "", ids: [0, 0], words: [], normalization: [] };
    let tokenEnd = 1;
    return { text, phonemes: phrase.phonemes, ids: phrase.ids,
      words: ranges.map((range, i) => {
        const tokenStart = range.start < range.end ? phrase.words[range.start].tokenStart : tokenEnd;
        tokenEnd = range.start < range.end ? phrase.words[range.end - 1].tokenEnd : tokenStart;
        return { wordIndex: words[i].index, tokenStart, tokenEnd };
      }),
      normalization: ranges.map((range, i) => ({ wordIndex: words[i].index,
        originalStart: spans[i].start, originalEnd: spans[i].end,
        spokenText: phrase.normalization.filter(part => part.wordIndex >= range.start && part.wordIndex < range.end)
          .map(part => part.spokenText).join(" ").replace(/\s+/g, " ").trim() })),
    };
  }
  private phonemizeSupported(words: readonly Word[]): PhonemizedPhrase {
    const { text, spans } = sourcePhrase(words);
    // Fail visibly rather than allowing the library to silently discard unknown symbols/scripts.
    if (/[^\p{Script=Latin}\p{M}\d\s.,!?;:'"“”‘’()[\]{}—–…\-/$£€%&+=]/u.test(text)) {
      throw new Error("This English voice cannot safely normalize a symbol or script in this passage");
    }
    this.language.normalizedParts = [];
    const result = this.language.generate(text);
    if (result.metadata.words.join("") !== text || result.silences.length) throw new Error("Phonemizer lost source text ownership");
    const { ids, offsets: tokenOffsets } = encodePhonemes(result.phonemes, this.vocabulary);
    const mapping = spans.map(span => ({ wordIndex: span.wordIndex, tokenStart: -1, tokenEnd: -1 }));
    const normalization: PhonemizedPhrase["normalization"] = [];
    let offset = 0;
    result.metadata.words.forEach((part, i) => {
      const end = offset + part.length;
      const owners = spans.map((span, index) => ({ span, index })).filter(({ span }) => span.start < end && span.end > offset);
      if (owners.length !== 1) throw new Error("Ambiguous source ownership in phonemizer output");
      normalization.push({ wordIndex: owners[0].span.wordIndex, originalStart: offset, originalEnd: end,
        spokenText: this.language.normalizedParts[i] });
      const entry = mapping[owners[0].index];
      if (entry.tokenStart < 0) entry.tokenStart = tokenOffsets[result.metadata.wtimes[i]];
      entry.tokenEnd = tokenOffsets[result.metadata.wdurations[i]];
      offset = end;
    });
    if (mapping.some(word => word.tokenStart < 0)) throw new Error("A source word was omitted by the phonemizer");
    return { text, phonemes: result.phonemes.join(""), ids, words: mapping, normalization };
  }
}

/** Split only at original-word boundaries; re-phonemize each complete phrase. */
export function phonemizeChunk(phonemizer: EnglishPhonemizer, words: readonly Word[], maximumTokens = 512): PhonemizedPhrase {
  if (!words.length) throw new Error("No source words to synthesize");
  let end = words.length;
  while (end > 0) {
    const phrase = phonemizer.phonemize(words.slice(0, end));
    if (phrase.ids.length <= maximumTokens) return phrase;
    if (end === 1) throw new Error("A single source word exceeds the model token limit");
    end = Math.max(1, Math.min(end - 1, Math.floor(end * (maximumTokens - 2) / (phrase.ids.length - 2))));
  }
  throw new Error("No source words fit the model");
}
