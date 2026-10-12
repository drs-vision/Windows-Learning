// Sound Keys — course content. Pure data + pure functions only (this file is bundled into the Guardian's scorer).
//
// Teaching method (the same idea Read, Write & Type is built on, with original content):
//   one SOUND ↔ one LETTER ↔ one FINGER, learned together, then used straight away in real words,
//   then typed from hearing alone. Letters are ordered so that real words are possible as early as possible
//   while the hands stay on the home row.

export type Finger = 'L5' | 'L4' | 'L3' | 'L2' | 'R2' | 'R3' | 'R4' | 'R5' | 'T';

/** One colour per finger, used everywhere (keyboard, hands, letter cards). Consistency matters more than beauty. */
export const FINGER_COLOR: Record<Finger, string> = {
  L5: '#a78bfa', L4: '#60a5fa', L3: '#34d399', L2: '#fbbf24',
  R2: '#fb923c', R3: '#f472b6', R4: '#22d3ee', R5: '#a3e635', T: '#cbd5e1',
};
export const FINGER_NAME: Record<Finger, string> = {
  L5: 'left pinky', L4: 'left ring finger', L3: 'left middle finger', L2: 'left pointer finger',
  R2: 'right pointer finger', R3: 'right middle finger', R4: 'right ring finger', R5: 'right pinky', T: 'thumb',
};

export const KEY_FINGER: Record<string, Finger> = {};
for (const [keys, f] of [
  ['`1qaz', 'L5'], ['2wsx', 'L4'], ['3edc', 'L3'], ['4rfv5tgb', 'L2'],
  ['6yhn7ujm', 'R2'], ['8ik,', 'R3'], ['9ol.', 'R4'], ["0p;/-['=]\\", 'R5'], [' ', 'T'],
] as const) for (const k of keys) KEY_FINGER[k] = f as Finger;

/** A sound unit: usually one letter; digraphs (sh, ch, th, ng, ck) are two keys that make one sound. */
export interface SoundUnit {
  id: string;          // 'f', 'sh'
  keys: string;        // what gets typed
  keyword: string;     // a word that starts (or, for x/ng/ck, ends) with the sound
  emoji: string;
  say: string;         // what the voice says after the sound, e.g. "f, like fish"
  audio: string;       // phoneme clip id (content/sounds/phonemes/<audio>.mp3)
}

const U = (id: string, keyword: string, emoji: string, say?: string, audio?: string): SoundUnit =>
  ({ id, keys: id, keyword, emoji, say: say ?? `${id}, like ${keyword}`, audio: audio ?? id });

export const SOUNDS: Record<string, SoundUnit> = Object.fromEntries([
  U('f', 'fish', '🐟'), U('a', 'apple', '🍎'), U('d', 'dog', '🐶'), U('s', 'sun', '☀️'),
  U('j', 'jam', '🍓'), U('k', 'kite', '🪁'), U('l', 'leaf', '🍃'), U('g', 'goat', '🐐'), U('h', 'hat', '🎩'),
  U('e', 'egg', '🥚'), U('i', 'insect', '🐜'), U('r', 'rabbit', '🐰'), U('t', 'tiger', '🐯'), U('u', 'umbrella', '☂️'), U('o', 'octopus', '🐙'),
  U('w', 'web', '🕸️'), U('y', 'yo-yo', '🪀'), U('p', 'pig', '🐷'), U('q', 'queen', '👑', 'q, like queen. Q almost always comes with u: qu'),
  U('n', 'nest', '🪺'), U('m', 'moon', '🌙'), U('c', 'cat', '🐱'), U('v', 'van', '🚐'), U('b', 'ball', '⚽'),
  U('x', 'fox', '🦊', 'x, at the end of fox'), U('z', 'zebra', '🦓'),
  U('sh', 'ship', '🚢', 's h together say sh, like ship'), U('ch', 'chick', '🐥', 'c h together say ch, like chick'),
  U('th', 'thumb', '👍', 't h together say th, like thumb'), U('ng', 'ring', '💍', 'n g together say ng, at the end of ring'),
  U('ck', 'duck', '🦆', 'c k together say k, at the end of duck', 'k'),
].map((u) => [u.id, u]));

/** Decodable words with pictures where a picture is clear. Only words whose letters are all known get used. */
export const WORDS: [string, string][] = [
  ['dad', '👨'], ['sad', '😢'], ['add', '➕'], ['ask', '🙋'], ['salad', '🥗'], ['lad', '👦'], 
  ['flask', '🧪'], ['glass', '🥛'], ['flag', '🚩'], ['gas', '⛽'], ['had', ''], ['has', ''], ['glad', '😊'], ['dash', ''],
  ['shell', '🐚'], ['fish', '🐟'], ['dish', '🍽️'], ['hill', '⛰️'], ['kid', '🧒'], ['lid', ''], ['did', ''], ['his', ''], ['sled', '🛷'],
  ['red', '🔴'], ['egg', '🥚'], ['leg', '🦵'], ['sit', '🪑'], ['hat', '🎩'], ['rat', '🐀'], ['tag', '🏷️'], ['red', '🔴'], ['jet', '✈️'],
  ['gift', '🎁'], ['frog', '🐸'], ['dog', '🐶'], ['log', '🪵'], ['hot', '🔥'], ['rock', '🪨'], ['sock', '🧦'], ['clock', '🕰️'],
  ['sun', '☀️'], ['hug', '🤗'], ['rug', ''], ['bug', '🐛'], ['duck', '🦆'], ['truck', '🚚'], ['drum', '🥁'], 
  ['web', '🕸️'], ['wig', ''], ['wet', '💧'], ['yes', '👍'], ['yak', ''], ['yell', '📣'], ['pig', '🐷'], ['pot', '🍲'],
  ['pup', '🐶'], ['pet', ''], ['top', ''], ['stop', '🛑'], ['quilt', ''], ['quiz', '❓'], ['quit', ''], ['quack', '🦆'],
  ['net', '🥅'], ['nut', '🥜'], ['ten', '🔟'], ['pan', '🍳'], ['nap', '😴'], ['hen', '🐔'], ['man', '👨'], ['map', '🗺️'], ['mug', '☕'],
  ['milk', '🥛'], ['mom', '👩'], ['cat', '🐱'], ['cap', '🧢'], ['cup', '🥤'], ['camp', '⛺'], ['cot', ''], ['van', '🚐'], ['vet', ''],
  ['vest', '🦺'], ['bat', '🦇'], ['bed', '🛏️'], ['bus', '🚌'], ['bell', '🔔'], ['bun', '🍞'], ['box', '📦'], ['fox', '🦊'], ['six', '6️⃣'],
  ['ox', '🐂'], ['zip', '🤐'], ['zap', '⚡'], ['buzz', '🐝'], ['jazz', '🎷'], ['ship', '🚢'], ['shop', '🏪'], ['shed', ''], ['fish', '🐟'],
  ['chip', '🍟'], ['chin', ''], ['chest', ''], ['lunch', '🥪'], ['bath', '🛁'], ['math', '➗'], ['moth', '🦋'], ['this', ''], ['that', ''],
  ['ring', '💍'], ['king', '🤴'], ['song', '🎵'], ['wing', '🪽'], ['swing', ''], ['sock', '🧦'], ['back', ''], ['kick', '🦶'], ['black', '⚫'],
  ['lamp', '💡'], ['hand', '✋'], ['sand', '🏖️'], ['tent', '⛺'], ['plant', '🪴'], ['nest', '🪺'], ['jump', '🤸'], ['skunk', '🦨'],
];

export interface Lesson {
  id: number;
  title: string;
  kind: 'new' | 'review' | 'capitals';
  sound?: string;        // the new SoundUnit id for 'new' lessons
  known: string[];       // all sound ids known after this lesson
  unit: string;
}

const ORDER: { unit: string; sounds: string[] }[] = [
  { unit: 'Home keys', sounds: ['f', 'a', 'd', 's', 'j', 'k', 'l'] },
  { unit: 'Middle keys', sounds: ['g', 'h'] },
  { unit: 'Top row', sounds: ['e', 'i', 'r', 't', 'u', 'o'] },
  { unit: 'More top row', sounds: ['w', 'y', 'p', 'q'] },
  { unit: 'Bottom row', sounds: ['n', 'm', 'c', 'v', 'b', 'x', 'z'] },
  { unit: 'Sound teams', sounds: ['sh', 'ch', 'th', 'ng', 'ck'] },
];

export const LESSONS: Lesson[] = (() => {
  const out: Lesson[] = [];
  const known: string[] = [];
  let id = 1;
  for (const u of ORDER) {
    for (const s of u.sounds) {
      known.push(s);
      out.push({ id: id++, title: s.length > 1 ? `Sound team: ${s}` : `The letter ${s}`, kind: 'new', sound: s, known: [...known], unit: u.unit });
    }
    out.push({ id: id++, title: `Review: ${u.unit}`, kind: 'review', known: [...known], unit: u.unit });
  }
  out.push({ id: id++, title: 'Capital letters', kind: 'capitals', known: [...known], unit: 'Capitals' });
  out.push({ id: id++, title: 'My first sentences', kind: 'capitals', known: [...known], unit: 'Capitals' });
  return out;
})();

/** Letters (single keys) available once these sounds are known. */
export function knownKeys(known: string[]): Set<string> {
  const keys = new Set<string>();
  for (const s of known) for (const ch of SOUNDS[s].keys) keys.add(ch);
  return keys;
}

export function wordsFor(known: string[], mustInclude?: string): [string, string][] {
  const keys = knownKeys(known);
  const seen = new Set<string>();
  return WORDS.filter(([w]) => {
    if (seen.has(w)) return false;
    seen.add(w);
    if (![...w].every((c) => keys.has(c))) return false;
    // 'q' words need u; 'x' only after the x lesson; digraph words only once that team is known
    if (w.includes('qu') && !known.includes('q')) return false;
    for (const team of ['sh', 'ch', 'th', 'ng', 'ck']) if (w.includes(team) && !known.includes(team)) return false;
    return mustInclude ? w.includes(mustInclude) : true;
  });
}

// ---------------------------------------------------------------- deterministic activity generation

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
function shuffle<T>(r: () => number, xs: T[]): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export type StepKind = 'meet' | 'home' | 'listen' | 'blaster' | 'words' | 'spell' | 'read' | 'boss' | 'sentence' | 'keys';

/** 1–3 stars from the share of items typed right the first time. Below 80% the lesson comes round again. */
export function starsFor(ratio: number): number { return ratio >= 0.95 ? 3 : ratio >= 0.8 ? 2 : 1; }
export interface Step { kind: StepKind; items: string[] }

/**
 * Short, decodable phrases for "Read & Type". Lowercase, no punctuation until the capitals lessons.
 * A phrase is used only once every letter in it has been taught.
 */
export const PHRASES: string[] = [
  'a sad dad', 'dad asks', 'a lad falls', 'add a salad', 'ask dad', 'a glad lad', 'dad has a flag', 'a lad has a hat',
  'a red sled', 'his leg is red', 'a kid hid', 'the egg is hot', 'a rat sat', 'a fish is in the dish', 'a big red truck',
  'the dog dug', 'a hot pot', 'the frog is on a log', 'the sun is hot', 'a bug on a rug', 'run to the hut',
  'a wet dog', 'the pig is pink', 'a pup on a rug', 'yes it is', 'a big web', 'quit it', 'the duck can quack',
  'a man and a van', 'ten nuts', 'a cat in a cap', 'mom has a mug', 'a vet and a pup', 'a bat in a box', 'the fox can run',
  'six red ants', 'a zebra can run', 'buzz said the bug', 'the ship is big', 'a fish and chips', 'the moth is on the path',
  'the king can sing', 'a duck and a chick', 'the bell rang', 'jump on the bed', 'the ox can pull a cart',
];

export function phrasesFor(known: string[]): string[] {
  const keys = knownKeys(known);
  keys.add(' ');
  return PHRASES.filter((p) => {
    if (![...p].every((c) => keys.has(c))) return false;
    for (const team of ['sh', 'ch', 'th', 'ng', 'ck']) if (p.includes(team) && !known.includes(team)) return false;
    return true;
  });
}

/** Scramble a word for Glitch's boss level (never returns the word itself when it has 3+ different letters). */
export function scramble(word: string, r: () => number): string {
  if (new Set(word).size < 2) return word;
  for (let t = 0; t < 10; t++) { const s = shuffle(r, [...word]).join(''); if (s !== word) return s; }
  return [...word].reverse().join('');
}

/** The exact list of things the child will type in a lesson. Same (lessonId, seed) → same steps. */
export function buildLesson(lessonId: number, seed: number): Step[] {
  const lesson = LESSONS.find((l) => l.id === lessonId);
  if (!lesson) return [];
  const r = rng(lessonId * 7919 + seed);
  const steps: Step[] = [];
  const singles = lesson.known.filter((s) => SOUNDS[s].keys.length === 1 && s !== 'q');
  const sound = lesson.sound ? SOUNDS[lesson.sound] : undefined;
  const wordPoolAll = wordsFor(lesson.known).map(([w]) => w);
  const phrases = phrasesFor(lesson.known);

  if (lesson.kind === 'new' && sound) {
    // 1. Charge the key: press the new key 5 times.
    steps.push({ kind: 'meet', items: Array(5).fill(sound.keys) });
    // Very first lesson: find home base — the bumps on F and J, one pointer finger each.
    if (lessonId === 1) steps.push({ kind: 'home', items: ['f', 'j', 'f', 'j', 'f', 'j', 'f', 'j'] });
    // 2. Sound echo: hear a sound, find its key. Mostly the new one.
    const listenPool = lesson.known.filter((s) => s !== 'ck' && s !== sound.id);
    steps.push({ kind: 'listen', items: shuffle(r, [sound.id, sound.id, sound.id, ...shuffle(r, listenPool).slice(0, 3)]).map((s) => SOUNDS[s].keys) });
    // 3. Balloon blaster: pop letters in the order they rise. Half are the new letter.
    const others = singles.filter((s) => s !== sound.id);
    const pops: string[] = [];
    for (let i = 0; i < 12; i++) pops.push(i % 2 === 0 || others.length === 0 || sound.keys.length > 1 ? sound.keys : SOUNDS[pick(r, others)].keys);
    steps.push({ kind: 'blaster', items: shuffle(r, pops) });
    // 4–6. Words, spelling, reading — as soon as there are words to make.
    const withNew = wordsFor(lesson.known, sound.keys).map(([w]) => w);
    const pool = withNew.length >= 3 ? withNew : wordPoolAll;
    if (pool.length >= 2) {
      steps.push({ kind: 'words', items: shuffle(r, pool).slice(0, 4) });
      steps.push({ kind: 'spell', items: shuffle(r, pool).slice(0, Math.min(3, pool.length)) });
    }
    const withNewPhrase = phrases.filter((p) => p.includes(sound.keys));
    const ph = withNewPhrase.length ? withNewPhrase : phrases;
    if (ph.length) steps.push({ kind: 'read', items: shuffle(r, ph).slice(0, 2) });
  } else if (lesson.kind === 'review') {
    // Boss level: pop a big wave, then fix the words Glitch scrambled, then spell and read.
    steps.push({ kind: 'blaster', items: Array.from({ length: 16 }, () => SOUNDS[pick(r, singles)].keys) });
    if (wordPoolAll.length) {
      steps.push({ kind: 'boss', items: shuffle(r, wordPoolAll.filter((w) => w.length >= 3)).slice(0, 5) });
      steps.push({ kind: 'spell', items: shuffle(r, wordPoolAll).slice(0, 4) });
    }
    if (phrases.length) steps.push({ kind: 'read', items: shuffle(r, phrases).slice(0, 3) });
  } else {
    // Capitals + sentences: short, literal, predictable sentences from decodable words.
    const sentences = lessonId === LESSONS[LESSONS.length - 2].id
      ? ['Dad', 'Mom', 'Sam', 'Max', 'Ben', 'Liz', 'I am Max.', 'I can jump.']
      : shuffle(r, ['The cat sat.', 'A dog can run.', 'I got a red hat.', 'The fox is in the box.', 'Mom has a cup.', 'The ship is big.', 'I can jump.', 'The sun is hot.']).slice(0, 5);
    steps.push({ kind: 'sentence', items: sentences });
  }
  return steps;
}

export function totalItems(steps: Step[]): number { return steps.reduce((n, s) => n + s.items.length, 0); }
