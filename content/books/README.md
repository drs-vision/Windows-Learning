# CoinQuest books

Public-domain books for the **Reading** quest: a child reads (or types) a chapter, then takes a short quiz on it.
Everything here is plain files so a person or another AI can read, fix or add to it without the app.

```
content/books/
  README.md                         this file
  schema/book.schema.json           JSON Schema for book.json
  schema/questions.schema.json      JSON Schema for a chapter's questions file
  <book-id>/
    book.json                       the book: title, author, level, source, chapter list
    01-<slug>.txt                   chapter 1 text
    01-<slug>.questions.json        chapter 1 question bank
    02-<slug>.txt ...
```

## book.json

```json
{
  "id": "black-beauty",
  "title": "Black Beauty",
  "author": "Anna Sewell",
  "published": 1877,
  "level": 3,
  "grade": { "min": 4, "max": 6, "label": "Grades 4-6" },
  "summary": "One or two plain sentences a parent reads when choosing books.",
  "source": { "name": "Project Gutenberg eBook #271 (...)", "url": "https://www.gutenberg.org/ebooks/271" },
  "publicDomain": "First published 1877; in the US public domain (published before 1931).",
  "chapters": [
    { "n": 1, "title": "My Early Home", "text": "01-my-early-home.txt", "questions": "01-my-early-home.questions.json", "words": 777 }
  ]
}
```

* `level` is the reading level children see: 1 is easiest, and books of about the same difficulty share a level.
  Children only ever see "Level N" (no grades, so nobody feels behind). The app sorts the shelf by it.
  Levels follow the published ATOS book levels (below), nudged for old-fashioned language or dialect. Current scale:
  1 = Beatrix Potter tales (ATOS ~3.5-4.7); 2 = Aesop, The Tailor of Gloucester (5.3); 3 = Doctor Dolittle (5.1);
  4 = The Jungle Book (7.5), Black Beauty (7.7), The Call of the Wild (8.0), Treasure Island (8.3);
  5 = Kidnapped (7.6, heavy Scots dialect), The Wind in the Willows (8.2), Around the World in Eighty Days (9.6).
* `readability` (book and each chapter): Flesch-Kincaid, Coleman-Liau and ARI grades and their average, written by
  `node scripts/books/readability.mjs` (the validator fails if they're missing or out of date with the text).
* `measures` (optional): published difficulty, each with the `url` of the page the number came from and an optional
  `note` (e.g. another edition's value): `lexile` { value, code ("AD", "NC", ...), url } (MetaMetrics) and `atos`
  { level, interest ("LG"/"MG"/"UG"), url } (Renaissance Accelerated Reader). Only record values from a page you
  opened; leave a measure out rather than guess.
* `grade.min` / `grade.max` are approximate US school grades (0 = kindergarten), shown to parents only as a hint.
* `edited` (optional): if the text differs from the original, say what changed and why (see doctor-dolittle).
* `words` is the chapter's word count (whitespace-separated). It sets the quiz length (below).

## Chapter text (`NN-slug.txt`)

* Plain text, **only characters on a US keyboard** (ASCII 32-126 plus newlines): straight quotes, `--` for a long
  dash, `...` for an ellipsis, no accented letters. A child may be asked to *type* the chapter, so every character
  must be typeable. `scripts/books/validate.mjs` rejects anything else.
* Paragraphs are separated by one blank line. No notes, illustrations or page numbers.
* Use the original public-domain wording only: no modern introductions, footnotes or edited versions. The one
  exception is a passage unsuitable for children (e.g. racial slurs or caricature), which may be reworded in the
  spirit of later editions and recorded in `edited`. Hand edits are lost if the importer is re-run on that book.
* `scripts/books/import_gutenberg.py <book-id> <file.txt>` builds the text files and the chapter list from a
  Project Gutenberg plain-text file (it removes the Gutenberg header, license and name, which may not be shipped).

## Questions (`NN-slug.questions.json`)

```json
{
  "book": "black-beauty",
  "chapter": 1,
  "questions": [
    {
      "id": "black-beauty-01-01",
      "type": "detail",
      "q": "What did Black Beauty drink when he was very young?",
      "choices": ["His mother's milk", "Water from the pond", "Milk from a bucket", "Rain water"],
      "answer": 0,
      "evidence": "I lived upon my mother's milk"
    }
  ]
}
```

* `choices`: exactly **4** different answers; `answer` is the index of the right one. The app shuffles the order
  every time a question is shown, so the right answer can be listed first.
* `evidence`: a short phrase copied **exactly** from the chapter text that proves the answer (the validator checks
  that it appears in the chapter, ignoring case and spacing). It keeps questions honest and lets a reviewer check one
  in seconds.
* `type`: `detail` (what happened / who / where), `vocabulary` (what a word means here), `sequence` (what happened
  first / next), `character` (why someone did something, how they felt), `inference` (what you can tell from the
  text), `main-idea` (what the chapter or fable is mostly about, or its lesson).
* `id`: `<book-id>-<chapter 2 digits>-<question 2 digits>`, unique in the book. Never reuse an id for a different
  question (children's progress remembers which questions they have seen).
* Keep questions answerable from **this chapter alone**, at the book's level, with one clearly right answer and
  three wrong answers that are believable but clearly wrong to someone who read it. Avoid "all of the above",
  "none of the above", trick wording and questions about tiny details nobody would remember.
* **No giveaways:** the wrong choices must be as long, specific and detailed as the right one, so "pick the longest
  answer" doesn't work. The validator fails a chapter where the right answer is the longest (or the shortest) choice in more than 40%
  of its questions (by chance it would be about 25%). Also avoid wrong choices that are silly or obviously off-topic.
* Same keyboard-only character rule as the text.

### How many questions

* Quiz length for a chapter = `clamp(round(words / 250), 4, 10)` (at least 4, so one wrong answer can still pass).
* The bank must hold **at least 1.5x** the quiz length (aim for about 1.75x-2x), so retakes draw a different mix.
  Questions a child hasn't seen by the time they pass become optional **bonus** questions.

## Rules the app applies (for reference)

* Pass mark: 70%. Coins on a pass = correct answers on that attempt x the parent's coins per correct answer.
* A failed quiz starts a wait (10 minutes by default, parent-adjustable) before a retake; the child can reread.
* After passing, unseen questions can be answered as bonus questions (each correct one pays the same).
* Typing mode: the child types the chapter in parts and also earns the passage-typing rate (1 coin per N words).

Check everything with `node scripts/books/validate.mjs` (also run in CI).
