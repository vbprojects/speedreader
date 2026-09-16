import tempfile
import unittest
from pathlib import Path
import numpy as np
from benchmark_surface import checkpoint_chunk


class CheckpointTests(unittest.TestCase):
    def test_reuses_verified_pcm_and_regenerates_corrupt_or_changed_chunks(self):
        calls = []
        def generate():
            calls.append(1)
            return np.array([0, .2, -.2], dtype=np.float32), np.array([1, 2, 1])
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            first, meta = checkpoint_chunk(folder, 0, {'pacing': 1}, generate)
            resumed, _ = checkpoint_chunk(folder, 0, {'pacing': 1}, generate)
            np.testing.assert_array_equal(first, resumed)
            self.assertEqual(len(calls), 1)
            self.assertEqual(meta['minimum'], 2)
            (folder / '000.wav').write_bytes(b'partial')
            checkpoint_chunk(folder, 0, {'pacing': 1}, generate)
            self.assertEqual(len(calls), 2)
            checkpoint_chunk(folder, 0, {'pacing': 2}, generate)
            self.assertEqual(len(calls), 3)


if __name__ == '__main__':
    unittest.main()
