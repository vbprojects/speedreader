"""Ten seeded speed samples across the entire speech, with measured WAV durations."""
import ctypes
import argparse
import sys
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

import os
# Bound shape-specific CPU kernel caches for long variable-length passages.
os.environ.setdefault('LRU_CACHE_CAPACITY', '64')
os.environ.setdefault('ONEDNN_PRIMITIVE_CACHE_CAPACITY', '64')

import numpy as np
import soundfile as sf
import torch
from huggingface_hub import hf_hub_download
from kokoro import KModel, KPipeline
from prototype import MODEL_REPO, MODEL_REVISION, SAMPLE_RATE
from streamlit_app import tempo_filter
import imageio_ffmpeg
from filelock import FileLock, Timeout

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output-surface'
SEED = 20260915


def atomic_json(path, data):
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(data, indent=2))
    temporary.replace(path)


def checkpoint_chunk(folder, index, identity, generate):
    """Commit PCM first, metadata last; reuse only matching verified artifacts."""
    folder.mkdir(exist_ok=True)
    wav = folder / f'{index:03d}.wav'
    record = folder / f'{index:03d}.json'
    if record.exists() and wav.exists():
        metadata = json.loads(record.read_text())
        if (metadata['identity'] == identity and
                metadata['sha256'] == hashlib.sha256(wav.read_bytes()).hexdigest()):
            pcm, rate = sf.read(wav, dtype='float32')
            if rate == SAMPLE_RATE and len(pcm) == metadata['frames']:
                return pcm, metadata
    began = time.perf_counter()
    pcm, durations = generate()
    if not np.isfinite(pcm).all():
        raise ValueError('Non-finite synthesis')
    temporary = wav.with_suffix('.wav.tmp')
    sf.write(temporary, pcm, SAMPLE_RATE, format='WAV', subtype='PCM_16')
    temporary.replace(wav)
    metadata = dict(identity=identity, frames=len(pcm), minimum=int((durations == 1).sum()),
                    tokens=len(durations), synthesisSeconds=time.perf_counter()-began,
                    sha256=hashlib.sha256(wav.read_bytes()).hexdigest())
    atomic_json(record, metadata)
    # Use identical quantized PCM for fresh and resumed chunks.
    pcm, _ = sf.read(wav, dtype='float32')
    return pcm, metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--parallel', action='store_true', help='Run two independent two-thread workers')
    parser.add_argument('--shard', type=int, choices=range(2))
    parser.add_argument('--point', type=int, choices=range(1,11))
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True)
    if args.parallel:
        workers = []
        logs = []
        for shard in range(2):
            log = (OUT / f'worker-{shard}.log').open('a')
            logs.append(log)
            workers.append(subprocess.Popen([sys.executable, __file__, '--shard', str(shard)], stdout=log, stderr=subprocess.STDOUT))
        codes = [worker.wait() for worker in workers]
        for log in logs:
            log.close()
        if any(codes):
            raise RuntimeError(f'Worker failed: {codes}; see worker logs')
        rows = [json.loads((OUT / f'point-{i:02d}.json').read_text()) for i in range(1, 11)]
        (OUT / 'results.json').write_text(json.dumps(rows, indent=2))
        plot(rows)
        return
    text = (ROOT / 'arsenalofdemocracy.md').read_text().strip()
    count = len(re.findall(r'\S+', text))
    rng = np.random.default_rng(SEED)
    # Latin hypercube: random positions, with coverage across both slider ranges.
    xy = np.column_stack([(rng.permutation(10) + rng.random(10)) / 10 for _ in range(2)])
    xy = .5 + 3.5 * xy
    manifest = dict(seed=SEED, sampling='10-point Latin hypercube, uniform 0.5–4 on each axis',
                    sourceSha256=hashlib.sha256(text.encode()).hexdigest(), words=count,
                    wordDefinition='Whitespace-delimited source tokens, including standalone punctuation',
                    modelRevision=MODEL_REVISION, voice='af_heart', sampleRate=SAMPLE_RATE,
                    points=xy.tolist(), timing='Full concatenated audio including model silence; no added pauses. Excludes compute/buffering time.')
    manifest_path = OUT / 'manifest.json'
    if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
        raise ValueError('Existing run differs; move output-surface before rerunning')
    manifest_path.write_text(json.dumps(manifest, indent=2))
    torch.set_num_threads(2)
    torch.manual_seed(SEED)
    assets = {n: hf_hub_download(MODEL_REPO, n, revision=MODEL_REVISION, local_files_only=True)
              for n in ['config.json', 'kokoro-v1_0.pth', 'voices/af_heart.pt']}
    model = KModel(repo_id=MODEL_REPO, config=assets['config.json'], model=assets['kokoro-v1_0.pth']).to('cpu').eval()
    pipeline = KPipeline(lang_code='a', repo_id=MODEL_REPO, model=model)
    voice = torch.load(assets['voices/af_heart.pt'], map_location='cpu', weights_only=True)
    chunks = []
    for paragraph in re.split(r'\n\s*\n', text):
        _, tokens = pipeline.g2p(paragraph)
        if re.sub(r'\s+', '', paragraph) != re.sub(r'\s+', '', ''.join(t.text for t in tokens)):
            raise ValueError('Phonemizer changed or dropped source text')
        for t in tokens:
            if not t.phonemes and any(c.isalnum() for c in t.text):
                raise ValueError(f'Unspoken text: {t.text}')
            t.phonemes = t.phonemes or ''
        recovered = []
        for gs, ps, ts in pipeline.en_tokenize(tokens):
            if not 0 < len(ps) <= 510 or any(p not in model.vocab for p in ps):
                raise ValueError(f'Invalid chunk: {gs}')
            chunks.append(dict(text=gs, phonemes=ps))
            recovered.extend(ts)
        if [id(t) for t in recovered] != [id(t) for t in tokens]:
            raise ValueError('Chunking lost or duplicated source tokens')
    (OUT / 'chunks.json').write_text(json.dumps(chunks, ensure_ascii=False, indent=2))
    print(f'{count} words, {len(chunks)} chunks; ten full-speech runs', flush=True)
    rows = []
    held_locks = []
    for i, (pacing, compression) in enumerate(xy):
        if args.point is not None and i + 1 != args.point:
            continue
        result_path = OUT / f'point-{i+1:02d}.json'
        if result_path.exists():
            rows.append(json.loads(result_path.read_text()))
            continue
        lock = FileLock(str(OUT / f'point-{i+1:02d}.lock'))
        try:
            lock.acquire(timeout=0)
        except Timeout:
            continue
        held_locks.append(lock)
        if result_path.exists():
            continue
        original = OUT / f'point-{i+1:02d}-original.wav'
        processed = OUT / f'point-{i+1:02d}-processed.wav'
        frames = minimum = total_tokens = 0
        synth_seconds = 0
        with sf.SoundFile(original, mode='w', samplerate=SAMPLE_RATE, channels=1, subtype='PCM_16') as dest:
            for j, chunk in enumerate(chunks):
                identity = dict(phonemes=chunk['phonemes'], pacing=float(pacing),
                                modelRevision=MODEL_REVISION, voice='af_heart')
                def generate():
                    audio = pipeline.infer(model, chunk['phonemes'], voice, float(pacing))
                    return audio.audio.numpy(), audio.pred_dur.numpy()
                pcm, metadata = checkpoint_chunk(OUT / f'chunks-{i+1:02d}', j, identity, generate)
                dest.write(pcm)
                frames += len(pcm)
                minimum += metadata['minimum']
                total_tokens += metadata['tokens']
                synth_seconds += metadata['synthesisSeconds']
                del pcm
                if sys.platform.startswith('linux'):
                    ctypes.CDLL(None).malloc_trim(0)
                if (j+1) % 10 == 0:
                    print(f'Point {i+1}/10 pacing={pacing:.3f} compression={compression:.3f}: chunk {j+1}/{len(chunks)}', flush=True)
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
                        '-i', str(original), '-af', tempo_filter(float(compression)), '-c:a', 'pcm_s16le', str(processed)], check=True)
        info = sf.info(processed)
        row = dict(point=i+1, pacing=float(pacing), compression=float(compression), words=count,
                   originalSeconds=frames/SAMPLE_RATE, processedSeconds=info.duration,
                   originalWpm=count*60/(frames/SAMPLE_RATE), wpm=count*60/info.duration,
                   synthesisSeconds=synth_seconds, minimumFrameTokenFraction=minimum/total_tokens,
                   originalAudio=original.name, processedAudio=processed.name)
        atomic_json(result_path, row)
        rows.append(row)
        print(f'COMPLETE point {i+1}: {row["wpm"]:.1f} WPM, {info.duration:.1f}s audio, {synth_seconds:.1f}s synthesis', flush=True)
    if args.shard is None and args.point is None:
        (OUT / 'results.json').write_text(json.dumps(rows, indent=2))
        plot(rows)


def plot(rows):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.tri as mtri
    import plotly.graph_objects as go
    x, y, z = np.array([[r['pacing'], r['compression'], r['wpm']] for r in rows]).T
    tri = mtri.Triangulation(x, y)
    fig = plt.figure(figsize=(11, 8))
    ax = fig.add_subplot(111, projection='3d')
    surface = ax.plot_trisurf(tri, z, cmap='viridis', alpha=.75)
    ax.scatter(x, y, z, c='crimson', s=45, depthshade=False)
    for i, (a,b,c) in enumerate(zip(x,y,z)):
        ax.text(a,b,c+15,str(rows[i]['point']))
    ax.set(xlabel='Kokoro phoneme pacing (×)', ylabel='Time compression (×)', zlabel='Observed WPM',
           title=f'Arsenal of Democracy: {len(rows)} full-speech measurements\nTriangular interpolation only within sampled region')
    fig.colorbar(surface, ax=ax, shrink=.5, label='WPM', pad=.13)
    fig.savefig(OUT / 'surface.png', dpi=170, bbox_inches='tight')
    plt.close(fig)
    faces = tri.triangles
    chart = go.Figure([
        go.Mesh3d(x=x,y=y,z=z,i=faces[:,0],j=faces[:,1],k=faces[:,2],intensity=z,
                  colorscale='Viridis',opacity=.65,name='Linear interpolation',showscale=True),
        go.Scatter3d(x=x,y=y,z=z,mode='markers+text',text=[str(r['point']) for r in rows],
                     marker=dict(size=5,color='red'),name='Measured points',
                     hovertemplate='Pacing %{x:.3f}×<br>Compression %{y:.3f}×<br>%{z:.1f} WPM<extra></extra>')])
    chart.update_layout(title=f'Arsenal of Democracy — measured WPM ({len(rows)} points; surface is interpolation)',
                        scene=dict(xaxis_title='Kokoro pacing ×',yaxis_title='Compression ×',zaxis_title='WPM'))
    chart.write_html(OUT / 'surface.html', include_plotlyjs=True)
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
    ordered = sorted(rows, key=lambda r: r['pacing'])
    axes[0].plot([r['pacing'] for r in ordered], [r['originalWpm'] for r in ordered], 'o-')
    axes[0].set(xlabel='Kokoro pacing (×)', ylabel='WPM before compression', title='Kokoro pacing response')
    axes[1].scatter(y, [r['originalSeconds']/r['processedSeconds'] for r in rows])
    axes[1].plot([.5,4],[.5,4], '--', color='gray', label='Requested factor')
    axes[1].set(xlabel='Requested compression (×)', ylabel='Measured duration ratio', title='Audio compression response')
    axes[1].legend()
    fig.tight_layout()
    fig.savefig(OUT / 'responses.png', dpi=170)
    plt.close(fig)
    lines = ['# Arsenal of Democracy: WPM experiment', '',
             f'{len(rows)} completed points; 4,023 whitespace-delimited words per point.', '',
             'WPM uses full processed audio duration, including model silence; compute time is excluded.',
             'The surface interpolates measurements inside the sampled region. This is not an intelligibility test.', '',
             '| Point | Kokoro pacing | Compression | Original WPM | Processed WPM | Tokens at minimum duration |',
             '| --- | --- | --- | --- | --- | --- |']
    for r in rows:
        lines.append(f"| {r['point']} | {r['pacing']:.3f}× | {r['compression']:.3f}× | {r['originalWpm']:.1f} | {r['wpm']:.1f} | {r['minimumFrameTokenFraction']:.1%} |")
    deviation = max(abs(r['wpm']/r['originalWpm']/r['compression']-1) for r in rows)
    lines += ['', f'Maximum relative deviation of measured compression from its requested factor: {deviation:.3%}.', '',
              '[Interactive surface](surface.html) · [CSV](results.csv) · [Separate responses](responses.png)']
    (OUT / 'summary.md').write_text('\n'.join(lines) + '\n')
    import csv
    with (OUT / 'results.csv').open('w') as dest:
        writer = csv.DictWriter(dest, fieldnames=rows[0].keys())
        writer.writeheader(); writer.writerows(rows)


if __name__ == '__main__':
    main()
