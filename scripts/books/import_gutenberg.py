#!/usr/bin/env python3
"""
Turn a Project Gutenberg plain-text book into CoinQuest's book format (see content/books/README.md).

    python3 scripts/books/import_gutenberg.py <book-id> <gutenberg.txt>

Each book has its own recipe below (where chapters start, what to drop). The Gutenberg header, footer and license are
removed (the texts are public domain; the Project Gutenberg name and license may not travel with them). Text is cleaned
to characters on a US keyboard, wrapped lines are joined into paragraphs, and illustrations notes are dropped.
Question files are never touched by this script.
"""
import json, re, sys, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'content' / 'books'

SWAPS = [
    (r"[‘’‚‛′`´]", "'"),
    (r"[“”„‟″«»]", '"'),
    (r"[‐‑‒–−­]", '-'),
    (r"[—―]", '--'),
    (r"…", '...'),
    (r"[  -   　\t]", ' '),
    (r"[​-‍﻿]", ''),
]

def keyboard(s: str) -> str:
    s = unicodedata.normalize('NFKD', s)
    s = re.sub(r"[̀-ͯ]", '', s)  # e with accent -> e
    for pat, to in SWAPS:
        s = re.sub(pat, to, s)
    s = s.replace('Æ', 'AE').replace('æ', 'ae').replace('Œ', 'OE').replace('œ', 'oe')
    bad = sorted(set(c for c in s if c != '\n' and not (32 <= ord(c) <= 126)))
    if bad:
        print('  removing:', ' '.join(f'U+{ord(c):04X}' for c in bad))
    return ''.join(c for c in s if c == '\n' or 32 <= ord(c) <= 126)

def body(raw: str) -> str:
    raw = raw.replace('\r', '')
    s = re.search(r"^\*\*\* ?START OF TH[^\n]*\n", raw, re.M)
    e = re.search(r"^\*\*\* ?END OF TH", raw, re.M)
    text = raw[s.end():e.start()] if s and e else raw
    return re.sub(r"^End of (the )?Project Gutenberg.*(\n.+)*", '', text, flags=re.M | re.I)

def paragraphs(text: str, keep_lines=False) -> str:
    """Blank lines separate paragraphs; wrapped lines inside a paragraph are joined (unless keep_lines)."""
    text = re.sub(r"\[Illustration[^\]]*\]", '', text, flags=re.S)
    text = re.sub(r"_([^_]+)_", r"\1", text)      # _italics_
    text = re.sub(r"\[Footnote[^\]]*\]", '', text, flags=re.S)
    paras = []
    for block in re.split(r"\n\s*\n", text):
        lines = [l.strip() for l in block.split('\n') if l.strip()]
        if not lines:
            continue
        paras.append('\n'.join(re.sub(r" {2,}", ' ', l) for l in lines) if keep_lines else re.sub(r"\s+", ' ', ' '.join(lines)))
    return '\n\n'.join(paras).strip() + '\n'

def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", '-', s.lower()).strip('-')
    return s[:40].rstrip('-') or 'chapter'

def title_case(s: str) -> str:
    small = {'a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'from'}
    words = s.lower().split()
    return ' '.join(w if (i and w in small) else w[:1].upper() + w[1:] for i, w in enumerate(words))

# ---- recipes: return [(title, text)] -----------------------------------------------------------------------------

def split_on(text, pattern, title_of, start_after=None):
    if start_after:
        text = text[text.index(start_after) + len(start_after):]
    ms = list(re.finditer(pattern, text, re.M))
    out = []
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        out.append((title_of(m), text[m.end():end]))
    return out

def wind_in_the_willows(t):
    t = t[t.index('\nI. THE RIVER BANK'):]
    return split_on(t, r"^([IVX]+)\. ([A-Z'\"][A-Z'\" .,!-]+)$", lambda m: title_case(m.group(2).strip("'\" ")))

def black_beauty(t):
    t = t[t.index('\nPart I\n\n\n\n\n01 My Early Home'):]
    t = re.sub(r"^Part I+\s*$", '', t, flags=re.M)
    return split_on(t, r"^(\d{2}) (.+)$", lambda m: m.group(2).strip())

def treasure_island(t):
    t = t[t.index('PART ONE--The Old Buccaneer'):]
    t = re.sub(r"^PART [A-Z]+--.*$", '', t, flags=re.M)
    # "N" on its own line, a blank line, then the chapter title.
    return split_on(t, r"^(\d{1,2})\n\n(.+)$", lambda m: m.group(2).strip())

def peter_rabbit(t):
    t = t[t.index('Once upon a time'):]
    return [('The Tale of Peter Rabbit', t.replace('THE END', ''))]

def aesop(t):
    t = t[t.index('\nTHE WOLF AND THE KID'):]
    fables = split_on(t, r"^([A-Z][A-Z ,'\-]{5,})$", lambda m: title_case(m.group(1).strip()))
    fables = [(n, b) for n, b in fables if len(b.split()) > 30]
    out, group = [], []
    for f in fables:
        group.append(f)
        if sum(len(b.split()) for _, b in group) >= 700:
            out.append(group); group = []
    if group:
        out.append(group)
    chapters = []
    for g in out:
        title = g[0][0] + (f' and {len(g) - 1} more' if len(g) > 1 else '')
        text = '\n\n'.join(f'{n.upper()}\n\n{b.strip()}' for n, b in g)
        chapters.append((title, text))
    return chapters

def mcguffey_first(t):
    t = t[t.index('\nLESSON I.'):]
    end = t.find('\nPHONIC CHART')
    if end > 0:
        t = t[:end]
    lessons = split_on(t, r"^LESSON ([IVXLC]+)\.(?: .*)?$", lambda m: m.group(1))
    groups = [lessons[i:i + 6] for i in range(0, len(lessons), 6)]
    chapters = []
    for g in groups:
        def roman(r):
            vals = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100}; n = 0
            for a, b in zip(r, r[1:] + ' '):
                n += -vals[a] if b != ' ' and vals[a] < vals.get(b, 0) else vals[a]
            return n
        first, last = roman(g[0][0]), roman(g[-1][0])
        parts = []
        for r, b in g:
            parts.append(f'LESSON {roman(r)}\n\n' + b.strip())
        chapters.append((f'Lessons {first}-{last}', '\n\n'.join(parts)))
    return chapters

RECIPES = {
    'wind-in-the-willows': (wind_in_the_willows, False),
    'black-beauty': (black_beauty, False),
    'treasure-island': (treasure_island, False),
    'peter-rabbit': (peter_rabbit, False),
    'aesop-for-children': (aesop, False),
    'mcguffey-first-reader': (mcguffey_first, True),
}

def main(book_id, src):
    recipe, keep_lines = RECIPES[book_id]
    text = keyboard(body(Path(src).read_text(encoding='utf-8', errors='replace')))
    chapters = recipe(text)
    d = ROOT / book_id
    d.mkdir(parents=True, exist_ok=True)
    meta_path = d / 'book.json'
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {'id': book_id}
    old = {c['n']: c for c in meta.get('chapters', [])}
    for f in d.glob('*.txt'):
        f.unlink()
    out = []
    for i, (title, raw) in enumerate(chapters, 1):
        txt = paragraphs(raw, keep_lines)
        base = f'{i:02d}-{slug(title)}'
        (d / f'{base}.txt').write_text(txt)
        words = len(txt.split())
        prev = old.get(i, {}) if old.get(i, {}).get('title') == title else {}
        out.append({'n': i, 'title': title, 'text': f'{base}.txt', 'questions': prev.get('questions', f'{base}.questions.json'), 'words': words})
    meta['chapters'] = out
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=True) + '\n')
    print(f'{book_id}: {len(out)} chapters, {sum(c["words"] for c in out)} words')
    for c in out:
        print(f"  {c['n']:2d} {c['words']:5d}  {c['title']}")

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
