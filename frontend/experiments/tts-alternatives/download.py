"""Download pinned experiment assets, keeping large files outside git."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / 'assets'
MODELS = {
    'kitten-int8': ('KittenML/kitten-tts-nano-0.8-int8', '84781d74e29ee25217551556398b42f80593a813', ['config.json', 'kitten_tts_nano_v0_8.onnx', 'voices.npz']),
    'kitten-fp32': ('KittenML/kitten-tts-nano-0.8-fp32', '7a1db645b1f3ab9420761d87428e042b9cec3f26', ['config.json', 'kitten_tts_nano_v0_8.onnx', 'voices.npz']),
    'piper': ('rhasspy/piper-voices', '1162a9173d0ce503555aed757976b7a9912eae4c', ['en/en_US/lessac/low/en_US-lessac-low.onnx', 'en/en_US/lessac/low/en_US-lessac-low.onnx.json', 'en/en_US/lessac/low/MODEL_CARD']),
}

def download():
    manifest = ROOT / "assets-manifest.json"
    previous = {(x["model"], x["file"]): x for x in json.loads(manifest.read_text())} if manifest.exists() else {}
    records = []
    for name, (repo, revision, files) in MODELS.items():
        for file in files:
            dest = CACHE / name / Path(file).name
            dest.parent.mkdir(parents=True, exist_ok=True)
            url = f'https://huggingface.co/{repo}/resolve/{revision}/{file}'
            if not dest.exists():
                print('Downloading', name, file, flush=True)
                temporary = dest.with_suffix(dest.suffix + '.partial')
                urllib.request.urlretrieve(url, temporary)
                temporary.replace(dest)
            digest = hashlib.sha256(dest.read_bytes()).hexdigest()
            expected = previous.get((name, dest.name))
            if expected and (expected['url'] != url or expected['sha256'] != digest):
                raise ValueError(f'Asset integrity mismatch: {dest}. Check the pinned manifest before retrying.')
            records.append(dict(model=name, file=dest.name, url=url, bytes=dest.stat().st_size, sha256=digest))
    (ROOT / 'assets-manifest.json').write_text(json.dumps(records, indent=2) + '\n')

if __name__ == '__main__':
    download()
