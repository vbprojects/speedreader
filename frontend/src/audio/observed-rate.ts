/** Display-only cumulative rate for the current uninterrupted speed/seek window. */
export class ObservedSpeechRate {
  private seconds = 0;
  private words = 0;
  add(consumedSamples: number, completedWords: number, sampleRate: number): number | null {
    if (!Number.isSafeInteger(consumedSamples) || consumedSamples < 0 || !Number.isSafeInteger(completedWords) || completedWords < 0 ||
      !Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error("Invalid observed speech counters");
    this.seconds += consumedSamples / sampleRate;
    this.words += completedWords;
    return this.value;
  }
  get value(): number | null { return this.words >= 3 && this.seconds > 0 ? this.words * 60 / this.seconds : null; }
  reset(): void { this.seconds = 0; this.words = 0; }
}
