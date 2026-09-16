"""Isolate Piper native pacing at compression=1; repeated stochastic and deterministic controls."""
import argparse
import csv
import hashlib
import urllib.request
import json
import platform
import random
import time
from pathlib import Path
import numpy as np
import onnxruntime as ort
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from experiment import Piper, TEXT, ROOT


def model_for_quality(quality):
    catalog = json.loads((ROOT.parents[1] / 'src/audio/piper-catalog.json').read_text())
    voice = next(v for v in catalog['voices'] if v['name'] == 'lessac' and v['quality'] == quality)
    path = ROOT / 'assets/catalog' / Path(voice['path']).name
    path.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/rhasspy/piper-voices/resolve/{catalog['revision']}/{voice['path']}"
    for dest, source, digest in [(path, url, voice['modelSha256']),
                                 (Path(str(path)+'.json'), url+'.json', voice['configSha256'])]:
        if not dest.exists():
            urllib.request.urlretrieve(source, dest)
        if hashlib.sha256(dest.read_bytes()).hexdigest() != digest:
            raise ValueError(f'Integrity mismatch: {dest}')
    return path, voice


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--quality', choices=['low', 'medium', 'high'], default='low')
    parser.add_argument('--pacing', nargs='+', type=float, default=[.5, .75, 1, 1.25, 1.5, 2, 2.5, 3, 4])
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--text-file', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'output-pacing')
    args = parser.parse_args()
    if args.repeats < 2 or args.threads < 1 or any(not np.isfinite(p) or not .5 <= p <= 4 for p in args.pacing):
        parser.error('Use repeats >=2, threads >=1, pacing between 0.5 and 4')
    text = args.text_file.read_text().strip() if args.text_file else TEXT
    if not text or len(text) > 1000:
        parser.error('Supply 1–1000 characters; use short passages to match browser chunks')
    args.output.mkdir(parents=True, exist_ok=True)
    model_path, voice = model_for_quality(args.quality)
    adapter = Piper('piper', args.threads, model_path)
    adapter.run(adapter.prepare(text, 1)[0])  # Warmup excluded.
    jobs = [(mode, pacing, repeat) for mode in ['production-noise', 'zero-noise-control']
            for pacing in sorted(set(args.pacing)) for repeat in range(args.repeats)]
    random.Random(2026).shuffle(jobs)
    rows = []
    for mode, pacing, repeat in jobs:
        feeds, _, ids, _ = adapter.prepare(text, pacing)
        if mode == 'zero-noise-control':
            feeds['scales'][[0, 2]] = 0
        start = time.perf_counter()
        pcm, samples = adapter.run(feeds)
        elapsed = time.perf_counter() - start
        seconds = len(pcm) / adapter.rate
        rows.append(dict(mode=mode, pacing=pacing, repeat=repeat, compression=1,
                         words=len(text.split()), tokens=len(ids), audioSeconds=seconds,
                         wpm=60 * len(text.split()) / seconds, inferenceSeconds=elapsed,
                         tokenFrames=(samples // 256).tolist()))
        (args.output / 'results.json').write_text(json.dumps(dict(model=f'en_US-lessac-{args.quality}', quality=args.quality, modelSha256=voice['modelSha256'], configSha256=voice['configSha256'], text=text,
            runtime=ort.__version__, platform=platform.platform(), threads=args.threads,
            sampleRate=adapter.rate, randomOrderSeed=2026, rows=rows), indent=2) + '\n')
    with (args.output / 'results.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=[k for k in rows[0] if k != 'tokenFrames'], extrasaction='ignore')
        writer.writeheader(); writer.writerows(rows)
    fig, ax = plt.subplots(figsize=(9, 5))
    summary = []
    for mode in ['production-noise', 'zero-noise-control']:
        subset = [r for r in rows if r['mode'] == mode]
        paces = sorted(set(r['pacing'] for r in subset))
        means = [np.mean([r['wpm'] for r in subset if r['pacing'] == p]) for p in paces]
        std = [np.std([r['wpm'] for r in subset if r['pacing'] == p], ddof=1) for p in paces]
        ax.errorbar(paces, means, yerr=std, marker='o', capsize=4, label=mode + ' (mean ± SD)')
        summary += [dict(mode=mode, pacing=p, meanWpm=float(m), sdWpm=float(s)) for p,m,s in zip(paces,means,std)]
    ax.set(xlabel='Native pacing multiplier (length_scale ÷ pacing)', ylabel='Words per minute',
           title=f'Piper Lessac {args.quality.title()} · {len(text.split())} words · compression 1× · {args.repeats} repeats')
    ax.grid(alpha=.25); ax.legend(); fig.tight_layout()
    fig.savefig(args.output / 'pacing.svg'); fig.savefig(args.output / 'pacing.png', dpi=160)
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2)+'\n')
    (args.output / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Piper pacing</title><h1>Piper pacing vs WPM</h1><img src="pacing.svg" alt="Native pacing versus measured words per minute"><p>CPU ONNX, one short passage, compression fixed at 1×. Error bars are run-to-run standard deviation, not confidence intervals. Zero noise is a control, not the production voice configuration. WPM includes model punctuation pauses and silence. No retranscription.</p><a href="results.csv">Raw CSV</a> · <a href="results.json">Token durations and provenance</a>')
    print(json.dumps(summary, indent=2))

if __name__ == '__main__':
    main()
