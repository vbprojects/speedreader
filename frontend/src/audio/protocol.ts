import type { WordSampleSpan, WordTokenSpan } from "./alignment";

export interface AudioRevision {
  sessionId: string;
  contentRevision: number;
  synthesisRevision: number;
  dspRevision: number;
}

export interface ChunkIdentity extends AudioRevision {
  requestId: string;
  chunkId: string;
  startWord: number;
  endWordExclusive: number;
  /** Speech cannot extend beyond this unresolved interaction boundary. */
  allowedEndWordExclusive: number;
}

export interface SynthesisRequest {
  identity: ChunkIdentity;
  phonemeIds: readonly number[];
  wordTokens: readonly WordTokenSpan[];
  voice: string;
  pacing: number;
}

export interface SynthesisResult {
  identity: ChunkIdentity;
  pcm: Float32Array;
  sampleRate: number;
  tokenDurations: readonly number[];
  words: readonly WordSampleSpan[];
  modelRevision: string;
  runtimeRevision: string;
}

export function sameRevision(a: AudioRevision, b: AudioRevision): boolean {
  return a.sessionId === b.sessionId && a.contentRevision === b.contentRevision &&
    a.synthesisRevision === b.synthesisRevision && a.dspRevision === b.dspRevision;
}
