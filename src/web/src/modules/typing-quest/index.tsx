import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { Activity, Progress } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { TypingBox, type TypingDone } from '../../core/ui/TypingBox';
import { LANES, PLACEMENT_TEXT } from './content';
import { scoreTypingQuest, DEFAULTS } from './score';

interface TQProgress extends Progress { placed?: boolean; lane?: number; drill?: number; bestWpm?: number; completed?: number }

export const typingQuest: LessonModule = {
  id: 'typing-quest',
  title: 'TypingQuest',
  tagline: 'Touch typing, one row at a time',
  description: 'Touch-typing to fluency with reading passages and comprehension questions. Starts with a one-minute placement test, then works row by row (home, top, bottom, capitals, numbers) to a 30 WPM fluency lane. Verified automatically.',
  icon: '⌨️',
  verification: 'in_app',
  defaults: DEFAULTS,

  nextActivity(progress: TQProgress): Activity {
    if (!progress.placed) return { moduleId: 'typing-quest', kind: 'placement', data: { text: PLACEMENT_TEXT }, issuedAt: 0 };
    const lane = Math.min(progress.lane ?? 0, LANES.length - 1);
    const drill = Math.min(progress.drill ?? 0, LANES[lane].drills.length - 1);
    const d = LANES[lane].drills[drill];
    return { moduleId: 'typing-quest', kind: d.kind, data: { lane, drill, text: d.text, bestWpm: progress.bestWpm ?? 0, completed: progress.completed ?? 0 }, issuedAt: 0 };
  },

  mount(el, activity, ctx) {
    render(<TypingQuestView activity={activity} ctx={ctx} />, el);
    return () => render(null, el);
  },

  score: scoreTypingQuest,
};

function TypingQuestView({ activity, ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [phase, setPhase] = useState<'intro' | 'type' | 'questions' | 'result'>('intro');
  const [typing, setTyping] = useState<TypingDone | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [outcome, setOutcome] = useState<{ coins: number; detail: string; pending: boolean } | null>(null);
  const [error, setError] = useState('');

  const isPlacement = activity.kind === 'placement';
  const lane = isPlacement ? null : LANES[Number(activity.data.lane)];
  const drill = lane ? lane.drills[Number(activity.data.drill)] : null;
  const text = String(activity.data.text);

  async function submit(t: TypingDone, ans: number[]) {
    try {
      const r = await ctx.submit({ startedAt: t.startedAt, finishedAt: t.finishedAt, data: { typed: t.typed, answers: ans } });
      setOutcome(r); setPhase('result');
    } catch (e) { setError((e as Error).message); }
  }

  function onTyped(t: TypingDone) {
    setTyping(t);
    if (drill?.questions?.length) setPhase('questions'); else submit(t, []);
  }

  if (phase === 'intro') return (
    <div class="activity-intro">
      <h2>{isPlacement ? 'Placement test' : `${lane!.name} · ${Number(activity.data.drill) + 1} of ${lane!.drills.length}`}</h2>
      {isPlacement
        ? <p>Type this passage as fast and as accurately as you can. One minute, roughly. This tells us where to start you — no pressure, no wrong answers.</p>
        : <p>{DRILL_INTRO[drill!.kind]} {lane!.keys !== 'everything' && <>New keys: <b>{lane!.keys}</b>.</>} Target: <b>{lane!.targetWpm} WPM</b> at <b>{Math.round(lane!.minAccuracy * 100)}%</b>.</p>}
      {drill?.glossary && <div class="glossary"><b>Words to know:</b> {Object.entries(drill.glossary).map(([w, d]) => <span><i>{w}</i> — {d}</span>)}</div>}
      <button class="primary" onClick={() => setPhase('type')}>Start</button>
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );

  if (phase === 'type') return (
    <div class="activity">
      <TypingBox text={text} onDone={onTyped} highlightKeys={lane && lane.keys !== 'everything' ? lane.keys.toLowerCase() : ''} big={drill?.kind === 'keys'} />
      {error && <p class="error">{error} <button class="ghost small" onClick={() => { setError(''); setPhase('intro'); }}>Try again</button></p>}
      {!error && <button class="ghost small" onClick={ctx.exit}>Quit</button>}
    </div>
  );

  if (phase === 'questions') return (
    <div class="activity-questions">
      <h2>Quick questions</h2>
      {drill!.questions!.map((q, i) => (
        <div class="question">
          <p>{q.q}</p>
          {q.options.map((o, j) => <label class={'option' + (answers[i] === j ? ' picked' : '')}><input type="radio" name={'q' + i} checked={answers[i] === j} onChange={() => { const a = [...answers]; a[i] = j; setAnswers(a); }} /> {o}</label>)}
        </div>
      ))}
      <button class="primary" disabled={answers.filter((a) => a !== undefined).length < drill!.questions!.length} onClick={() => submit(typing!, answers)}>Check answers</button>
      {error && <p class="error">{error}</p>}
    </div>
  );

  const passed = outcome && !outcome.detail.includes('try again');
  return (
    <div class="activity-result">
      <div class="coins-earned">{outcome?.coins ?? 0} 🪙</div>
      <h2>{isPlacement ? 'All set!' : passed ? 'Nice work!' : 'Almost — go again'}</h2>
      <p>{outcome?.detail}</p>
      {typing && <p class="muted">{Math.round(typing.wpm)} WPM · {Math.round(typing.accuracy * 100)}% accuracy</p>}
      <button class="primary" onClick={ctx.exit}>Continue</button>
    </div>
  );
}

const DRILL_INTRO: Record<string, string> = {
  keys: 'Just the keys. Keep your fingers on the home row and look at the screen, not your hands.',
  words: 'Real words now. Accuracy first — speed comes on its own.',
  sentences: 'Whole sentences, with capitals and punctuation.',
  passage: 'Type the passage, then answer a couple of questions about it.',
  timed: 'Timed run. Hit the target speed to move on.',
};
