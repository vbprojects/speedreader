import unittest
import numpy as np
from fit_rational import rational, fit


class RationalFitTests(unittest.TestCase):
    def test_monotonic_bounded_curve_and_half_saturation(self):
        p=np.linspace(0,100,10000)
        y=rational(p,438,1.173)
        self.assertEqual(y[0],0)
        self.assertTrue(np.all(np.diff(y)>0))
        self.assertTrue(np.all(y<438))
        self.assertAlmostEqual(float(rational(1.173,438,1.173)),219)

    def test_recovers_known_parameters(self):
        p=np.linspace(.5,4,10)
        np.testing.assert_allclose(fit(p,rational(p,420,1.2)),[420,1.2],rtol=1e-6)


if __name__ == '__main__':
    unittest.main()
