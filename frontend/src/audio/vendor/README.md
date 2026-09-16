# Vendored pronunciation/token metadata

`headtts/` contains unmodified MIT-licensed language modules, with their pinned
revision and license in that directory. Application normalization wraps them.

`kokoro-vocabulary.json` is the `model.vocab` object extracted from:
https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/blob/1939ad2a8e416c0acfeecc08a694d14ef25f2231/tokenizer.json

Model/tokenizer license: Apache-2.0. The adapter rejects unsupported phonemes;
it never uses the upstream tokenizer's silent text truncation. The only explicitly
excluded orthographic separators are apostrophe and hyphen, with token offsets
remapped after exclusion.
