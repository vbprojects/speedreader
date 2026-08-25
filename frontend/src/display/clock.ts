// src/display/clock.ts
// Self-correcting clock: advances through a sequence of per-word durations,
// using performance.now() to compensate for setTimeout/setInterval drift.

import type { Clock } from "./types";

export interface ClockOptions {
  /** Per-word durations in ms (parallel to the word stream). */
  durations: number[];
  /** Called on each tick with the new index. */
  onTick: (index: number) => void;
  /** Called when the clock reaches the end. */
  onEnd?: () => void;
  /** Whether playback may begin or resume at the current index. */
  canStart?: (index: number) => boolean;
  /** Whether playback may cross from one word to the next. */
  canAdvance?: (fromIndex: number, nextIndex: number) => boolean;
  /** Called when a start/advance gate blocks playback. */
  onBlocked?: (boundaryIndex: number) => void;
}

export class SelfCorrectingClock implements Clock {
  private durations: number[];
  private onTick: (index: number) => void;
  private onEnd?: () => void;
  private canStart?: (index: number) => boolean;
  private canAdvance?: (fromIndex: number, nextIndex: number) => boolean;
  private onBlocked?: (boundaryIndex: number) => void;

  private _index = 0;
  private _running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startTime = 0;
  private elapsedAtStart = 0;

  constructor(options: ClockOptions) {
    this.durations = options.durations;
    this.onTick = options.onTick;
    this.onEnd = options.onEnd;
    this.canStart = options.canStart;
    this.canAdvance = options.canAdvance;
    this.onBlocked = options.onBlocked;
  }

  get index(): number {
    return this._index;
  }

  get running(): boolean {
    return this._running;
  }

  start(startIndex = 0): void {
    this.clearTimer();
    this._index = startIndex;
    this.elapsedAtStart = 0;
    if (this.canStart && !this.canStart(this._index)) {
      this._running = false;
      this.onBlocked?.(this._index);
      return;
    }
    this._running = true;
    this.onTick(this._index);
    this.schedule();
  }

  pause(): void {
    if (!this._running) return;
    this._running = false;
    this.clearTimer();
    // Account for time already spent in the current word.
    this.elapsedAtStart += performance.now() - this.startTime;
  }

  resume(): void {
    if (this._running) return;
    if (this.canStart && !this.canStart(this._index)) {
      this._running = false;
      this.onBlocked?.(this._index);
      return;
    }
    this._running = true;
    this.schedule();
  }

  stop(): void {
    this._running = false;
    this.clearTimer();
  }

  seek(index: number): void {
    this.stop();
    this._index = this.durations.length === 0 ? 0 : Math.max(0, Math.min(index, this.durations.length - 1));
    this.elapsedAtStart = 0;
    if (this.durations.length > 0) this.onTick(this._index);
  }

  /** Dynamically append new durations to an ongoing stream. */
  appendDurations(newDurations: number[]): void {
    if (newDurations.length === 0) return;
    const wasAtEnd = this._index >= this.durations.length;
    this.durations = [...this.durations, ...newDurations];
    if (this._running && wasAtEnd) this.schedule();
  }

  /** Replace all durations (e.g. when pacing profile changes). */
  updateDurations(durations: number[]): void {
    this.durations = [...durations];
    if (this._index >= this.durations.length) {
      this._index = Math.max(0, this.durations.length - 1);
    }
  }

  destroy(): void {
    this.stop();
  }

  private schedule(): void {
    this.clearTimer();
    if (!this._running || this._index >= this.durations.length) {
      if (this._index >= this.durations.length) this.onEnd?.();
      return;
    }
    this.startTime = performance.now();
    const remaining = this.durations[this._index] - this.elapsedAtStart;
    this.timer = setTimeout(() => this.tick(), Math.max(0, remaining));
  }

  private tick(): void {
    if (!this._running) return;
    const nextIndex = this._index + 1;
    if (this.canAdvance && !this.canAdvance(this._index, nextIndex)) {
      this._running = false;
      // The current word has already consumed its duration. Resuming after
      // the interaction should cross the boundary without waiting again.
      this.elapsedAtStart = this.durations[this._index] ?? 0;
      this.clearTimer();
      this.onBlocked?.(nextIndex);
      return;
    }
    this.elapsedAtStart = 0;
    this._index = nextIndex;
    if (this._index >= this.durations.length) {
      this._running = false;
      this.onEnd?.();
      return;
    }
    this.onTick(this._index);
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
