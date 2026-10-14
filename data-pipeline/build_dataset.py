#!/usr/bin/env python3
"""Build the RO<->SV cloze datasets from Tatoeba exports.

Outputs app/data/ro-sv.json (learn Swedish) and app/data/sv-ro.json (learn Romanian).
Standard library only. See README.md for usage.
"""
from __future__ import annotations

import argparse
import bz2
import json
import math
import random
import sys
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

BASE_URL = "https://downloads.tatoeba.org/exports/per_language"
SOURCE_FILES = {
    "ron_sentences.tsv.bz2": "ron/ron_sentences.tsv.bz2",
    "swe_sentences.tsv.bz2": "swe/swe_sentences.tsv.bz2",
    "ron-swe_links.tsv.bz2": "ron/ron-swe_links.tsv.bz2",
    "ron-eng_links.tsv.bz2": "ron/ron-eng_links.tsv.bz2",
    "swe-eng_links.tsv.bz2": "swe/swe-eng_links.tsv.bz2",
}

ALPHABETS = {
    "ron": set("abcdefghijklmnopqrstuvwxyzăâîșț"),
    "swe": set("abcdefghijklmnopqrstuvwxyzåäöé"),
}
CEDILLA_FIX = str.maketrans({"ş": "ș", "Ş": "Ș", "ţ": "ț", "Ţ": "Ț"})
COMPOUND_JOINERS = set("-'’")

MIN_WORDS, MAX_WORDS = 3, 15
MAX_ANSWER_RANK = 5000
MAX_DISTRACTOR_RANK = 10000
DISTRACTOR_BANDS = (0.3, 0.5, 0.8, 1.5)
LENGTH_TOLERANCE = 3
# Difficulty = weighted mix of answer rarity, rarest context word and sentence length.
DIFFICULTY_WEIGHTS = {"answer": 0.6, "context": 0.25, "length": 0.15}
CONTEXT_RANK_CAP = 20000
# Cumulative share of items (easiest first) that ends each level 1..5.
LEVEL_SHARES = (0.30, 0.55, 0.75, 0.90, 1.0)


# ---------------------------------------------------------------- text utils

def normalize_text(text: str, lang: str) -> str:
    text = unicodedata.normalize("NFC", text.strip())
    if lang == "ron":
        text = text.translate(CEDILLA_FIX)
    return " ".join(text.split())


def tokenize(text: str) -> list[tuple[str, int, int]]:
    """Return (word, start, end) for every maximal run of letters.

    Matches the app's JS tokenizer: text.matchAll(/\\p{L}+/gu).
    """
    tokens, start = [], None
    for i, ch in enumerate(text):
        if ch.isalpha():
            if start is None:
                start = i
        elif start is not None:
            tokens.append((text[start:i], start, i))
            start = None
    if start is not None:
        tokens.append((text[start:], start, len(text)))
    return tokens


def dedupe_key(text: str) -> str:
    return " ".join(w.lower() for w, _, _ in tokenize(text))


def strip_diacritics(word: str) -> str:
    decomposed = unicodedata.normalize("NFD", word)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def cap_pattern(word: str) -> str:
    if word.islower():
        return "lower"
    if len(word) > 1 and word.isupper():
        return "upper"
    if word[0].isupper() and word[1:].islower():
        return "title"
    return "other"


def apply_pattern(word: str, pattern: str) -> str:
    if pattern == "upper":
        return word.upper()
    if pattern == "title":
        return word[:1].upper() + word[1:]
    return word


def common_prefix(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def common_suffix(a: str, b: str) -> int:
    return common_prefix(a[::-1], b[::-1])


def same_stem(a: str, b: str) -> bool:
    """Likely two inflections of one word, e.g. 'casa'/'casei' or 'hus'/'huset'."""
    return common_prefix(a, b) >= max(3, min(len(a), len(b)) - 2)


def is_compound_part(text: str, start: int, end: int) -> bool:
    """True for pieces of hyphen/apostrophe compounds like 'într-o' or 'm-am'."""
    before = text[start - 1] if start > 0 else ""
    after = text[end] if end < len(text) else ""
    return before in COMPOUND_JOINERS or after in COMPOUND_JOINERS


# ---------------------------------------------------------------- loading

def download(raw_dir: Path, refresh: bool) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    for name, remote in SOURCE_FILES.items():
        dest = raw_dir / name
        if dest.exists() and not refresh:
            continue
        url = f"{BASE_URL}/{remote}"
        print(f"Downloading {url}")
        tmp = dest.with_suffix(".part")
        with urllib.request.urlopen(url, timeout=60) as resp, open(tmp, "wb") as out:
            out.write(resp.read())
        tmp.rename(dest)


def read_tsv(path: Path):
    with bz2.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            yield line.rstrip("\n").split("\t")


def load_sentences(path: Path, lang: str) -> dict[int, str]:
    sentences = {}
    for row in read_tsv(path):
        if len(row) >= 3 and row[1] == lang:
            text = normalize_text(row[2], lang)
            if text:
                sentences[int(row[0])] = text
    return sentences


def load_links(path: Path) -> list[tuple[int, int]]:
    return [(int(r[0]), int(r[1])) for r in read_tsv(path) if len(r) >= 2]


# ---------------------------------------------------------------- language model

@dataclass
class LangStats:
    lang: str
    rank: dict[str, int]          # lowercase word -> 1-based frequency rank
    names: set[str]               # lowercase words that are usually capitalized mid-sentence
    bigrams: set[tuple[str, str]]
    by_rank: list[str]            # eligible vocabulary, index i = rank i+1 (None if ineligible)
    suffix_index: dict[str, list[str]]

    def eligible(self, word: str) -> bool:
        return (
            len(word) >= 2
            and word not in self.names
            and all(c in ALPHABETS[self.lang] for c in word)
        )


def build_lang_stats(lang: str, sentences: dict[int, str]) -> LangStats:
    freq, lower_count, mid_total, mid_caps = Counter(), Counter(), Counter(), Counter()
    bigrams = set()
    for text in sentences.values():
        tokens = tokenize(text)
        for i, (word, start, end) in enumerate(tokens):
            low = word.lower()
            freq[low] += 1
            if word == low:
                lower_count[low] += 1
            if i > 0:
                mid_total[low] += 1
                if word[0].isupper():
                    mid_caps[low] += 1
                prev_word, _, prev_end = tokens[i - 1]
                if text[prev_end:start].strip() == "":
                    bigrams.add((prev_word.lower(), low))

    # Proper nouns: never written in lowercase, or usually capitalized mid-sentence.
    names = {w for w in freq if lower_count[w] == 0}
    names |= {w for w, n in mid_total.items() if mid_caps[w] / n > 0.5}
    ordered = [w for w, _ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))]
    rank = {w: i + 1 for i, w in enumerate(ordered)}

    stats = LangStats(lang, rank, names, bigrams, [], defaultdict(list))
    for word in ordered[:MAX_DISTRACTOR_RANK]:
        ok = stats.eligible(word)
        stats.by_rank.append(word if ok else None)
        if ok:
            for n in (2, 3):
                if len(word) > n:
                    stats.suffix_index[word[-n:]].append(word)
    return stats


# ---------------------------------------------------------------- pairs

@dataclass
class Pair:
    ron_id: int
    swe_id: int
    pivot: bool


def build_pairs(ron, swe, ron_swe, ron_eng, swe_eng) -> tuple[list[Pair], Counter]:
    counts = Counter()
    pairs: dict[tuple[str, str], Pair] = {}

    def add(r, s, pivot):
        if r not in ron or s not in swe:
            return
        counts["pivot_raw" if pivot else "direct_raw"] += 1
        key = (dedupe_key(ron[r]), dedupe_key(swe[s]))
        existing = pairs.get(key)
        # A direct link always wins over a pivot link for the same text pair.
        if existing is None or (existing.pivot and not pivot):
            pairs[key] = Pair(r, s, pivot)

    for r, s in ron_swe:
        add(r, s, False)

    eng_to_ron, eng_to_swe = defaultdict(set), defaultdict(set)
    for r, e in ron_eng:
        eng_to_ron[e].add(r)
    for s, e in swe_eng:
        eng_to_swe[e].add(s)
    for e, ron_ids in eng_to_ron.items():
        for r in ron_ids:
            for s in eng_to_swe.get(e, ()):
                add(r, s, True)

    result = list(pairs.values())
    counts["direct_dedup"] = sum(not p.pivot for p in result)
    counts["pivot_dedup"] = sum(p.pivot for p in result)
    return result, counts


def sentence_ok(text: str, stats: LangStats) -> bool:
    chunks = text.split()
    word_chunks = [c for c in chunks if any(ch.isalpha() for ch in c)]
    if not MIN_WORDS <= len(word_chunks) <= MAX_WORDS:
        return False
    if len(word_chunks) / len(chunks) < 0.8:
        return False
    if any(ch.isdigit() for ch in text):
        return False
    letters = sum(ch.isalpha() for ch in text)
    if letters / len(text.replace(" ", "")) < 0.75:
        return False
    tokens = tokenize(text)
    names = sum(w.lower() in stats.names for w, _, _ in tokens)
    return names / len(tokens) <= 0.34


# ---------------------------------------------------------------- cloze

def choose_blank(text: str, stats: LangStats):
    tokens = tokenize(text)
    counts = Counter(w.lower() for w, _, _ in tokens)
    best = None
    for i, (word, start, end) in enumerate(tokens):
        low = word.lower()
        r = stats.rank.get(low, 10**9)
        if (
            counts[low] == 1
            and r <= MAX_ANSWER_RANK
            and stats.eligible(low)
            and cap_pattern(word) in ("lower", "title", "upper")
            and not is_compound_part(text, start, end)
            and (best is None or r > best[2])
        ):
            best = (i, word, r)
    return best


def fits_context(cand: str, prev_w, next_w, stats: LangStats) -> bool:
    """Heuristic: the candidate is seen with both neighbours, so it may be a valid answer."""
    if prev_w is None or next_w is None:
        return False
    return (prev_w, cand) in stats.bigrams and (cand, next_w) in stats.bigrams


def pick_distractors(text, blank, answer, stats: LangStats, rng: random.Random):
    tokens = tokenize(text)
    in_sentence = {w.lower() for w, _, _ in tokens}
    low = answer.lower()
    pattern = cap_pattern(answer)
    a_rank = stats.rank[low]
    a_stripped = strip_diacritics(low)

    def neighbour(j):
        if not 0 <= j < len(tokens):
            return None
        a, b = sorted((j, blank))
        gap = text[tokens[a][2]:tokens[b][1]]
        return tokens[j][0].lower() if gap.strip() == "" else None

    prev_w, next_w = neighbour(blank - 1), neighbour(blank + 1)

    def acceptable(cand: str) -> bool:
        if cand == low or cand in in_sentence:
            return False
        if abs(len(cand) - len(low)) > LENGTH_TOLERANCE:
            return False
        if strip_diacritics(cand) == a_stripped:
            return False
        # Another inflection of the answer is often also correct.
        if same_stem(cand, low):
            return False
        return not fits_context(cand, prev_w, next_w, stats)

    def suffix_score(cand: str) -> int:
        s = min(common_suffix(cand, low), 3)
        return s if s >= 2 and s < len(low) else 0

    def in_band(cand: str, band: float) -> bool:
        return abs(stats.rank[cand] - a_rank) <= max(band * a_rank, 50)

    # Words sharing the answer's ending, looked up through the suffix index.
    ending_pool = set()
    for n in (3, 2):
        if len(low) > n:
            ending_pool.update(stats.suffix_index.get(low[-n:], ()))
    ending_pool = [w for w in ending_pool if acceptable(w)]

    chosen: list[str] = []

    def take(pool):
        for w in pool:
            if len(chosen) < 4 and not any(same_stem(w, c) for c in chosen):
                chosen.append(w)

    for band in DISTRACTOR_BANDS:
        pool = [w for w in ending_pool if in_band(w, band) and w not in chosen]
        rng.shuffle(pool)
        pool.sort(key=suffix_score, reverse=True)
        take(pool)
        if len(chosen) == 4:
            break

    # Fill any remaining slots from the frequency band, ignoring the ending.
    for band in DISTRACTOR_BANDS + (10.0,):
        if len(chosen) == 4:
            break
        lo = max(1, int(a_rank - max(band * a_rank, 50)))
        hi = min(len(stats.by_rank), int(a_rank + max(band * a_rank, 50)))
        pool = [w for w in stats.by_rank[lo - 1:hi] if w and w not in chosen and acceptable(w)]
        rng.shuffle(pool)
        take(pool)

    if len(chosen) < 4:
        return None
    return [apply_pattern(w, pattern) for w in chosen]


def log_scale(rank: int, cap: int) -> float:
    """Map a frequency rank to 0..1 on a log scale (rank 1 -> 0, cap -> 1)."""
    return math.log(min(rank, cap)) / math.log(cap)


def difficulty(text: str, blank: int, answer_rank: int, stats: LangStats) -> float:
    tokens = tokenize(text)
    # Names (Tom, Mary) are easy to read past, so they don't count as rare context.
    context_ranks = [
        stats.rank.get(w.lower(), CONTEXT_RANK_CAP)
        for i, (w, _, _) in enumerate(tokens)
        if i != blank and w.lower() not in stats.names
    ]
    w = DIFFICULTY_WEIGHTS
    answer = log_scale(answer_rank, MAX_ANSWER_RANK)
    context = log_scale(max(context_ranks, default=1), CONTEXT_RANK_CAP)
    length = (len(text.split()) - MIN_WORDS) / (MAX_WORDS - MIN_WORDS)
    return w["answer"] * answer + w["context"] * context + w["length"] * min(length, 1.0)


def assign_levels(items) -> None:
    """Sort easiest first and split into levels 1..5 by LEVEL_SHARES."""
    items.sort(key=lambda it: (it["_difficulty"], int(it["id"])))
    n = len(items)
    level = 1
    for i, it in enumerate(items):
        while (i + 1) / n > LEVEL_SHARES[level - 1]:
            level += 1
        it["level"] = level


def build_items(pairs, target_sents, hint_sents, target_key, stats: LangStats, seed: str):
    """One item per unique target sentence; prefer direct pairs, then a similar-length hint."""
    groups = defaultdict(list)
    for p in pairs:
        t_id = getattr(p, target_key)
        groups[dedupe_key(target_sents[t_id])].append(p)

    counts = Counter()
    items = []
    for group in groups.values():
        t_id = getattr(group[0], target_key)
        target = target_sents[t_id]
        if not sentence_ok(target, stats):
            counts["rejected_sentence"] += 1
            continue
        h_key = "swe_id" if target_key == "ron_id" else "ron_id"
        t_len = len(target)
        best = min(
            group,
            key=lambda p: (p.pivot, abs(len(hint_sents[getattr(p, h_key)]) - t_len), getattr(p, h_key)),
        )
        hint = hint_sents[getattr(best, h_key)]
        if len(hint.split()) > MAX_WORDS * 2:
            counts["rejected_hint"] += 1
            continue

        picked = choose_blank(target, stats)
        if picked is None:
            counts["no_blank"] += 1
            continue
        blank, answer, rank = picked
        rng = random.Random(f"{seed}:{t_id}")
        distractors = pick_distractors(target, blank, answer, stats, rng)
        if distractors is None:
            counts["no_distractors"] += 1
            continue
        options = [answer] + distractors
        rng.shuffle(options)
        items.append({
            "id": str(t_id),
            "target": target,
            "blank": blank,
            "answer": answer,
            "options": options,
            "hint": hint,
            "pivot": best.pivot,
            "level": 0,
            "_rank": rank,
            "_difficulty": difficulty(target, blank, rank, stats),
        })
        counts["pivot" if best.pivot else "direct"] += 1

    assign_levels(items)
    return items, counts


# ---------------------------------------------------------------- output

def write_json(items, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = [{k: v for k, v in it.items() if not k.startswith("_")} for it in items]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean, f, ensure_ascii=False, separators=(",", ":"))


def format_item(it) -> str:
    words = tokenize(it["target"])
    _, start, end = words[it["blank"]]
    gapped = it["target"][:start] + "_____" + it["target"][end:]
    opts = "  ".join(f"[{o}]" if o == it["answer"] else o for o in it["options"])
    tag = "pivot" if it["pivot"] else "direct"
    return (
        f"#{it['id']}  L{it['level']} difficulty {it['_difficulty']:.2f} answer rank {it['_rank']}  {tag}\n"
        f"   {gapped}\n"
        f"   hint: {it['hint']}\n"
        f"   options: {opts}"
    )


def main() -> int:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw-dir", type=Path, default=here / "raw")
    parser.add_argument("--out-dir", type=Path, default=here.parent / "app" / "data")
    parser.add_argument("--refresh", action="store_true", help="re-download source files")
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--seed", default="lingo")
    args = parser.parse_args()

    download(args.raw_dir, args.refresh)
    raw = args.raw_dir
    ron = load_sentences(raw / "ron_sentences.tsv.bz2", "ron")
    swe = load_sentences(raw / "swe_sentences.tsv.bz2", "swe")
    print(f"Sentences: ron={len(ron)} swe={len(swe)}")

    ron_stats = build_lang_stats("ron", ron)
    swe_stats = build_lang_stats("swe", swe)
    print(f"Vocabulary: ron={len(ron_stats.rank)} swe={len(swe_stats.rank)} types")

    pairs, pc = build_pairs(
        ron, swe,
        load_links(raw / "ron-swe_links.tsv.bz2"),
        load_links(raw / "ron-eng_links.tsv.bz2"),
        load_links(raw / "swe-eng_links.tsv.bz2"),
    )
    print(
        f"Pairs: direct {pc['direct_raw']} raw -> {pc['direct_dedup']} unique, "
        f"pivot {pc['pivot_raw']} raw -> {pc['pivot_dedup']} unique"
    )

    directions = [
        ("ro-sv", "swe_id", swe, ron, swe_stats),  # learn Swedish
        ("sv-ro", "ron_id", ron, swe, ron_stats),  # learn Romanian
    ]
    for name, target_key, targets, hints, stats in directions:
        items, c = build_items(pairs, targets, hints, target_key, stats, args.seed)
        write_json(items, args.out_dir / f"{name}.json")
        size = (args.out_dir / f"{name}.json").stat().st_size
        levels = Counter(it["level"] for it in items)
        print(f"\n=== {name}: {len(items)} items ({size / 1024:.0f} KB)")
        print(f"   direct {c['direct']}, pivot {c['pivot']}")
        print(
            f"   rejected: sentence filter {c['rejected_sentence']}, hint {c['rejected_hint']}, "
            f"no blank {c['no_blank']}, no distractors {c['no_distractors']}"
        )
        print("   levels: " + ", ".join(f"L{k}={levels[k]}" for k in sorted(levels)))

        rng = random.Random(args.seed)
        print(f"\n--- {args.samples} random {name} items ---")
        for it in rng.sample(items, min(args.samples, len(items))):
            print(format_item(it))
    return 0


if __name__ == "__main__":
    sys.exit(main())
