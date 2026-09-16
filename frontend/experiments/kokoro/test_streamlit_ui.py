import io
import unittest
from pathlib import Path
import numpy as np
import soundfile as sf
from streamlit.testing.v1 import AppTest
from streamlit_app import compress, tempo_filter


class AudioUiTests(unittest.TestCase):
    def test_compression_preserves_pitch(self):
        rate = 24000
        tone = np.sin(2 * np.pi * 440 * np.arange(rate * 4) / rate) * .3
        buffer = io.BytesIO()
        sf.write(buffer, tone, rate, format='WAV')
        for factor in (.5, 2, 4):
            data, output_rate = sf.read(io.BytesIO(compress(buffer.getvalue(), factor)))
            self.assertEqual(output_rate, rate)
            self.assertAlmostEqual(len(data) / rate, 4 / factor, delta=.15)
            peak = np.argmax(np.abs(np.fft.rfft(data))) * rate / len(data)
            self.assertAlmostEqual(peak, 440, delta=3)
        self.assertEqual(tempo_filter(4), 'atempo=2,atempo=2')

    def test_ui_generates_and_marks_changed_settings(self):
        app = AppTest.from_file(str(Path(__file__).with_name('streamlit_app.py')), default_timeout=120).run()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.slider), 2)
        app.slider[1].set_value(4.0)
        app.button[0].click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.error)
        self.assertEqual(app.session_state['result']['compression'], 4)
        app.slider[0].set_value(1.5).run()
        self.assertTrue(app.info)
        self.assertEqual(app.session_state['result']['pacing'], 1)


if __name__ == '__main__':
    unittest.main()
