# Reading Quest — bite-size paragraphs, one question each

A child reads one short paragraph (a few sentences) and answers one question right under it, then the next one comes
up: there is no set length, the child reads as many as they like (the daily coin limit caps pay, not reading). The next paragraph is chosen near the child's rating, which goes up and down with each answer
(see `src/Shared/Books/ReadingQuest.cs`). Paragraphs are **written by people, not AI**: public-domain US government
pages and freely licensed (CC BY) children's stories, each with its source. Only the questions are written for this.

After any change run (CI runs it before every release; it must report 0 errors):

    node scripts/passages/validate.mjs            check
    node scripts/passages/validate.mjs --write    also (re)compute each paragraph's readability

## Files

Paragraphs are grouped by difficulty, one file per band: `k1.json` (kindergarten-grade 1), `g1.json` ... `g8.json`
(about that grade and up). The band is just for tidiness: the app uses each paragraph's own measured difficulty.

```json
{
  "about": "Reading Quest paragraphs, readability grade 3-4",
  "passages": [
    {
      "id": "asp-a-very-tall-man",
      "title": "A Very Tall Man",
      "kind": "story",
      "topic": "people",
      "text": "His hoe was too short. His doorway was too low. ...",
      "source": { "name": "African Storybook", "url": "https://github.com/global-asp/asp-source/blob/master/en/...", "license": "CC BY 4.0", "author": "Cornelius Gulere", "note": "Whole story; illustrations not included." },
      "readability": { "grade": 1.2, "fk": 0.9, "cli": 2.1, "ari": 0.6 },
      "question": { "type": "detail", "q": "...", "choices": ["...", "...", "...", "..."], "answer": 0, "evidence": "...", "explain": "..." }
    }
  ]
}
```

Where the paragraphs come from (all written by people; only the questions were written for CoinQuest):

* **CC BY 4.0 picture books** from African Storybook, Pratham Books / StoryWeaver and Storybooks Canada, via the
  `global-asp/asp-source`, `pb-source` and `sbc-source` repositories on GitHub. Credit (`author`, plus the
  translator in `note` if any) is required. Whole short stories, or a few consecutive pages ("excerpt").
* **Public-domain children's books** in plain early-1900s English, via the GITenberg mirrors of Project Gutenberg:
  Thornton W. Burgess (Burgess Animal Book, Burgess Bird Book, Mother West Wind books), James Baldwin (Fifty Famous
  Stories Retold, Fifty Famous People), J.-H. Fabre (The Story-Book of Science), H. W. van Loon (The Story of Mankind).
  Paragraphs with outdated science or dated attitudes about people are left out.
* US-government kids' science pages (NASA Knows, NOAA Ocean Facts, USGS, NPS, EIA) are public domain and would be a
  good addition; they need fetching from the web, which the build workspace can't do by itself.

* `id`: unique across all files, lowercase-with-dashes. Never change a shipped id (children's progress uses it).
* `text`: **30 to 120 words, 3 to 12 (short) sentences**, one paragraph, copied from the source. Allowed edits: cut sentences
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
  type, so mix them), 4 `choices`, `answer` index, `evidence` (exact words from `text`; highlighted only after a
  second-look miss, when the paragraph is retired), `explain` (for parents/maintainers; children never see it, and a
  first miss reveals nothing because the paragraph comes back). Wrong choices as long and believable as the right one; no "of the above"; the validator fails a
  file where the right answer is the longest (or shortest) choice in more than 40% of questions.

## How a quest plays (for reference; rules in `src/Shared/Books/ReadingQuest.cs`)

* Matchmaking like a game rating (Elo / Brawl Stars trophies): each paragraph's difficulty is its readability grade;
  the child's rating moves up after a right answer (more for a hard paragraph) and down after a miss (more for an easy
  one); the next paragraph is picked near the rating, a little above it, and about a grade below after two misses in a
  row. Children see "Level" (1 below a rating of 2, then the whole rating) and a bar to the next level.
* Read first: the answers unlock after about 4 words a second (15-30 seconds); the PC refuses earlier answers.
* A right answer finishes a paragraph for good and pays 1 coin per 100 words (rounded up) x the parent's setting.
  A miss brings the paragraph back 5 answers later as a "second look" (choices reshuffled): no coins, and the rating
  and streak don't change. A second miss retires it.
* Streak: right answers in a row fill a ring split into N parts (default 2); a full ring adds 1 to the number in its
  middle and pays that number (1, 2, then 3 at most). A miss empties the ring and resets the number.
