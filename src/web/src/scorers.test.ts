import { describe, expect, it } from 'vitest';
import { scoreModule } from './scorers';
import { LANES, PLACEMENT_TEXT } from './modules/typing-quest/content';
import starter from '../../../content/bible/kjv-starter.json';

const settings = { enabled: true, coinsPerActivity: 10, dailyCap: 80, requireApproval: false };
const typeIt = (text: string, typed: string, ms: number) => ({ startedAt: 1_000_000, finishedAt: 1_000_000 + ms, data: { typed } });

describe('typing-quest', () => {
  const act = (lane: number, drill: number) => ({ moduleId: 'typing-quest', kind: LANES[lane].drills[drill].kind, data: { lane, drill, text: LANES[lane].drills[drill].text, bestWpm: 0, completed: 0 }, issuedAt: 0 });

  it('perfect drill pays base and advances', () => {
    const text = LANES[0].drills[0].text;
    const out = scoreModule('typing-quest', act(0, 0), typeIt(text, text, 20000), settings);
    expect(out.valid).toBe(true);
    expect(out.coins).toBe(10);
    expect(out.progressDelta).toMatchObject({ lane: 0, drill: 1 });
  });

  it('a finished drill below the accuracy target pays the same but does not advance', () => {
    const text = LANES[0].drills[0].text;
    const typed = [...text].map((c, i) => (i % 4 === 0 && c !== ' ' ? 'x' : c)).join(''); // ~1 in 4 wrong
    const out = scoreModule('typing-quest', act(0, 0), typeIt(text, typed, 20000), settings);
    expect(out.coins).toBe(10);
    expect(out.progressDelta).toMatchObject({ lane: 0, drill: 0 });
  });

  it('mashing keys pays nothing', () => {
    const text = LANES[0].drills[0].text;
    const out = scoreModule('typing-quest', act(0, 0), typeIt(text, 'z'.repeat(text.length), 20000), settings);
    expect(out.coins).toBe(0);
  });

  it('rejects tampered text', () => {
    const a = act(0, 0); a.data.text = 'a';
    expect(scoreModule('typing-quest', a, typeIt('a', 'a', 5000), settings).valid).toBe(false);
  });

  it('rejects implausible speed', () => {
    const text = LANES[0].drills[0].text;
    expect(scoreModule('typing-quest', act(0, 0), typeIt(text, text, 600), settings).valid).toBe(false);
  });

  it('placement sets a lane', () => {
    const out = scoreModule('typing-quest', { moduleId: 'typing-quest', kind: 'placement', data: { text: PLACEMENT_TEXT }, issuedAt: 0 }, typeIt(PLACEMENT_TEXT, PLACEMENT_TEXT, 60000), settings);
    expect(out.valid).toBe(true);
    expect(out.progressDelta?.placed).toBe(true);
    expect(typeof out.progressDelta?.lane).toBe('number');
  });

  it('passage requires answers; pays the set amount either way', () => {
    const lane = LANES.findIndex((l) => l.id === 'fluency');
    const text = LANES[lane].drills[0].text;
    const a = act(lane, 0);
    const noAnswers = scoreModule('typing-quest', a, typeIt(text, text, 120000), settings);
    expect(noAnswers.valid).toBe(false);
    const right = scoreModule('typing-quest', a, { ...typeIt(text, text, 120000), data: { typed: text, answers: [1, 0] } }, settings);
    expect(right.coins).toBe(10);
    const wrong = scoreModule('typing-quest', a, { ...typeIt(text, text, 120000), data: { typed: text, answers: [0, 1] } }, settings);
    expect(wrong.coins).toBe(right.coins);
  });

  it('a fast timed drill pays the set amount', () => {
    const drill = LANES[0].drills.findIndex((d) => d.kind === 'timed');
    const text = LANES[0].drills[drill].text;
    const fast = scoreModule('typing-quest', act(0, drill), typeIt(text, text, 8000), settings); // ~ 60 WPM
    expect(fast.coins).toBe(10); // no speed bonus: every drill pays the set amount
  });
});

describe('bible-typing', () => {
  const p = (starter as any).passages[1]; // Psalm 23
  const act = { moduleId: 'bible-typing', kind: 'passage', data: { ref: p.ref, text: p.text, done: [], totalWords: 0 }, issuedAt: 0 };
  const s = { ...settings, coinsPerActivity: 15 };

  it('a finished passage pays the set amount', () => {
    const out = scoreModule('bible-typing', act, typeIt(p.text, p.text, 120000), s);
    expect(out.valid).toBe(true);
    const words = p.text.split(/\s+/).length;
    expect(out.coins).toBe(15); void words;
    expect(out.progressDelta?.done).toEqual([p.ref]);
    expect(out.repeatKey).toBe(p.ref);
    expect(out.detail.startsWith(p.ref + ' ·')).toBe(true); // the Guardian's daily-limit count relies on this
  });

  it('can pay per N words instead', () => {
    const words = p.text.split(/\s+/).filter(Boolean).length;
    const out = scoreModule('bible-typing', act, typeIt(p.text, p.text, 120000), { ...s, coinsPerActivity: 2, options: { wordsPer: '10' } });
    expect(out.coins).toBe(Math.round(2 * words / 10));
  });

  it('counts how often each passage was typed today', () => {
    const first = scoreModule('bible-typing', act, typeIt(p.text, p.text, 120000), s);
    const again = scoreModule('bible-typing', { ...act, data: { ...act.data, today: first.progressDelta?.today } }, typeIt(p.text, p.text, 120000), s);
    expect((again.progressDelta?.today as any).counts[p.ref]).toBe(2);
  });

  it('rejects a passage not in the bundle', () => {
    const a = { ...act, data: { ...act.data, text: 'short' } };
    expect(scoreModule('bible-typing', a, typeIt('short', 'short', 5000), s).valid).toBe(false);
  });

  it('low accuracy pays nothing and does not mark done', () => {
    const out = scoreModule('bible-typing', act, typeIt(p.text, 'x'.repeat(p.text.length), 120000), s);
    expect(out.coins).toBe(0);
    expect(out.progressDelta).toBeUndefined();
  });

  it('a long passage pays the same as a short one', () => {
    const big = (starter as any).passages.find((x: any) => x.ref.startsWith('Exodus'));
    const a = { ...act, data: { ...act.data, ref: big.ref, text: big.text } };
    const out = scoreModule('bible-typing', a, typeIt(big.text, big.text, 600000), s);
    expect(out.coins).toBe(15);
  });
});

describe('khan-academy', () => {
  const act = { moduleId: 'khan-academy', kind: 'observed', data: {}, issuedAt: 0 };
  const s = { ...settings, coinsPerActivity: 5, options: { perAnswer: '1', perVideo: '3' } };
  it('pays automatically for answers, videos and finished exercises', () => {
    const out = scoreModule('khan-academy', act, { startedAt: 0, finishedAt: 1000, data: { correct: 4, video: 1, done: 1 } }, s);
    expect(out.needsApproval).toBe(false);
    expect(out.coins).toBe(4 + 3 + 5);
  });
  it('no longer accepts hand claims', () => {
    expect(scoreModule('khan-academy', { ...act, kind: 'claim' }, { startedAt: 0, finishedAt: 1000, data: { topic: 'Fractions' } }, s).valid).toBe(false);
  });
});

describe('duolingo', () => {
  const act = { moduleId: 'duolingo', kind: 'observed', data: {}, issuedAt: 0 };
  it('pays per finished lesson and story', () => {
    const out = scoreModule('duolingo', act, { startedAt: 0, finishedAt: 1000, data: { lesson: 2, story: 1 } }, { ...settings, coinsPerActivity: 5 });
    expect(out.valid).toBe(true);
    expect(out.needsApproval).toBe(false);
    expect(out.coins).toBe(15);
  });
  it('caps a burst', () => {
    expect(scoreModule('duolingo', act, { startedAt: 0, finishedAt: 1000, data: { lesson: 99 } }, { ...settings, coinsPerActivity: 5 }).coins).toBe(15);
  });
});

describe('registry', () => {
  it('unknown module is invalid', () => {
    expect(scoreModule('nope', { moduleId: 'nope', kind: '', data: {}, issuedAt: 0 }, { startedAt: 0, finishedAt: 1, data: {} }, settings).valid).toBe(false);
  });
  it('uses defaults when settings are missing', () => {
    const text = LANES[0].drills[0].text;
    const out = scoreModule('typing-quest', { moduleId: 'typing-quest', kind: 'keys', data: { lane: 0, drill: 0, text }, issuedAt: 0 }, typeIt(text, text, 20000), undefined);
    expect(out.coins).toBe(10);
  });
});
