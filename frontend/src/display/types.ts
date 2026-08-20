// src/display/types.ts
// Contracts for the display component: a self-correcting clock and a
// renderer that flashes the current word.

import type { Word } from "../epub/types";

/** Display configuration. */
export interface DisplayConfig {
  /** Base WPM used for pacing. */
  wpm: number;
}

/** A single frame of display state. */
export interface DisplayFrame {
  /** The current (highlighted) word. */
  current: Word;
  /** Global index of the current word. */
  index: number;
}

/** Callback fired on each tick with the new frame. */
export type FrameCallback = (frame: DisplayFrame) => void;

/** A clock that advances through a sequence of durations. */
export interface Clock {
  /** Start advancing from the given index. */
  start(startIndex?: number): void;
  /** Pause the clock. */
  pause(): void;
  /** Resume from the current position. */
  resume(): void;
  /** Stop and reset. */
  stop(): void;
  /** Seek to an index (and pause). */
  seek(index: number): void;
  /** Current index. */
  readonly index: number;
  /** Whether the clock is running. */
  readonly running: boolean;
  /** Clean up resources. */
  destroy(): void;
}
