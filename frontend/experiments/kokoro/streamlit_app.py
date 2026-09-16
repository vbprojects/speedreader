"""Run: streamlit run frontend/experiments/kokoro/streamlit_app.py"""
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

import imageio_ffmpeg
import soundfile as sf
import streamlit as st

ROOT = Path(__file__).resolve().parent


def tempo_filter(factor):
    """Keep every atempo stage <=2 to avoid FFmpeg's >2 sample-skipping path."""
    if not math.isfinite(factor) or not 0.5 <= factor <= 4:
        raise ValueError('Compression must be between 0.5 and 4')
    stages = []
    while factor > 2:
        stages.append('atempo=2')
        factor /= 2
    stages.append(f'atempo={factor:.8g}')
    return ','.join(stages)


@st.cache_data(max_entries=8, show_spinner=False)
def synthesize(text, pacing):
    # Separate process keeps PyTorch state isolated between concurrent sessions.
    # Cache key excludes compression: changing only compression reuses synthesis.
    with tempfile.TemporaryDirectory(prefix='kokoro-ui-') as folder:
        folder = Path(folder)
        source = folder / 'text.txt'
        source.write_text(text)
        result = subprocess.run(
            [sys.executable, str(ROOT / 'prototype.py'), '--text-file', str(source),
             '--speed', str(pacing), '--output', str(folder)],
            capture_output=True, text=True, timeout=180,
        )
        if result.returncode:
            raise RuntimeError(result.stderr[-3000:] or result.stdout[-3000:])
        return (folder / 'speech.wav').read_bytes(), json.loads((folder / 'annotations.json').read_text())


@st.cache_data(max_entries=16, show_spinner=False)
def compress(wav, factor):
    if factor == 1:
        return wav
    with tempfile.TemporaryDirectory(prefix='kokoro-tempo-') as folder:
        source, target = Path(folder) / 'source.wav', Path(folder) / 'result.wav'
        source.write_bytes(wav)
        result = subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-hide_banner', '-loglevel', 'error',
             '-i', str(source), '-af', tempo_filter(factor), '-c:a', 'pcm_s16le', str(target)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode:
            raise RuntimeError(result.stderr)
        return target.read_bytes()


def main():
    st.set_page_config(page_title='Kokoro speed lab', page_icon='🔊')
    st.title('Kokoro speed lab')
    st.write('Compare faster speech generation with pitch-preserving audio compression.')
    text = st.text_area('Text to read', (ROOT / 'example.txt').read_text().strip(), height=130,
                        help='Use a short English passage; the prototype supports up to 510 phoneme characters.')
    pacing = st.slider('Kokoro phoneme pacing', 0.5, 4.0, 1.0, 0.1, format='%.1fx',
                       help='Changes phoneme durations during synthesis. High values may weaken word endings.')
    compression = st.slider('Pitch-preserving time compression', 0.5, 4.0, 1.0, 0.1, format='%.1fx',
                            help='Processes the generated audio. 2x plays it in roughly half the time; 0.5x slows it down.')
    st.caption('Start with Kokoro at 1x and increase compression to compare word endings. Audio never autoplays.')
    if st.button('Generate speech', type='primary', disabled=not text.strip()):
        try:
            with st.spinner('Generating and processing speech…'):
                original, annotations = synthesize(text.strip(), pacing)
                processed = compress(original, compression)
            st.session_state['result'] = dict(original=original, processed=processed,
                                              annotations=annotations, text=text, pacing=pacing,
                                              compression=compression)
        except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            st.error(f'Could not generate speech: {error}')
    if 'result' not in st.session_state:
        return
    result = st.session_state['result']
    if (text, pacing, compression) != (result['text'], result['pacing'], result['compression']):
        st.info('Controls have changed. Press Generate speech to update the audio below.')
    st.subheader(f"Result: Kokoro {result['pacing']:.1f}x · compression {result['compression']:.1f}x")
    original_info = sf.info(io.BytesIO(result['original']))
    processed_info = sf.info(io.BytesIO(result['processed']))
    st.write(f'Before compression: {original_info.duration:.2f}s · After: {processed_info.duration:.2f}s')
    st.audio(result['processed'], format='audio/wav')
    st.download_button('Download processed WAV', result['processed'], 'kokoro-processed.wav', 'audio/wav')
    with st.expander('Compare original synthesis'):
        st.audio(result['original'], format='audio/wav')
    with st.expander('Original word and phoneme annotations'):
        st.caption('These timestamps refer to the original synthesis. Compression changes timing; precise processed word boundaries are not validated.')
        st.dataframe(result['annotations']['words'], hide_index=True)
        st.download_button('Download original annotations', json.dumps(result['annotations'], ensure_ascii=False, indent=2),
                           'original-annotations.json', 'application/json')


if __name__ == '__main__':
    main()
