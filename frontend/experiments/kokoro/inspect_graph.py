"""Inspect the pinned Compact candidate without importing it into the app.

Emits evidence, not an alignment approval. Network access occurs only with
--download. Existing and downloaded model bytes must match the pinned hash.
"""

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from urllib.request import urlopen

import onnx


def verify(path, manifest):
    if path.stat().st_size != manifest["bytes"]:
        raise ValueError("Model size differs from pinned asset")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != manifest["sha256"]:
        raise ValueError("Model SHA-256 differs from pinned asset")


def download(path, manifest):
    url = (f'https://huggingface.co/{manifest["repository"]}/resolve/'
           f'{manifest["revision"]}/{manifest["asset"]}')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as dest:
            temporary = Path(dest.name)
            with urlopen(url, timeout=60) as source:
                received = 0
                while block := source.read(1024 * 1024):
                    received += len(block)
                    if received > manifest["bytes"]:
                        raise ValueError("Download exceeds pinned asset size")
                    dest.write(block)
        verify(temporary, manifest)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def tensor_info(value):
    tensor = value.type.tensor_type
    return {
        "name": value.name,
        "dtype": onnx.TensorProto.DataType.Name(tensor.elem_type),
        "shape": [dim.dim_param if dim.dim_param else dim.dim_value
                  for dim in tensor.shape.dim],
    }


def inspect(path, manifest):
    verify(path, manifest)
    model = onnx.load(str(path), load_external_data=False)
    if any(t.data_location == onnx.TensorProto.EXTERNAL for t in model.graph.initializer):
        raise ValueError("External tensors are not covered by this asset pin")
    onnx.checker.check_model(model)
    return {
        "schemaVersion": 1,
        "model": manifest,
        "inspector": {"onnx": onnx.__version__},
        "opsets": [{"domain": item.domain, "version": item.version}
                   for item in model.opset_import],
        "inputs": [tensor_info(value) for value in model.graph.input],
        "outputs": [tensor_info(value) for value in model.graph.output],
        # These nodes are navigation hints, never presumed word timestamps.
        "durationInspectionCandidates": [
            {"name": node.name, "op": node.op_type, "outputs": list(node.output)}
            for node in model.graph.node
            if node.op_type in ("Round", "CumSum")
        ],
        "alignmentGate": "unvalidated",
        "nextStep": "Trace predicted durations; export them and verify waveform parity before word alignment.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path, help="Local ONNX path (outside source control)")
    parser.add_argument("--download", action="store_true", help="Download the pinned 92,361,116-byte model if absent")
    parser.add_argument("--output", type=Path, help="Write JSON evidence (defaults to stdout)")
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name("model.json").read_text())
    if args.download and not args.model.exists():
        download(args.model, manifest)
    report = json.dumps(inspect(args.model, manifest), indent=2) + "\n"
    if args.output:
        args.output.write_text(report)
    else:
        print(report, end="")


if __name__ == "__main__":
    main()
