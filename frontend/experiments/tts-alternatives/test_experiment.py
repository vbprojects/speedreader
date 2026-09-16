import unittest
import numpy as np
from experiment import source_groups, word_times

class AlignmentTests(unittest.TestCase):
    def test_stress_can_change_without_losing_word_ownership(self):
        groups = source_groups('read again', 'ɹˈiːd əɡˌɛn', ['ɹˈiːd', 'əɡˈɛn'])
        self.assertEqual([m.group() for m, _ in groups], ['read', 'again'])

    def test_expansions_and_context_changes_are_not_guessed(self):
        self.assertIsNone(source_groups('$25 today', 'twɛnti faɪv tədeɪ', ['twɛnti faɪv', 'tədeɪ']))
        self.assertIsNone(source_groups('the apple', 'ði æpəl', ['ðə', 'æpəl']))
        self.assertIsNone(source_groups('read now', 'ɹɛd naʊ', ['ɹiːd', 'naʊ']))

    def test_timing_uses_native_duration_sum_including_boundary_gaps(self):
        spans = [dict(text='read', charStart=0, charEnd=4, tokenStart=1, tokenEnd=3),
                 dict(text='now', charStart=5, charEnd=8, tokenStart=4, tokenEnd=5)]
        times = word_times(spans, np.array([100, 200, 300, 50, 400, 100]), 1000)
        self.assertEqual(times[0]['startSeconds'], .1)
        self.assertEqual(times[0]['endSeconds'], .6)
        self.assertEqual(times[1]['startSeconds'], .65)
        self.assertEqual(times[1]['endSeconds'], 1.05)

if __name__ == '__main__':
    unittest.main()
