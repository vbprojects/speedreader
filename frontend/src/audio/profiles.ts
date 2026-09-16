export interface WpmProfile {
  readonly id: string;
  readonly modelRevision: string;
  readonly voice: string;
  readonly language: string;
  readonly maximum: number;
  readonly halfSaturationSquared: number;
  readonly pacingRange: readonly [number, number];
  readonly compressionRange: readonly [number, number];
  readonly browserValidated: boolean;
}

/** Python evidence only. Browser promotion requires export/voice/DSP parity. */
export const KOKORO_WPM_PROFILE: WpmProfile = Object.freeze({
  id: "kokoro-v1-af-heart-python-rational-2026-09-15",
  modelRevision: "f3ff3571791e39611d31c381e3a41a3af07b4987",
  voice: "af_heart",
  language: "en",
  maximum: 437.94687151680654,
  halfSaturationSquared: 1.3766378138970434,
  pacingRange: [0.7116781709761707, 3.684919149572706] as const,
  compressionRange: [0.7732970024834994, 3.8706009335254477] as const,
  browserValidated: false,
});
