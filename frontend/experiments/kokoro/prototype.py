"""Local Kokoro synthesis with original-word provenance; no transcription.

Deliberately accepts one short passage (at most 510 phoneme characters). Unsupported
source transformations and dropped model tokens are errors, never guessed mappings.
"""
import argparse
import hashlib
import html
import importlib.metadata
import json
import math
from pathlib import Path
import re
import time

MODEL_REPO = "hexgrad/Kokoro-82M"
MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
SAMPLE_RATE = 24000


def source_mapping(text, tokens):
    """Match tokenizer text sequentially, retaining source indices before synthesis."""
    words = [dict(index=i, text=m.group(), charStart=m.start(), charEnd=m.end(),
                  utf16Start=len(text[:m.start()].encode('utf-16-le')) // 2,
                  utf16End=len(text[:m.end()].encode('utf-16-le')) // 2,
                  tokenIndices=[], start=None, end=None)
             for i, m in enumerate(re.finditer(r"\S+", text))]
    cursor = 0
    annotations = []
    for i, token in enumerate(tokens):
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        if not token.text or not text.startswith(token.text, cursor):
            raise ValueError(f"Tokenizer changed source text at {cursor}: {token.text!r}")
        end = cursor + len(token.text)
        owners = [w['index'] for w in words if w['charStart'] < end and w['charEnd'] > cursor]
        annotations.append(dict(index=i, text=token.text, phonemes=token.phonemes or '',
                                charStart=cursor, charEnd=end, wordIndices=owners))
        for owner in owners:
            words[owner]['tokenIndices'].append(i)
        cursor = end
    if text[cursor:].strip():
        raise ValueError(f"Tokenizer left source text unmapped at {cursor}")
    return words, annotations


def annotate(text, tokens, phonemes, durations, vocab, audio_samples):
    words, annotations = source_mapping(text, tokens)
    # Follow KPipeline.tokens_to_ps exactly, keeping ownership of spaces as null.
    symbols = []
    for i, token in enumerate(tokens):
        symbols.extend((symbol, i) for symbol in (token.phonemes or ''))
        if token.whitespace:
            symbols.append((' ', None))
    while symbols and symbols[0][0].isspace():
        symbols.pop(0)
    while symbols and symbols[-1][0].isspace():
        symbols.pop()
    if ''.join(s for s, _ in symbols) != phonemes:
        raise ValueError("Phoneme sequence changed between mapping and synthesis")
    if any(s not in vocab for s, _ in symbols):
        raise ValueError("Model would silently drop an unknown phoneme symbol")
    if len(durations) != len(symbols) + 2 or any(d < 1 for d in durations):
        raise ValueError("Invalid model duration count or values")
    # Raw frame boundaries are diagnostic model coordinates, not audible onset
    # promises. Upstream's word timestamps use additional space/offset handling.
    frame = 0
    phones = []
    sequence = [('<bos>', None), *symbols, ('<eos>', None)]
    for i, ((symbol, owner), duration) in enumerate(zip(sequence, durations)):
        phones.append(dict(modelTokenIndex=i, modelTokenId=0 if i in (0, len(sequence)-1) else vocab[symbol],
                           symbol=symbol, tokenIndex=owner,
                           wordIndices=[] if owner is None else annotations[owner]['wordIndices'],
                           durationFrames=duration, frameStart=frame, frameEnd=frame + duration,
                           rawStartSeconds=frame / 40, rawEndSeconds=(frame + duration) / 40))
        frame += duration
    previous = 0
    for token, annotation in zip(tokens, annotations):
        start, end = token.start_ts, token.end_ts
        if token.phonemes and start is None:
            raise ValueError('Spoken token has no timestamp')
        if (start is None) != (end is None):
            raise ValueError("Incomplete token timestamp")
        if start is not None:
            if not (math.isfinite(start) and math.isfinite(end) and
                    0 <= start <= end <= audio_samples / SAMPLE_RATE and start >= previous):
                raise ValueError(f"Invalid token timing: {annotation['text']!r}: {start}, {end}")
            previous = end
        annotation.update(start=start, end=end)
        annotation['modelTokenIndices'] = [p['modelTokenIndex'] for p in phones
                                           if p['tokenIndex'] == annotation['index']]
    for word in words:
        owned = [annotations[i] for i in word['tokenIndices']]
        timed = [t for t in owned if t['start'] is not None]
        # A token spanning multiple whitespace words cannot supply separate word
        # boundaries. Keep that ambiguity explicit instead of dividing its time.
        ambiguous = any(len(t['wordIndices']) != 1 for t in owned)
        if timed and not ambiguous:
            word.update(start=min(t['start'] for t in timed), end=max(t['end'] for t in timed))
        word['status'] = 'ambiguous' if ambiguous else ('timed' if timed else 'unspoken')
        word['phonemes'] = ' '.join(t['phonemes'] for t in owned if t['phonemes'])
    return words, annotations, phones


def render_report(report):
    rows, spans = [], []
    for w in report['words']:
        start = '' if w['start'] is None else f"{w['start']:.4f}"
        end = '' if w['end'] is None else f"{w['end']:.4f}"
        spans.append(f'<button data-start="{start}" data-end="{end}" '
                     f'{"disabled" if not start else ""}>{html.escape(w["text"])}</button>')
        rows.append('<tr>' + ''.join(f'<td>{html.escape(str(v))}</td>' for v in
                    [w['index'], w['text'], w['phonemes'], start, end, w['status']]) + '</tr>')
    return '''<!doctype html><meta charset="utf-8"><title>Kokoro word timing prototype</title>
<style>body{font:18px system-ui;max-width:1100px;margin:40px auto;padding:20px}
button{font:inherit;border:0;padding:4px;background:none;cursor:pointer}button.active{background:#ffe16b;color:#111}
table{border-collapse:collapse;width:100%;margin-top:24px}td,th{text-align:left;padding:8px;border-bottom:1px solid #bbb}</style>
<h1>Kokoro word timing prototype</h1><p>Timing comes from synthesis durations. No retranscription.
Word boundaries are experimental; click a word to listen from its estimated start.</p>
<audio controls src="speech.wav"></audio><p>''' + ' '.join(spans) + '''</p>
<p><a href="annotations.json">Full word, tokenizer and phoneme annotations</a></p>
<table><thead><tr><th>Word index</th><th>Original text</th><th>Phonemes</th><th>Start (s)</th><th>End (s)</th><th>Status</th></tr></thead><tbody>''' + ''.join(rows) + '''</tbody></table>
<script>const audio=document.querySelector('audio'), words=[...document.querySelectorAll('button')];
words.forEach(w=>w.onclick=()=>{audio.currentTime=Number(w.dataset.start);audio.play()});
function frame(){words.forEach(w=>w.classList.toggle('active',w.dataset.start!==''&&audio.currentTime>=Number(w.dataset.start)&&audio.currentTime<Number(w.dataset.end)));requestAnimationFrame(frame)}frame();</script>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--text-file', type=Path, default=Path(__file__).with_name('example.txt'))
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('output'))
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--offline', action='store_true', help='Use cached assets only')
    args = parser.parse_args()
    if not math.isfinite(args.speed) or not 0.5 <= args.speed <= 4:
        parser.error('Prototype speed must be between 0.5 and 4')
    if args.offline:
        import os
        os.environ['HF_HUB_OFFLINE'] = '1'
    import numpy as np
    import soundfile as sf
    import torch
    from huggingface_hub import hf_hub_download
    from kokoro import KModel, KPipeline
    import spacy
    # Misaki otherwise tries to install this package implicitly, even offline.
    if not spacy.util.is_package('en_core_web_sm'):
        raise RuntimeError('Install en_core_web_sm from prototype-requirements.txt first')
    torch.set_num_threads(4)
    torch.manual_seed(0)
    assets = {}
    for name in ('config.json', 'kokoro-v1_0.pth', 'voices/af_heart.pt'):
        assets[name] = hf_hub_download(MODEL_REPO, name, revision=MODEL_REVISION,
                                       local_files_only=args.offline)
    model = KModel(repo_id=MODEL_REPO, config=assets['config.json'],
                   model=assets['kokoro-v1_0.pth']).to('cpu').eval()
    pipeline = KPipeline(lang_code='a', repo_id=MODEL_REPO, model=model)
    text = args.text_file.read_text().strip()
    _, tokens = pipeline.g2p(text)
    source_mapping(text, tokens)
    if any(not t.phonemes and any(c.isalnum() for c in t.text) for t in tokens):
        raise ValueError('An alphanumeric text token has no phonemes; refusing to skip it')
    phonemes = pipeline.tokens_to_ps(tokens)
    if not 0 < len(phonemes) <= 510:
        raise ValueError('Use a shorter passage: expected 1–510 phoneme characters')
    if any(symbol not in model.vocab for symbol in phonemes):
        raise ValueError('Unknown phoneme symbol would be dropped by the model')
    voice = torch.load(assets['voices/af_heart.pt'], map_location='cpu', weights_only=True)
    began = time.perf_counter()
    output = pipeline.infer(model, phonemes, voice, args.speed)
    elapsed = time.perf_counter() - began
    pipeline.join_timestamps(tokens, output.pred_dur)
    audio = output.audio.numpy()
    if not np.isfinite(audio).all():
        raise ValueError('Non-finite audio samples')
    words, annotations, phones = annotate(text, tokens, phonemes, output.pred_dur.tolist(),
                                          model.vocab, len(audio))
    report = dict(schemaVersion=1, text=text, voice='af_heart', speed=args.speed,
                  sampleRate=SAMPLE_RATE, audioSamples=len(audio), durationSeconds=len(audio)/SAMPLE_RATE,
                  synthesisSeconds=elapsed, model=dict(repository=MODEL_REPO, revision=MODEL_REVISION),
                  packages={p: importlib.metadata.version(p) for p in
                            ('kokoro', 'misaki', 'torch', 'transformers', 'spacy', 'en_core_web_sm', 'espeakng-loader')},
                  assets={name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in assets.items()},
                  timingMethod='KPipeline.join_timestamps; predicted durations, no transcription',
                  rawPhonemeTiming='Unadjusted 40 Hz model frames; not validated audible onsets',
                  phonemes=phonemes, words=words, tokens=annotations, modelTokens=phones)
    args.output.mkdir(parents=True, exist_ok=True)
    sf.write(args.output / 'speech.wav', audio, SAMPLE_RATE, subtype='PCM_16')
    (args.output / 'annotations.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (args.output / 'index.html').write_text(render_report(report))
    print(f"Saved {len(words)} words, {len(phones)} model tokens, {len(audio)/SAMPLE_RATE:.2f}s audio to {args.output}")
    print(f"Synthesis: {elapsed:.2f}s; ambiguous words: {sum(w['status']=='ambiguous' for w in words)}")


if __name__ == '__main__':
    main()
