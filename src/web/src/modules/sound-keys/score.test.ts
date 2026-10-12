import { describe, expect, it } from 'vitest';
import { scoreModule } from '../../scorers';
import { LESSONS, buildLesson, wordsFor, SOUNDS, KEY_FINGER } from './content';

const settings = { enabled: true, coinsPerActivity: 12, dailyCap: 100, requireApproval: false };
const act = (lessonId: number, current = lessonId, seed = 0) => ({ moduleId: 'sound-keys', kind: 'lesson', data: { lessonId, current, seed, done: [] }, issuedAt: 0 });
const result = (lessonId: number, seed = 0, firstTryRate = 1) => {
  const items = buildLesson(lessonId, seed).flatMap((s) => s.items);
  return { startedAt: 0, finishedAt: items.length * 2000, data: { typed: items, firstTry: items.map((_, i) => i / items.length < firstTryRate) } };
};

describe('sound-keys content', () => {
  it('has 39 lessons ending in sentences', () => {
    expect(LESSONS.length).toBe(39);
    expect(LESSONS.at(-1)!.kind).toBe('capitals');
  });
  it('every sound has a finger and an audio clip id', () => {
    for (const u of Object.values(SOUNDS)) { expect(KEY_FINGER[u.keys[0]]).toBeTruthy(); expect(u.audio).toBeTruthy(); }
  });
  it('words only ever use letters already taught', () => {
    for (const l of LESSONS) {
      const keys = new Set(l.known.flatMap((s) => [...SOUNDS[s].keys]));
      for (const [w] of wordsFor(l.known)) for (const c of w) expect(keys.has(c)).toBe(true);
    }
  });
  it('lesson building is deterministic', () => {
    expect(buildLesson(12, 3)).toEqual(buildLesson(12, 3));
  });
});

describe('sound-keys scoring', () => {
  it('a clean lesson pays and moves on', () => {
    const out = scoreModule('sound-keys', act(4), result(4), settings);
    expect(out.valid).toBe(true);
    expect(out.coins).toBe(12);
    expect(out.progressDelta).toMatchObject({ lesson: 5, done: [4], seed: 1 });
  });
  it('a rough lesson still pays a little and repeats — never a fail', () => {
    const out = scoreModule('sound-keys', act(4), result(4, 0, 0.5), settings);
    expect(out.valid).toBe(true);
    expect(out.coins).toBe(9);
    expect(out.progressDelta).toMatchObject({ lesson: 4 });
  });
  it('redoing an old lesson never moves progress backwards', () => {
    const out = scoreModule('sound-keys', act(2, 10), result(2, 0, 0.3), settings);
    expect(out.progressDelta).toMatchObject({ lesson: 10 });
  });
  it('rejects locked lessons, wrong text, and impossible speed', () => {
    expect(scoreModule('sound-keys', act(9, 3), result(9), settings).valid).toBe(false);
    const bad = result(4); (bad.data.typed as string[])[0] = 'z';
    expect(scoreModule('sound-keys', act(4), bad, settings).valid).toBe(false);
    const fast = result(4); fast.finishedAt = 100;
    expect(scoreModule('sound-keys', act(4), fast, settings).valid).toBe(false);
  });
});
