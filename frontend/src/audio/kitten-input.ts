import JSZip from "jszip";
import vocabulary from "./vendor/kitten-vocabulary.json";
import kokoroVocabulary from "./vendor/kokoro-vocabulary.json";
import type { PhonemizedPhrase } from "./phonemizer";

const symbols = new Map(Object.entries(kokoroVocabulary).map(([symbol, id]) => [id, symbol]));
const ipa: Record<string, string> = { A: "eɪ", I: "aɪ", O: "oʊ", Q: "əʊ", W: "aʊ", Y: "ɔɪ", "ʧ": "tʃ", "ʤ": "dʒ" };
const tokens = vocabulary as Readonly<Record<string, number>>;
export const KITTEN_TOKEN_LIMIT = 512;

/** Kitten's pinned basic_english_tokenize convention, retaining source ownership.
 * HeadTTS supplies normalization/provenance; compact English symbols become IPA.
 */
export function kittenInput(phrase: PhonemizedPhrase): PhonemizedPhrase {
  let text = "";
  const offsets = [0];
  for (let i = 1; i < phrase.ids.length - 1; i++) {
    offsets[i] = text.length;
    const symbol = symbols.get(phrase.ids[i]);
    if (symbol === undefined) throw new Error("Unknown source phoneme");
    text += ipa[symbol] ?? symbol;
  }
  offsets[phrase.ids.length - 1] = text.length;
  const ids = [0], owners: number[] = [];
  const matches = text.matchAll(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu);
  let previousEnd = 0;
  for (const match of matches) {
    const start = match.index;
    const supported = Array.from(match[0]).flatMap((symbol, index) =>
      tokens[symbol] === undefined ? [] : [{ id: tokens[symbol], offset: start + index }]);
    if (!supported.length) continue;
    if (ids.length > 1) { ids.push(tokens[" "]); owners.push(previousEnd); }
    for (const token of supported) { ids.push(token.id); owners.push(token.offset); }
    previousEnd = start + match[0].length;
  }
  const contentEnd = ids.length;
  ids.push(10, 0); // Upstream sentence terminator and boundary token.
  return { ...phrase, ids, words: phrase.words.map(word => {
    const start = offsets[word.tokenStart], end = offsets[word.tokenEnd];
    const first = owners.findIndex(offset => offset >= start);
    const after = owners.findIndex(offset => offset >= end);
    return { wordIndex: word.wordIndex,
      tokenStart: first < 0 ? contentEnd : first + 1,
      tokenEnd: after < 0 ? contentEnd : after + 1 };
  }) };
}

/** Parse only the pinned little-endian, C-order float32 NPY style matrix. */
export function decodeKittenStyle(bytes: Uint8Array): Float32Array {
  if (bytes.length < 10 || new TextDecoder().decode(bytes.subarray(1, 6)) !== "NUMPY" || bytes[0] !== 0x93 || bytes[6] !== 1 || bytes[7] !== 0) {
    throw new Error("Unsupported Kitten voice array");
  }
  const headerEnd = 10 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true);
  const header = new TextDecoder().decode(bytes.subarray(10, headerEnd));
  const shape = header.match(/'shape':\s*\(\s*(\d+)\s*,\s*256\s*\)/);
  const rows = Number(shape?.[1]);
  if (!/'descr':\s*'<f4'/.test(header) || !/'fortran_order':\s*False/.test(header) ||
      !Number.isSafeInteger(rows) || rows < 1 || rows > 1024 || bytes.length !== headerEnd + rows * 256 * 4) {
    throw new Error("Unexpected Kitten style geometry");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + headerEnd, bytes.length - headerEnd);
  const style = Float32Array.from({ length: rows * 256 }, (_, index) => view.getFloat32(index * 4, true));
  if (style.some(value => !Number.isFinite(value))) throw new Error("Invalid Kitten style values");
  return style;
}
export async function loadKittenStyle(archive: ArrayBuffer, key: string): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(archive);
  const file = zip.file(`${key}.npy`);
  if (!file) throw new Error("Kitten voice is missing from the installed archive");
  const style = decodeKittenStyle(await file.async("uint8array"));
  return style.buffer as ArrayBuffer;
}
export function selectKittenStyle(styles: Float32Array, textLength: number): Float32Array {
  if (!Number.isSafeInteger(textLength) || textLength < 1 || !styles.length || styles.length % 256) {
    throw new Error("Invalid Kitten style selection");
  }
  const row = Math.min(textLength, styles.length / 256 - 1);
  return styles.slice(row * 256, (row + 1) * 256);
}
