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
    def cap(w):
        k = len(w) - len(w.lstrip('"\'('))
        return w[:k] + w[k:k + 1].upper() + w[k + 1:]
    return ' '.join(w if (i and w in small) else cap(w) for i, w in enumerate(words))

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


def split_long(chapters, most=5000):
    """Break a very long chapter or story into parts at a paragraph, so one sitting stays about a Treasure Island chapter."""
    out = []
    for title, text in chapters:
        paras = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
        words = sum(len(p.split()) for p in paras)
        pieces = -(-words // most)
        if pieces <= 1:
            out.append((title, text)); continue
        target, cur, n, part = words / pieces, [], 0, 1
        for p in paras:
            cur.append(p); n += len(p.split())
            if n >= target and part < pieces:
                out.append((f'{title} (part {part})', '\n\n'.join(cur))); cur, n, part = [], 0, part + 1
        out.append((f'{title} (part {part})', '\n\n'.join(cur)))
    return out

POTTER_START = {
    'benjamin-bunny': 'One morning a little rabbit', 'squirrel-nutkin': 'This is a Tale about a tail', 'jemima-puddle-duck': 'What a funny sight',
    'mrs-tiggy-winkle': 'Once upon a time there was a little girl', 'jeremy-fisher': 'Once upon a time there was a frog',
    'tom-kitten': 'Once upon a time there were three', 'two-bad-mice': 'Once upon a time there was a very beautiful',
    'flopsy-bunnies': 'It is said', 'mrs-tittlemouse': 'Once upon a time there was a wood', 'timmy-tiptoes': 'Once upon a time there was a little fat',
    'johnny-town-mouse': 'Johnny Town-mouse was born', 'ginger-and-pickles': 'Once upon a time there was a village', 'tailor-of-gloucester': 'In the time of swords',
}

def potter(t, book_id):
    """A Beatrix Potter tale: from its first line (POTTER_START) to THE END (or the back-cover title)."""
    m = re.search(re.escape(POTTER_START[book_id]), t, re.I)
    t = t[m.start():]
    ends = [i for i in (t.find('THE END'), t.find('\nTHE TALE OF'), t.find('\nTHE TAILOR OF')) if i > 0]
    t = t[:min(ends)] if ends else t
    # Some printings start each page in capitals ("ONCE upon a time"): write those words normally.
    t = re.sub(r"(^|\n)([A-Z])([A-Z]+)(?=[ ,'][a-z])", lambda m: m.group(1) + m.group(2) + m.group(3).lower(), t)
    return [(None, t)]

def call_of_the_wild(t):
    t = t[t.index('\nChapter I. Into the Primitive'):]
    return split_on(t, r"^Chapter [IVX]+\. (.+)$", lambda m: m.group(1).strip())

def kidnapped(t):
    t = t[t.index('\nCHAPTER I\n'):]
    return split_on(t, r"^CHAPTER [IVXL]+\n\n(.+)$", lambda m: title_case(m.group(1).strip()))

def around_the_world(t):
    t = t[t.index('\nChapter I\n'):]
    return split_on(t, r"^Chapter [IVXL]+\n\n+((?:.+\n)+)", lambda m: title_case(' '.join(m.group(1).split()).rstrip('.')))

def doctor_dolittle(t):
    t = t[t.index('\nTHE FIRST CHAPTER'):]
    return split_on(t, r"^THE [A-Z-]+ CHAPTER\n\n(.+)$", lambda m: title_case(m.group(1).strip()))

def jungle_book(t):
    stories = ["Mowgli's Brothers", "Kaa's Hunting", '"Tiger! Tiger!"', 'The White Seal', '"Rikki-Tikki-Tavi"', 'Toomai of the Elephants', "Her Majesty's Servants"]
    t = t[t.index("\nMowgli's Brothers\n"):]
    pat = '^(' + '|'.join(re.escape(s) for s in stories) + ')$'
    chapters = split_on(t, pat, lambda m: m.group(1).strip('"'))
    # The songs and verses are indented; the stories are prose. Keep the prose (quizzes and typing are about the story).
    def prose(text):
        keep = [b for b in re.split(r"\n\s*\n", text) if not all(l.startswith('  ') or not l.strip() for l in b.split('\n'))]
        # ...and the song titles left behind (a short line with no full stop, e.g. "Parade Song of the Camp Animals").
        return '\n\n'.join(b for b in keep if not (len(b.split()) <= 8 and not re.search(r"[.!?\"']\s*$", b.strip())))
    return split_long([(n, prose(b)) for n, b in chapters])

RECIPES = {
    'wind-in-the-willows': (wind_in_the_willows, False),
    'black-beauty': (black_beauty, False),
    'treasure-island': (treasure_island, False),
    'peter-rabbit': (peter_rabbit, False),
    'aesop-for-children': (aesop, False),
    'call-of-the-wild': (call_of_the_wild, False),
    'kidnapped': (kidnapped, False),
    'around-the-world-in-80-days': (around_the_world, False),
    'doctor-dolittle': (doctor_dolittle, False),
    'jungle-book': (jungle_book, False),
}
POTTER = ['benjamin-bunny', 'squirrel-nutkin', 'jemima-puddle-duck', 'mrs-tiggy-winkle', 'jeremy-fisher', 'tom-kitten', 'two-bad-mice',
          'flopsy-bunnies', 'mrs-tittlemouse', 'timmy-tiptoes', 'johnny-town-mouse', 'ginger-and-pickles', 'tailor-of-gloucester']
for _b in POTTER:
    RECIPES[_b] = (potter, False)

def main(book_id, src):
    recipe, keep_lines = RECIPES[book_id]
    text = keyboard(body(Path(src).read_text(encoding='utf-8', errors='replace')))
    chapters = recipe(text, book_id) if recipe is potter else recipe(text)
    d = ROOT / book_id
    d.mkdir(parents=True, exist_ok=True)
    meta_path = d / 'book.json'
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {'id': book_id}
    old = {c['n']: c for c in meta.get('chapters', [])}
    for f in d.glob('*.txt'):
        f.unlink()
    out = []
    for i, (title, raw) in enumerate(chapters, 1):
        title = title or meta.get('title', book_id)
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
