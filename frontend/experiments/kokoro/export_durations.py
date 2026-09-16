"""Expose the exact durations consumed by the pinned graph, with parity checks.

No model weights or inference operations are changed. Requires onnx and
onnxruntime. Outputs are experimental; frame geometry is not audible-onset proof.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import onnx
import onnxruntime as ort
from inspect_graph import verify

ROOT = Path(__file__).resolve().parent
DURATION = '/encoder/Gather_output_0'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--voice', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, default=ROOT / 'alignment-fixture.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'model.json').read_text())
    verify(args.model, manifest)
    model = onnx.load(args.model)
    nodes = {out: node for node in model.graph.node for out in node.output}
    if nodes[DURATION].op_type != 'Gather' or nodes[DURATION].input[0] != '/encoder/Cast_output_0':
        raise ValueError('Unexpected duration path')
    if not any(n.op_type == 'CumSum' and n.input[0] == DURATION for n in model.graph.node):
        raise ValueError('Duration output is not the alignment input')
    model.graph.output.append(onnx.helper.make_tensor_value_info(DURATION, onnx.TensorProto.INT64, ['sequence_length']))
    onnx.checker.check_model(model)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, args.output)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    original = ort.InferenceSession(str(args.model), options, providers=['CPUExecutionProvider'])
    exported = ort.InferenceSession(str(args.output), options, providers=['CPUExecutionProvider'])
    fixture = json.loads(args.fixture.read_text())
    ids = [t['modelTokenId'] for t in fixture['modelTokens']]
    styles = np.fromfile(args.voice, dtype='<f4').reshape(-1, 256)
    # ONNX community voice table uses the number of phonemes (without BOS/EOS).
    style_index = min(len(ids) - 2, 509)
    style = styles[style_index:style_index + 1]
    rows = []
    for speed in [.5, 1., 1.5, 4.]:
        inputs = {'input_ids': np.array([ids], dtype=np.int64), 'style': style,
                  'speed': np.array([speed], dtype=np.float32)}
        before = original.run(None, inputs)[0]
        start = time.perf_counter()
        waveform, durations = exported.run(None, inputs)
        elapsed = time.perf_counter() - start
        np.testing.assert_array_equal(before, waveform)
        assert durations.size == len(ids) and (durations >= 1).all()
        assert int(durations.sum()) * 600 == waveform.size
        row = dict(pacing=speed, samples=waveform.size, frames=int(durations.sum()),
                   waveformMaxAbsoluteDifference=float(np.abs(before-waveform).max()),
                   inferenceSeconds=elapsed, durations=durations.tolist())
        if speed == fixture['speed']:
            reference = np.array([t['durationFrames'] for t in fixture['modelTokens']])
            row['pythonDurationMaxFrameDifference'] = int(np.abs(reference-durations).max())
            row['pythonWaveformSamples'] = fixture['audioSamples']
        rows.append(row)
    report = dict(source=manifest, exportSha256=digest(args.output), exportBytes=args.output.stat().st_size,
                  durationOutput=DURATION, voiceSha256=digest(args.voice), fixtureSha256=digest(args.fixture),
                  onnxVersion=onnx.__version__, runtimeVersion=ort.__version__, providers=exported.get_providers(),
                  sampleRate=24000, samplesPerFrame=600, audibleOnsetsValidated=False, measurements=rows)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k != 'measurements'}, indent=2))


if __name__ == '__main__':
    main()
