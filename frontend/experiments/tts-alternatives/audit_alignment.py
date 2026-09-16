"""Check source ownership separately from audio duration geometry; no ASR."""
import json
from experiment import ROOT, TEXT, Kitten, Piper

CASES = [TEXT, "Dr. Smith paid $25.50 for three books.", "I don't think they're overpriced.",
         'The apple is on the table.', 'The well-known reader said, “Let us read again!”']
rows = []
for name, adapter in [('kitten-fp32', Kitten('kitten-fp32', 2)), ('piper', Piper('piper', 2))]:
    for text in CASES:
        try:
            _, spans, ids, phonemes = adapter.prepare(text, 1)
            row = dict(model=name, text=text, sourceWords=len(text.split()), mappedWords=len(spans),
                       status='verified-phoneme-ownership' if spans else 'unavailable-ownership-mismatch',
                       phonemes=phonemes, tokenCount=len(ids))
        except Exception as error:
            row = dict(model=name, text=text, status='unsupported', reason=str(error))
        rows.append(row)
        print(name, row['status'], text, flush=True)
(ROOT / 'alignment-audit.json').write_text(json.dumps(rows, indent=2) + '\n')
