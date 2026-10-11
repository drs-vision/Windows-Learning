// TypingQuest content. Original text unless noted; all quoted passages are public domain.

export interface Lane {
  id: string;
  name: string;
  keys: string;             // new keys introduced in this lane
  targetWpm: number;        // to pass the lane's timed drills
  minAccuracy: number;
  drills: Drill[];
}

export interface Drill {
  kind: 'keys' | 'words' | 'sentences' | 'passage' | 'timed';
  text: string;
  questions?: { q: string; options: string[]; answer: number }[]; // for passages
  glossary?: Record<string, string>;
}

const rep = (s: string, n: number) => Array(n).fill(s).join(' ');

export const LANES: Lane[] = [
  {
    id: 'home', name: 'Home Row', keys: 'asdfjkl;', targetWpm: 15, minAccuracy: 0.92,
    drills: [
      { kind: 'keys', text: rep('fff jjj', 3) + ' ' + rep('ddd kkk', 3) },
      { kind: 'keys', text: rep('sss lll', 3) + ' ' + rep('aaa ;;;', 3) },
      { kind: 'keys', text: 'asdf jkl; asdf jkl; fdsa ;lkj fdsa ;lkj' },
      { kind: 'words', text: 'dad sad lad fad ask flask salad all fall alas' },
      { kind: 'words', text: 'a lad; a dad; a sad lad; all fall; ask dad; a flask' },
      { kind: 'timed', text: 'dad asks a sad lad; all fall; a flask; dad adds salads; a lass asks' },
    ],
  },
  {
    id: 'top', name: 'Top Row', keys: 'qwertyuiop', targetWpm: 18, minAccuracy: 0.92,
    drills: [
      { kind: 'keys', text: rep('rrr uuu', 3) + ' ' + rep('eee iii', 3) + ' ' + rep('www ooo', 3) },
      { kind: 'keys', text: rep('ttt yyy', 3) + ' ' + rep('qqq ppp', 3) },
      { kind: 'words', text: 'the quit tree fire kite poet wire sure dirt quiet' },
      { kind: 'words', text: 'fire trucks ride at speed; a kite flies past the tree' },
      { kind: 'sentences', text: 'Dad reads a quiet poet. The kite rises past the tree. We ride to the lake.' },
      { kind: 'timed', text: 'The fire truck rides past a quiet tree. A poet writes at the lake. Sure, we quit at eight.' },
    ],
  },
  {
    id: 'bottom', name: 'Bottom Row', keys: 'zxcvbnm,./', targetWpm: 20, minAccuracy: 0.93,
    drills: [
      { kind: 'keys', text: rep('vvv mmm', 3) + ' ' + rep('ccc ,,,', 3) + ' ' + rep('xxx ...', 3) },
      { kind: 'keys', text: rep('zzz ///', 3) + ' ' + rep('bbb nnn', 3) },
      { kind: 'words', text: 'cave move zone exam bench comb mix fix box van' },
      { kind: 'sentences', text: 'Ben can move the box. Max fixed the van in the cave. Zoom, buzz, hum.' },
      { kind: 'timed', text: 'Ben and Max moved seven boxes into the van. Nobody can fix the mixer, so Zoe bought a new one.' },
    ],
  },
  {
    id: 'shift', name: 'Capitals & Punctuation', keys: 'Shift ! ? \' "', targetWpm: 22, minAccuracy: 0.94,
    drills: [
      { kind: 'keys', text: 'Aa Ss Dd Ff Jj Kk Ll Qq Ww Ee Rr Tt Yy Uu Ii Oo Pp' },
      { kind: 'words', text: 'Georgia Augusta Monday Friday Earth Mars Jupiter Saturn' },
      { kind: 'sentences', text: "Where is Augusta? It's in Georgia. Mars is red! \"Look up,\" she said." },
      { kind: 'timed', text: "On Friday, Noah asked, \"Can we visit the river?\" Dad said yes! They left Augusta at nine and were home by dark." },
    ],
  },
  {
    id: 'numbers', name: 'Numbers & Symbols', keys: '1234567890 - = ( ) :', targetWpm: 24, minAccuracy: 0.94,
    drills: [
      { kind: 'keys', text: '111 222 333 444 555 666 777 888 999 000' },
      { kind: 'words', text: '2024 1776 365 24-7 12:30 (first) 9+10=19 100%' },
      { kind: 'sentences', text: 'In 1776, 13 colonies declared independence. A year has 365 days (366 in a leap year).' },
      { kind: 'timed', text: 'Light travels 299,792 km per second. Earth is about 150,000,000 km from the Sun, so sunlight takes 8 minutes and 20 seconds to reach us.' },
    ],
  },
  {
    id: 'fluency', name: 'Fluency', keys: 'everything', targetWpm: 30, minAccuracy: 0.95,
    drills: [
      {
        kind: 'passage',
        text: 'Honeybees talk by dancing. When a scout finds flowers, she returns to the hive and waggles in a figure-eight. The angle of her dance points toward the food relative to the sun, and the length of the waggle tells the others how far to fly. A single hive can visit millions of flowers in a day.',
        glossary: { scout: 'a bee sent out to look for food', relative: 'compared with; measured from', waggle: 'a quick side-to-side wiggle' },
        questions: [
          { q: 'What does the angle of the dance tell the other bees?', options: ['How sweet the nectar is', 'The direction of the food', 'How many bees to send'], answer: 1 },
          { q: 'What does the length of the waggle mean?', options: ['The distance to the food', 'The time of day', 'The size of the hive'], answer: 0 },
        ],
      },
      {
        kind: 'passage',
        text: 'Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.',
        glossary: { score: 'twenty years', conceived: 'started; thought up', proposition: 'an idea put forward as true' },
        questions: [
          { q: 'How many years is "four score and seven"?', options: ['47', '87', '74'], answer: 1 },
          { q: 'Who is speaking?', options: ['Abraham Lincoln, at Gettysburg', 'George Washington, at Yorktown', 'Thomas Jefferson, in Philadelphia'], answer: 0 },
        ],
      },
      {
        kind: 'passage',
        text: 'The Savannah River begins where two smaller rivers meet in the mountains and runs more than three hundred miles to the Atlantic Ocean. For most of its length it forms the border between Georgia and South Carolina. Augusta grew up at the fall line, the place where the rocky upland gives way to the flat coastal plain and boats could travel no farther upstream.',
        glossary: { border: 'the line where two states meet', upland: 'higher, hilly ground', 'fall line': 'where rivers drop from hills to flat land, often with rapids' },
        questions: [
          { q: 'Why did Augusta grow up where it did?', options: ['It was the farthest point boats could reach', 'It had the most gold', 'It was the state capital'], answer: 0 },
          { q: 'What two states does the Savannah River separate?', options: ['Georgia and Florida', 'Georgia and South Carolina', 'Georgia and Alabama'], answer: 1 },
        ],
      },
      { kind: 'timed', text: 'Practice does not make perfect; practice makes permanent. Type slowly enough to be right, and speed will come on its own.' },
    ],
  },
];

/** The placement test: one minute on a mixed passage. Result sets the starting lane. */
export const PLACEMENT_TEXT =
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump! ' +
  'Sphinx of black quartz, judge my vow. The five boxing wizards jump quickly. Jackdaws love my big sphinx of quartz.';

export function laneForPlacement(wpm: number, accuracy: number): number {
  if (accuracy < 0.85 || wpm < 10) return 0;
  if (wpm < 15) return 1;
  if (wpm < 20) return 2;
  if (wpm < 25) return 3;
  if (wpm < 30) return 4;
  return 5;
}
