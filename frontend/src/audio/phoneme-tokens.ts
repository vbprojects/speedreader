/** Keep one offset per G2P entry, even when an entry expands to several Unicode
 * symbols or contains unsupported symbols. Word ownership uses these offsets. */
export function encodePhonemes(phonemes: readonly string[], vocabulary: Readonly<Record<string, number>>) {
  const ids = [0], offsets = [1];
  for (const entry of phonemes) {
    const symbols = vocabulary[entry] !== undefined ? [entry] : Array.from(entry);
    for (const symbol of symbols) {
      const id = vocabulary[symbol];
      if (id !== undefined) ids.push(id);
    }
    offsets.push(ids.length);
  }
  ids.push(0);
  return { ids, offsets };
}
