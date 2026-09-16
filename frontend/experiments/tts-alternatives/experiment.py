"""CPU feasibility experiment; no ASR, no production-reader changes.

Exports native token timing, conservative source-word mappings, audio comparisons,
and timing measurements. Browser throughput and perceptual accuracy are separate gates.
"""
import argparse
import ast
import csv
import hashlib
import html
import json
import os
import platform
from pathlib import Path
import re
import subprocess
import time
import urllib.request

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
import imageio_ffmpeg
from download import ROOT, CACHE, download

TEXT = 'The quick brown fox jumps over the lazy dog. We can read this passage aloud and follow each word as the voice speaks.'
KITTEN_SOURCE = 'https://raw.githubusercontent.com/KittenML/KittenTTS/be5758500b731b8fc674acc62ea480d3022b7ebe/kittentts/onnx_model.py'


def kitten_helpers():
    path = CACHE / 'kitten-tokenizer.py'
    if not path.exists():
        urllib.request.urlretrieve(KITTEN_SOURCE, path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != 'a996db686ff7e919b3f31407c4adda27644b42805921a080ca2db9d91fa1558a':
        raise ValueError('Pinned Kitten tokenizer source checksum mismatch')
    tree = ast.parse(path.read_text())
    # Load only the pinned upstream vocabulary and tokenizer; avoid pulling in
    # the unrelated torch/spacy preprocessing stack. No text normalization here.
    selected = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))
                and n.name in ('TextCleaner', 'basic_english_tokenize')]
    scope = {}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), 'exec'), scope)
    return scope['TextCleaner'](), scope['basic_english_tokenize']


def source_groups(text, phrase, individual):
    """Map only when whitespace groups match per-word pronunciations.

    Ignore primary/secondary stress differences only. Any lexical/normalization
    disagreement yields no word timestamps, rather than guessed ownership.
    """
    words = list(re.finditer(r'\S+', text))
    groups = phrase.split()
    canonical = lambda s: re.sub('[ˈˌ]', '', s.strip())
    if len(groups) != len(words) or any(canonical(a) != canonical(b) for a, b in zip(groups, individual)):
        return None
    return [(m, group) for m, group in zip(words, groups)]


def session(model, threads):
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    return ort.InferenceSession(model, options, providers=['CPUExecutionProvider'])


class Kitten:
    rate = 24000
    def __init__(self, name, threads):
        import espeakng_loader
        os.environ['ESPEAK_DATA_PATH'] = espeakng_loader.get_data_path()
        from phonemizer.backend.espeak.wrapper import EspeakWrapper
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        from phonemizer.backend import EspeakBackend
        self.g2p = EspeakBackend('en-us', preserve_punctuation=True, with_stress=True)
        self.clean, self.tokenize = kitten_helpers()
        self.root = CACHE / name
        self.config = json.loads((self.root / 'config.json').read_text())
        self.voice = self.config['voice_aliases']['Bella']
        self.styles = np.load(self.root / 'voices.npz')[self.voice]
        self.path = self.root / self.config['model_file']
        self.session = session(str(self.path), threads)

    def prepare(self, text, pacing):
        raw = self.g2p.phonemize([text])[0].strip()
        groups = source_groups(text, raw, self.g2p.phonemize(text.split()))
        phonemes = ' '.join(self.tokenize(raw))
        unknown = set(phonemes) - self.clean.word_index_dictionary.keys()
        if unknown:
            raise ValueError(f'Unsupported Kitten phonemes: {unknown}')
        ids = [0] + self.clean(phonemes) + [10, 0]
        spans = []
        if groups:
            parts = [' '.join(self.tokenize(group)) for _, group in groups]
            if ' '.join(parts) == phonemes:
                cursor = 1
                for (match, _), part in zip(groups, parts):
                    end = cursor + len(self.clean(part))
                    spans.append(dict(text=match.group(), charStart=match.start(), charEnd=match.end(), tokenStart=cursor, tokenEnd=end))
                    cursor = end + 1
        row = min(len(text), len(self.styles) - 1)
        feeds = dict(input_ids=np.array([ids], dtype=np.int64), style=self.styles[row:row + 1],
                     speed=np.array([pacing * self.config['speed_priors'][self.voice]], dtype=np.float32))
        return feeds, spans, ids, phonemes

    def run(self, feeds):
        pcm, durations = self.session.run(['waveform', 'duration'], feeds)
        samples = durations.reshape(-1).astype(np.int64) * 600
        if samples.sum() != pcm.size:
            raise ValueError('Kitten duration geometry does not match raw waveform')
        # Keep all samples. Upstream generate_single_chunk strips 5000 samples;
        # this experiment does not silently cut off speech or alignment spans.
        return pcm.reshape(-1), samples


class Piper:
    def __init__(self, name, threads, model_path=None):
        from piper.phonemize_espeak import EspeakPhonemizer, ESPEAK_DATA_DIR
        from piper.patch_voice_with_alignment import add_alignment_output
        self.g2p = EspeakPhonemizer(ESPEAK_DATA_DIR)
        self.path = Path(model_path) if model_path else CACHE / name / 'en_US-lessac-low.onnx'
        self.config = json.loads(self.path.with_suffix('.onnx.json').read_text())
        self.rate = self.config['audio']['sample_rate']
        model = onnx.load(self.path)
        self.duration_output = add_alignment_output(model)
        self.session = session(model.SerializeToString(), threads)

    def phonemes(self, text):
        return ' '.join(''.join(s) for s in self.g2p.phonemize('en-us', text))

    def prepare(self, text, pacing):
        raw = self.phonemes(text)
        groups = source_groups(text, raw, [self.phonemes(w) for w in text.split()])
        mapping = self.config['phoneme_id_map']
        ids = mapping['^'] + mapping['_']
        offsets = [len(ids)]
        for ph in raw:
            if ph not in mapping:
                raise ValueError(f'Unsupported Piper phoneme: {ph}')
            ids += mapping[ph] + mapping['_']
            offsets.append(len(ids))
        ids += mapping['$']
        spans = []
        if groups:
            matches = list(re.finditer(r'\S+', raw))
            for (word, _), ph in zip(groups, matches):
                spans.append(dict(text=word.group(), charStart=word.start(), charEnd=word.end(),
                                  tokenStart=offsets[ph.start()], tokenEnd=offsets[ph.end()]))
        cfg = self.config['inference']
        feeds = dict(input=np.array([ids], dtype=np.int64), input_lengths=np.array([len(ids)], dtype=np.int64),
                     scales=np.array([cfg['noise_scale'], cfg['length_scale'] / pacing, cfg['noise_w']], dtype=np.float32))
        return feeds, spans, ids, raw

    def run(self, feeds):
        pcm, frames = self.session.run(['output', self.duration_output], feeds)
        samples = np.rint(frames.reshape(-1) * 256).astype(np.int64)
        if samples.sum() != pcm.size:
            raise ValueError('Piper duration geometry does not match waveform')
        return pcm.reshape(-1), samples


def word_times(spans, samples, rate):
    boundaries = np.concatenate(([0], np.cumsum(samples)))
    return [dict(wordIndex=i, **span, startSeconds=float(boundaries[span['tokenStart']] / rate),
                 endSeconds=float(boundaries[span['tokenEnd']] / rate)) for i, span in enumerate(spans)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', nargs='+', choices=['kitten-int8', 'kitten-fp32', 'piper'], default=['kitten-int8', 'kitten-fp32', 'piper'])
    parser.add_argument('--text-file', type=Path)
    parser.add_argument('--pacing', nargs='+', type=float, default=[1, 2])
    parser.add_argument('--compression', nargs='+', type=float, default=[1, 2])
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--output', type=Path, default=ROOT / 'output')
    args = parser.parse_args()
    if args.threads < 1 or args.repeats < 1 or any(not np.isfinite(x) or not .5 <= x <= 4 for x in args.pacing + args.compression):
        parser.error('Positive threads/repeats required; experimental speed range is 0.5–4')
    text = args.text_file.read_text().strip() if args.text_file else TEXT
    if not text or len(text) > 1000:
        parser.error('Supply a short nonempty passage (at most 1000 characters), not a full book')
    download()
    args.output.mkdir(parents=True, exist_ok=True)
    rows, cards = [], []
    for name in args.models:
        begin = time.perf_counter()
        adapter = (Piper if name == 'piper' else Kitten)(name, args.threads)
        initialization = time.perf_counter() - begin
        for pacing in args.pacing:
            begin = time.perf_counter()
            feeds, spans, ids, phonemes = adapter.prepare(text, pacing)
            preprocessing = time.perf_counter() - begin
            durations, first = [], None
            for repeat in range(args.repeats + 1):
                begin = time.perf_counter()
                pcm, samples = adapter.run(feeds)
                elapsed = time.perf_counter() - begin
                if repeat == 0:
                    first = elapsed
                else:
                    durations.append(elapsed)
            assert len(samples) == len(ids) and np.all(samples >= 0) and np.isfinite(pcm).all()
            native_words = word_times(spans, samples, adapter.rate)
            stem = f'{name}-p{pacing:g}'
            native_file = args.output / f'{stem}-c1.wav'
            sf.write(native_file, pcm, adapter.rate, subtype='PCM_16')
            for compression in args.compression:
                file = args.output / f'{stem}-c{compression:g}.wav'
                begin = time.perf_counter()
                if compression != 1:
                    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-y', '-i', str(native_file),
                                    '-af', f'atempo={compression}', str(file)], check=True)
                dsp_seconds = time.perf_counter() - begin
                count = sf.info(file).frames
                seconds = count / adapter.rate
                row = dict(model=name, modelBytes=adapter.path.stat().st_size, pacing=pacing, compression=compression,
                           wordCount=len(text.split()), tokens=len(ids), sampleRate=adapter.rate, audioSeconds=seconds,
                           wpm=len(text.split()) * 60 / seconds, initSeconds=initialization, textSeconds=preprocessing,
                           firstInferenceSeconds=first, warmMedianSeconds=float(np.median(durations)),
                           warmSeconds=durations, dspSeconds=dsp_seconds,
                           productionPlaybackRatio=(float(np.median(durations)) + preprocessing + dsp_seconds) / seconds,
                           nativeWordAlignment='verified-phoneme-ownership' if spans else 'unavailable-ownership-mismatch',
                           waveform=file.name, phonemes=phonemes, inputIds=ids, nativeTokenSamples=samples.tolist(),
                           nativeWords=native_words, outputWords=native_words if compression == 1 else [],
                           compressedAlignment='native' if compression == 1 else 'unavailable-atempo-has-no-source-map',
                           durationGeometryVerified=True)
                (args.output / f'{stem}-c{compression:g}.json').write_text(json.dumps(row, indent=2) + '\n')
                rows.append(row)
                cards.append(f'<section><h2>{html.escape(stem)} · compression {compression:g}×</h2><p>{row["wpm"]:.0f} WPM; generation/playback {row["productionPlaybackRatio"]:.2f}; alignment: {row["nativeWordAlignment"]}</p><audio controls src="{file.name}"></audio><p><a href="{file.stem}.json">Timing annotations</a></p><div class="words" data-annotations="{file.stem}.json"></div></section>')
                print(name, pacing, compression, round(row['productionPlaybackRatio'], 3), row['nativeWordAlignment'], flush=True)
            # Save incrementally so completed models survive interruption.
            (args.output / 'results.json').write_text(json.dumps(dict(text=text, runtime=ort.__version__, threads=args.threads, platform=platform.platform(), repeats=args.repeats, tokenizerSource=KITTEN_SOURCE, tokenizerSha256=hashlib.sha256((CACHE / 'kitten-tokenizer.py').read_bytes()).hexdigest() if (CACHE / 'kitten-tokenizer.py').exists() else None, rows=rows), indent=2) + '\n')
    fields = ['model', 'modelBytes', 'pacing', 'compression', 'audioSeconds', 'wpm', 'initSeconds', 'textSeconds', 'firstInferenceSeconds', 'warmMedianSeconds', 'dspSeconds', 'productionPlaybackRatio', 'nativeWordAlignment']
    with (args.output / 'results.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); writer.writeheader(); writer.writerows(rows)
    (args.output / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>TTS alternatives</title><style>body{max-width:850px;margin:40px auto;font:16px system-ui}section{border-top:1px solid #bbb;padding:12px}audio{width:100%}</style><h1>TTS alternatives</h1><p>Native CPU experiment; no ASR. Compressed clips have no validated word timestamps. Timing is not listening validation.</p><blockquote>' + html.escape(text) + '</blockquote>' + ''.join(cards) + VIEWER)

VIEWER = """<script>
for (const node of document.querySelectorAll('.words')) {
  fetch(node.dataset.annotations).then(r => r.json()).then(data => {
    if (!data.outputWords.length) {
      node.textContent = 'Word highlighting unavailable for this clip; native annotations remain in JSON.';
      return;
    }
    const spans = data.outputWords.map(word => {
      const span = document.createElement('span'); span.textContent = word.text + ' ';
      span.title = word.startSeconds.toFixed(3) + '–' + word.endSeconds.toFixed(3) + ' s';
      node.append(span); return span;
    });
    const audio = node.closest('section').querySelector('audio');
    audio.addEventListener('timeupdate', () => data.outputWords.forEach((word, i) => {
      spans[i].style.background = audio.currentTime >= word.startSeconds && audio.currentTime < word.endSeconds ? '#ffdb70' : '';
    }));
  }).catch(error => {node.textContent = String(error);});
}
</script>"""

if __name__ == '__main__':
    main()
