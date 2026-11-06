# Reading Quest — bite-size paragraphs, one question each

A child reads one short paragraph (3-6 sentences) and answers one question right under it, about 5 minutes and 5-6
paragraphs a session. The next paragraph is chosen near the child's rating, which goes up and down with each answer
(see `src/Shared/Books/ReadingQuest.cs`). Paragraphs are **written by people, not AI**: public-domain US government
pages and freely licensed (CC BY) children's stories, each with its source. Only the questions are written for this.

After any change run (CI runs it before every release; it must report 0 errors):

    node scripts/passages/validate.mjs            check
    node scripts/passages/validate.mjs --write    also (re)compute each paragraph's readability

## Files

One file per source, e.g. `content/passages/noaa-scijinks.json`:

```json
{
  "source": "NOAA SciJinks",
  "license": "Public domain (US government work)",
  "licenseUrl": "https://scijinks.gov/about/",
  "passages": [
    {
      "id": "scijinks-what-is-a-rainbow",
      "title": "What Is a Rainbow?",
      "kind": "facts",
      "topic": "weather",
      "text": "A rainbow is ... (3-6 sentences, copied from the source)",
      "source": { "name": "NOAA SciJinks", "url": "https://scijinks.gov/rainbow/", "license": "Public domain", "author": null },
      "readability": { "grade": 3.4, "fk": 3.1, "cli": 4.0, "ari": 3.2 },
      "question": {
        "type": "cause-effect",
        "q": "What makes the colors in a rainbow?",
        "choices": ["Sunlight bending in raindrops", "...", "...", "..."],
        "answer": 0,
        "evidence": "exact words from the text that prove the answer",
        "explain": "One short, kind sentence saying why."
      }
    }
  ]
}
```

* `id`: unique across all files, lowercase-with-dashes. Never change a shipped id (children's progress uses it).
* `text`: **3 to 6 sentences, 30 to 120 words**, one paragraph, copied from the source. Allowed edits: cut sentences
  from the start or end, cut a sentence that refers to a picture/link/"click here", fix spacing, and replace
  characters not on a keyboard (curly quotes -> straight, em dash -> --). Don't reword: the point is that people
  wrote these. For CC BY sources, say what was changed in `source.note` (e.g. "shortened").
* `source`: where it came from: page `url`, `license` ("Public domain", "CC BY 4.0", ...), `author` if credited
  (required for CC BY), optional `note`.
* `kind`: `facts`, `story`, `fable` or `poem`. `topic`: animals, space, weather, earth, water, plants, body, history,
  people, places, energy, ocean, friendship, family, ...
* `readability`: written by `--write` (average of Flesch-Kincaid, Coleman-Liau and ARI grades). It is the
  paragraph's difficulty in the rating system, so it is never typed by hand.
* `question`: one, about this paragraph alone, written for the paragraph's difficulty:
  `type` (`detail`, `main-idea`, `vocabulary`, `inference`, `sequence`, `cause-effect` — parents see accuracy by
  type, so mix them), 4 `choices`, `answer` index, `evidence` (exact words from `text`; highlighted after a wrong
  answer), `explain`. Wrong choices as long and believable as the right one; no "of the above"; the validator fails a
  file where the right answer is the longest (or shortest) choice in more than 40% of questions.

## How a quest plays (for reference; rules in `src/Shared/Books/ReadingQuest.cs`)

* Matchmaking like a game rating (Elo / Brawl Stars trophies): each paragraph's difficulty is its readability grade;
  the child's rating moves up after a right answer (more for a hard paragraph) and down after a miss (more for an easy
  one); the next paragraph is picked near the rating, a little above it, and about a grade below after two misses in a
  row. Children see "Level" = whole rating + 1 and a bar to the next level.
* Read first: the answers unlock after about 4 words a second (15-30 seconds); the PC refuses earlier answers.
* A right answer finishes a paragraph for good and pays 1 coin per 100 words (rounded up) x the parent's setting.
  A miss brings the paragraph back 5 answers later as a "second look" (choices reshuffled): no coins, and the rating
  and streak don't change. A second miss retires it.
* Streak: right answers in a row; every N in a row (default 5) is a streak step that pays its number (1, 2, 3, ...).
