/** Match the pinned upstream Kokoro JS voice-table convention. A 510-phoneme
 * phrase uses the last (509th) style row; its text tokens are never truncated.
 */
export function selectVoiceStyle(voice: Float32Array, inputTokenCount: number): Float32Array {
  if (voice.length !== 510 * 256) throw new Error("Unexpected Kokoro voice style table");
  if (!Number.isSafeInteger(inputTokenCount) || inputTokenCount < 3 || inputTokenCount > 512) {
    throw new Error("Input is outside Kokoro's token limit");
  }
  const offset = Math.min(inputTokenCount - 2, 509) * 256;
  return voice.slice(offset, offset + 256);
}
