"""Rebuild the pinned US-English single-speaker browser catalog (no model downloads)."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

REV = '1162a9173d0ce503555aed757976b7a9912eae4c'
ROOT = f'https://huggingface.co/rhasspy/piper-voices/resolve/{REV}/'

def read(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()

def entry(item):
    key, voice = item
    path = next(p for p in voice['files'] if p.endswith('.onnx'))
    config_bytes = read(ROOT + path + '.json')
    config = json.loads(config_bytes)
    if config.get('phoneme_type', 'espeak') != 'espeak':
        raise ValueError(f'{key}: unsupported phoneme type')
    tree = json.loads(read(f'https://huggingface.co/api/models/rhasspy/piper-voices/tree/{REV}/' + path.rsplit('/', 1)[0]))
    model = next(f for f in tree if f['path'] == path)
    return dict(id='piper_lessac' if key == 'en_US-lessac-low' else 'piper_' + key,
                name=voice['name'], language='en_US', quality=voice['quality'], sampleRate=config['audio']['sample_rate'],
                path=path, modelBytes=model['size'], modelSha256=model['lfs']['oid'],
                configBytes=len(config_bytes), configSha256=hashlib.sha256(config_bytes).hexdigest(),
                modelCard=ROOT + path.rsplit('/', 1)[0] + '/MODEL_CARD')

if __name__ == '__main__':
    voices = json.loads(read(ROOT + 'voices.json'))
    selected = [(k, v) for k, v in voices.items() if k.startswith('en_US-') and v['num_speakers'] == 1]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        rows = sorted(pool.map(entry, selected), key=lambda x: (x['name'], x['quality']))
    dest = Path(__file__).resolve().parents[2] / 'src/audio/piper-catalog.json'
    dest.write_text(json.dumps(dict(revision=REV, voices=rows), indent=2) + '\n')
    print(f'Wrote {len(rows)} voice variants to {dest}')
