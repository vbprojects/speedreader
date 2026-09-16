"""Mapping regressions; runs without Kokoro/model downloads."""
import unittest
from types import SimpleNamespace as Token
from prototype import source_mapping, annotate, render_report


def token(text, phonemes='', whitespace='', start=None, end=None):
    return Token(text=text, phonemes=phonemes, whitespace=whitespace, start_ts=start, end_ts=end)


class MappingTests(unittest.TestCase):
    def test_currency_expansion_and_contraction(self):
        words, mapped = source_mapping("$25 don't", [token('$'), token('25', 'twenty five dollars'),
                                                    token('do', 'd'), token("n't", 'ont')])
        self.assertEqual(words[0]['tokenIndices'], [0, 1])
        self.assertEqual(words[1]['tokenIndices'], [2, 3])
        self.assertEqual(mapped[1]['wordIndices'], [0])

    def test_unicode_offsets_and_repeated_words(self):
        words, _ = source_mapping('👋 go go', [token('👋'), token('go'), token('go')])
        self.assertEqual([w['charStart'] for w in words], [0, 2, 5])
        self.assertEqual([w['utf16Start'] for w in words], [0, 3, 6])

    def test_no_guessing_when_tokenizer_rewrites_or_drops_source(self):
        for text, tokens in [('25', [token('twenty')]), ('go go', [token('go')])]:
            with self.assertRaises(ValueError):
                source_mapping(text, tokens)

    def test_symbol_ownership_and_boundaries(self):
        tokens = [token('$'), token('25', 'ab', ' ', .1, .3), token('go', 'c', '', .3, .4)]
        words, _, phones = annotate('$25 go', tokens, 'ab c', [1]*6,
                                    {'a': 1, 'b': 2, ' ': 3, 'c': 4}, 24000)
        self.assertEqual([p['wordIndices'] for p in phones], [[], [0], [0], [], [1], []])
        self.assertEqual(words[0]['start'], .1)
        self.assertEqual(words[0]['end'], .3)
        with self.assertRaises(ValueError):
            annotate('$25 go', tokens, 'ab c', [1]*5, {'a': 1, 'b': 2, ' ': 3, 'c': 4}, 24000)

    def test_merged_words_are_explicitly_ambiguous(self):
        words, _, _ = annotate('in fact', [token('in fact', 'a', '', .1, .2)],
                               'a', [1]*3, {'a': 1}, 24000)
        self.assertTrue(all(w['status'] == 'ambiguous' and w['start'] is None for w in words))

    def test_bad_timing_rejected_and_html_escaped(self):
        with self.assertRaises(ValueError):
            annotate('go', [token('go', 'a', '', 0, 2)], 'a', [1]*3, {'a': 1}, 24000)
        with self.assertRaises(ValueError):
            annotate('go', [token('go', 'a')], 'a', [1]*3, {'a': 1}, 24000)
        report = {'words': [dict(index=0, text='<img>', phonemes='<', start=0, end=1, status='timed')]}
        self.assertNotIn('<img>', render_report(report))
        self.assertIn('&lt;img&gt;', render_report(report))


if __name__ == '__main__':
    unittest.main()
