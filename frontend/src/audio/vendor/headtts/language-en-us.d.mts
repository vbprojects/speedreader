export interface Part { type: string; value: string; text: string; subtitles: string; }
export class Language {
  constructor(settings?: { trace?: boolean });
  dictionary: Record<string, string[]>;
  addToDictionary(line: string): void;
  partSetText(part: Part, index: number, parts: Part[]): void;
  splitText(text: string): string[];
  generate(input: string): { phonemes: string[]; silences: number[][]; metadata: {
    words: string[]; wtimes: number[]; wdurations: number[];
  } };
}
