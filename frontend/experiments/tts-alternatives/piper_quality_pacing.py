"""Repeat the identical Piper pacing experiment across published Lessac quality tiers."""
import argparse
import csv
import json
import subprocess
import sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'output-quality-pacing')
    parser.add_argument('--repeats', type=int, default=5)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--text-file', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows, summaries, provenance = [], [], []
    for quality in ['low', 'medium', 'high']:
        output = args.output / quality
        command = [sys.executable, str(ROOT/'piper_pacing.py'), '--quality', quality,
                   '--output', str(output), '--repeats', str(args.repeats), '--threads', str(args.threads)]
        if args.text_file:
            command += ['--text-file', str(args.text_file)]
        print(f'Running {quality}…', flush=True)
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        result = json.loads((output/'results.json').read_text())
        rows += [dict(quality=quality, **r) for r in result.pop('rows')]
        provenance.append(result)
        summaries += [dict(quality=quality, **r) for r in json.loads((output/'summary.json').read_text())]
        (args.output/'results.json').write_text(json.dumps(dict(provenance=provenance, rows=rows), indent=2)+'\n')
        print(f'Completed {quality}', flush=True)
    with (args.output/'results.csv').open('w') as f:
        writer = csv.DictWriter(f, fieldnames=[k for k in rows[0] if k != 'tokenFrames'], extrasaction='ignore')
        writer.writeheader(); writer.writerows(rows)
    (args.output/'summary.json').write_text(json.dumps(summaries, indent=2)+'\n')
    fig, axes = plt.subplots(1, 2, figsize=(12, 5), sharey=True)
    for ax, mode, title in zip(axes, ['production-noise', 'zero-noise-control'], ['Default model noise', 'Zero-noise control']):
        for quality in ['low', 'medium', 'high']:
            subset = [r for r in summaries if r['quality'] == quality and r['mode'] == mode]
            ax.errorbar([r['pacing'] for r in subset], [r['meanWpm'] for r in subset],
                        yerr=[r['sdWpm'] for r in subset], marker='o', capsize=3, label=quality.title())
        ax.set(title=title, xlabel='Native pacing multiplier'); ax.grid(alpha=.25); ax.legend()
    axes[0].set_ylabel('Words per minute')
    fig.suptitle(f'Piper Lessac · {rows[0]["words"]} words · compression 1× · {args.repeats} repeats per point')
    fig.tight_layout(); fig.savefig(args.output/'pacing.svg'); fig.savefig(args.output/'pacing.png', dpi=160)
    (args.output/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Piper quality pacing</title><h1>Piper quality versus pacing</h1><img style="max-width:100%" src="pacing.svg" alt="WPM against pacing for Low, Medium and High"><p>Same passage, native CPU ONNX, compression 1×. Error bars: run-to-run standard deviation. Extra low is unavailable for English in the pinned catalog. Separate trained models; quality is not an isolated parameter. No retranscription. This is not browser performance or cross-text calibration.</p><a href="results.csv">CSV</a> · <a href="results.json">Runs and provenance</a>')
    for quality in ['low', 'medium', 'high']:
        print(quality, [(r['pacing'], round(r['meanWpm'], 1)) for r in summaries if r['quality']==quality and r['mode']=='production-noise' and r['pacing'] in [1,2,4]])

if __name__ == '__main__':
    main()
