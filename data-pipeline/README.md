# Data pipeline

Builds `app/data/ro-sv.json` (learn Swedish) and `app/data/sv-ro.json` (learn Romanian)
from [Tatoeba](https://tatoeba.org) exports (CC BY 2.0 FR). This step is offline only and is never shipped to users.

## Run

```bash
python3 data-pipeline/build_dataset.py
```

Requires Python 3.9+ and only the standard library. On the first run it downloads the
per-language exports into `data-pipeline/raw/`, which is gitignored. Pass `--refresh` to
download them again. Other flags: `--samples N`, `--seed S`, `--raw-dir`, `--out-dir`.

## Sources

Files from `https://downloads.tatoeba.org/exports/per_language/`:
`ron_sentences.tsv.bz2` and `swe_sentences.tsv.bz2` (id, lang, text), plus
`ron-swe_links.tsv.bz2`, `ron-eng_links.tsv.bz2` and `swe-eng_links.tsv.bz2` (id, id).
These are much smaller than the full `sentences.tar.bz2` and `links.tar.bz2` exports, and use the same columns.

## Item format

```json
{"id":"1234","target":"Jag tycker om arabiska.","blank":3,"answer":"arabiska",
 "options":["ryska","arabiska","finska","kinesiska","människa"],
 "hint":"Îmi place limba arabă.","pivot":true,"level":2}
```

- `id`: the Tatoeba id of the target sentence. It stays stable across rebuilds, so saved progress still matches.
- `blank`: the index into the word tokens of `target`, where a word token is a run of letters.
  In JS: `[...target.matchAll(/\p{L}+/gu)][blank]`.
- `level` (1–5): set by a sentence difficulty score. The score is 0.6 × the answer's rarity,
  plus 0.25 × the rarity of the rarest other word (names don't count), plus 0.15 × the sentence length.
  Both rarities are log-scaled frequency ranks. Items are sorted easiest first, and the levels hold
  30 / 25 / 20 / 15 / 10 % of the items.
  The file is in this order, so the app can introduce new items in file order.
- `pivot`: true when the pair was linked through an English sentence rather than directly.
