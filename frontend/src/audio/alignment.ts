import type { Word } from "../epub/types";

/** Half-open UTF-16 offsets, matching JavaScript strings and tokenizer offsets. */
export interface SourceSpan {
  wordIndex: number;
  start: number;
  end: number;
}

/** Preserve the original words before phrase-level normalization/phonemization. */
export function sourcePhrase(words: readonly Word[]): { text: string; spans: SourceSpan[] } {
  let text = "";
  const spans: SourceSpan[] = [];
  for (const word of words) {
    integer(word.index, "word index");
    if (spans.length && word.index !== spans[spans.length - 1].wordIndex + 1) {
      throw new Error("Source words must be contiguous and ordered");
    }
    if (spans.length) text += " ";
    const start = text.length;
    text += word.text;
    spans.push({ wordIndex: word.index, start, end: text.length });
  }
  return { text, spans };
}

/** Supplied by a provenance-preserving phonemizer, never inferred from length. */
export interface WordTokenSpan {
  wordIndex: number;
  /** Half-open range in model input, including the boundary-token offsets. */
  tokenStart: number;
  tokenEnd: number;
}

export interface WordSampleSpan {
  wordIndex: number;
  startSample: number;
  endSample: number;
}

/** Must be measured/derived for the exact export. No default conversion exists. */
export interface DurationGeometry {
  samplesPerFrame: number;
  /** Signed decoder offset applied to frame boundaries. */
  sampleOffset: number;
  waveformSamples: number;
}

function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
}

/**
 * Project model durations through an explicit word/token mapping. This validates
 * geometry only, not audible alignment. Silence and boundary tokens may occupy
 * gaps. An unspoken word has an empty token range and zero sample duration.
 * DSP must subsequently supply its own source-to-output sample mapping.
 */
export function alignWordSamples(
  words: readonly Word[],
  mapping: readonly WordTokenSpan[],
  tokenDurations: readonly number[],
  geometry: DurationGeometry,
): WordSampleSpan[] {
  sourcePhrase(words); // Validate source identity before accepting provenance.
  if (words.length !== mapping.length) throw new Error("Every source word needs a token mapping");
  integer(geometry.samplesPerFrame, "samples per frame");
  if (!geometry.samplesPerFrame) throw new Error("Samples per frame must be positive");
  integer(geometry.waveformSamples, "waveform length");
  if (!Number.isSafeInteger(geometry.sampleOffset)) throw new Error("Invalid decoder offset");

  const boundaries = [0];
  for (const duration of tokenDurations) {
    integer(duration, "token duration");
    const next = boundaries[boundaries.length - 1] + duration * geometry.samplesPerFrame;
    integer(next, "sample boundary");
    boundaries.push(next);
  }

  let previousTokenEnd = 0;
  return mapping.map((span, index) => {
    if (span.wordIndex !== words[index].index) throw new Error("Word mapping lost source identity");
    integer(span.tokenStart, "token start");
    integer(span.tokenEnd, "token end");
    if (span.tokenStart < previousTokenEnd || span.tokenEnd < span.tokenStart ||
      span.tokenEnd > tokenDurations.length) {
      throw new Error("Token ranges must be ordered, nonoverlapping and within model input");
    }
    previousTokenEnd = span.tokenEnd;
    const startSample = boundaries[span.tokenStart] + geometry.sampleOffset;
    const endSample = boundaries[span.tokenEnd] + geometry.sampleOffset;
    integer(startSample, "word start sample");
    integer(endSample, "word end sample");
    if (endSample > geometry.waveformSamples) throw new Error("Word alignment exceeds waveform");
    return { wordIndex: span.wordIndex, startSample, endSample };
  });
}
