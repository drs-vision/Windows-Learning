import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { invalid } from '../../core/module';
import { bridge } from '../../core/bridge';
import { TypingBox, type TypingDone } from '../../core/ui/TypingBox';

/**
 * Reading: public-domain books on a shelf by reading level, 1 = easiest (content/books).
 * Children see only "Level N" — no school grades, so reading at any level feels normal.
 * Read a chapter (or type it), then pass its
 * quiz with 70%: each correct answer pays. A failed quiz waits a few minutes before a retake (time to reread). After
 * passing, questions not yet seen can be answered as bonus questions. The PC holds the answers and does the marking.
 */
export const books: LessonModule = {
  id: 'books',
  title: 'Reading',
  tagline: 'Read a chapter, pass the quiz',
  description: 'Classic public-domain books, sorted by reading level from short picture-book tales up to adventure novels. Your child reads a chapter (or types it, for extra coins), then takes a short quiz: 70% or better pays coins for each correct answer. A failed quiz waits a few minutes before a retake, so there is time to reread. After passing, extra questions can be answered as bonus questions.',
  icon: '📚',
  verification: 'in_app',
  defaults: { coinsPerActivity: 3, dailyCap: 120 },
  options: [
    { key: 'waitMinutes', label: 'Wait before a retake (minutes)', number: { min: 0, max: 240 }, default: '5' },
    { key: 'wordsPer', label: 'Typing mode: 1 🪙 per', suffix: 'words', number: { min: 1, max: 500 }, default: '20' },
  ],
  nextActivity(): Activity { return { moduleId: 'books', kind: 'read', data: {}, issuedAt: 0 }; },
  mount(el, activity, ctx) { render(<Reading activity={activity} ctx={ctx} />, el); return () => render(null, el); },
  score: () => invalid('Reading is marked by the PC'),
};

// ---- types from the Guardian ----------------------------------------------------------------------------------
interface ChapterStatus { n: number; title: string; words: number; quizSize: number; hasQuiz: boolean; passed: boolean; correct: number; total: number; attempts: number; retakeAt: string | null; bonusLeft: number; typed: number }
interface BookStatus { id: string; title: string; author: string; level: number; summary: string; chapters: ChapterStatus[] }
interface Shelf { perCorrect: number; wordsPer: number; books: BookStatus[] }
interface Shown { id: string; q: string; choices: string[] }
interface ChapterData { book: string; text: string; parts: string[]; status: ChapterStatus; quiz: { id: string; questions: Shown[] } | null }
interface Graded { passed: boolean; correct: number; total: number; percent: number; retakeAt: string | null; review: { q: string; choices: string[]; picked: number; right: number }[] | null; coins: number; pending: boolean; bonusLeft: number }

const call = <T,>(op: string, p?: unknown) => bridge.call<T>(op, p);
const minutesRead = (words: number) => Math.max(1, Math.round(words / 180));
const left = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000)) : 0);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

type View = { name: 'shelf' } | { name: 'book'; id: string } | { name: 'chapter'; id: string; n: number };

function Reading({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [view, setView] = useState<View>({ name: 'shelf' });
  const [err, setErr] = useState('');
  const load = () => call<Shelf>('books.list').then((s) => { setShelf(s); setErr(''); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { load(); }, []);
  if (err && !shelf) return <div class="activity-intro"><p class="error">{err}</p><button class="ghost" onClick={ctx.exit}>Back</button></div>;
  if (!shelf) return <div class="activity-intro"><p class="muted">Opening the bookshelf…</p></div>;
  const book = view.name !== 'shelf' ? shelf.books.find((b) => b.id === view.id) : undefined;
  // A one-story book (a Beatrix Potter tale) opens straight to its story.
  const single = (b?: BookStatus) => (b?.chapters.length ?? 0) === 1;
  if (view.name === 'chapter' && book) return <ChapterView book={book} n={view.n} shelf={shelf} onBack={() => { load(); setView(single(book) ? { name: 'shelf' } : { name: 'book', id: book.id }); }} onNext={(n) => { load(); setView({ name: 'chapter', id: book.id, n }); }} />;
  if (view.name === 'book' && book) return <BookView book={book} shelf={shelf} onOpen={(n) => setView({ name: 'chapter', id: book.id, n })} onBack={() => setView({ name: 'shelf' })} />;
  return <ShelfView shelf={shelf} onOpen={(id) => setView(single(shelf.books.find((b) => b.id === id)) ? { name: 'chapter', id, n: 1 } : { name: 'book', id })} onExit={ctx.exit} />;
}

function ShelfView({ shelf, onOpen, onExit }: { shelf: Shelf; onOpen: (id: string) => void; onExit: () => void }) {
  // Easiest first (the Guardian sends the books in level order), one row of covers per level.
  const levels = useMemo(() => {
    const m = new Map<number, BookStatus[]>();
    for (const b of shelf.books) m.set(b.level, [...(m.get(b.level) ?? []), b]);
    return [...m.entries()];
  }, [shelf]);
  return (
    <div class="reading">
      <div class="reading-head"><button class="ghost" onClick={onExit}>← Back</button><h2>📚 Bookshelf</h2><span /></div>
      <p class="muted center">Read a story or a chapter, then pass its quiz: <b>{shelf.perCorrect} 🪙</b> for every right answer.</p>
      {shelf.books.length === 0 && <p class="muted center">No books yet — ask a parent to pick some.</p>}
      {levels.map(([level, list]) => (
        <section class="shelf-group">
          <h3>Level {level}</h3>
          <div class="shelf">
            {list.map((b) => {
              const done = b.chapters.filter((c) => c.passed).length;
              return (
                <button class="book-card" onClick={() => onOpen(b.id)}>
                  <span class="book-spine" style={{ background: spine(b.id) }}><b>{b.title}</b><small>{b.author}</small></span>
                  <span class="book-meta">{b.chapters.length === 1 ? (done ? 'Read ✓' : `${minutesRead(b.chapters[0].words)} min story`) : done ? `${done} of ${b.chapters.length} chapters ✓` : `${b.chapters.length} chapters`}</span>
                  <span class="book-bar"><i style={{ width: `${Math.round(done / b.chapters.length * 100)}%` }} /></span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A steady colour per book, for its cover. */
function spine(id: string) {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(160deg, hsl(${h} 45% 38%), hsl(${(h + 30) % 360} 50% 26%))`;
}

function BookView({ book, onOpen, onBack }: { book: BookStatus; shelf: Shelf; onOpen: (n: number) => void; onBack: () => void }) {
  const next = book.chapters.find((c) => !c.passed)?.n;
  return (
    <div class="reading">
      <div class="reading-head"><button class="ghost" onClick={onBack}>← Bookshelf</button><h2>{book.title}</h2><span class="muted">Level {book.level}</span></div>
      <p class="muted center">{book.author} · {book.summary}</p>
      <ol class="chapter-list">
        {book.chapters.map((c) => {
          const wait = left(c.retakeAt);
          return (
            <li>
              <button class={'chapter-row' + (c.passed ? ' passed' : '') + (c.n === next ? ' next' : '')} onClick={() => onOpen(c.n)}>
                <span class="ch-n">{c.n}</span>
                <span class="ch-title"><b>{c.title}</b><small>{minutesRead(c.words)} min read · {c.quizSize}-question quiz{!c.hasQuiz ? ' (coming soon)' : ''}</small></span>
                <span class="ch-state">
                  {c.passed ? <>✓ {c.correct}/{c.total}{c.bonusLeft > 0 && <em> · ⭐ {c.bonusLeft} bonus</em>}</> : wait > 0 ? <>⏳ {clock(wait)}</> : c.n === next ? 'Read next →' : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ChapterView({ book, n, shelf, onBack, onNext }: { book: BookStatus; n: number; shelf: Shelf; onBack: () => void; onNext: (n: number) => void }) {
  const [data, setData] = useState<ChapterData | null>(null);
  const [mode, setMode] = useState<'read' | 'type' | 'quiz' | 'result' | 'bonus'>('read');
  const [typing, setTyping] = useState(() => { try { return localStorage.getItem('cq.books.typing') === '1'; } catch { return false; } });
  const readTime = useReadTime(`${book.id}/${n}`, mode === 'read' && !!data && !data.status.passed && data.status.attempts === 0);
  const [quiz, setQuiz] = useState<{ id: string; questions: Shown[] } | null>(null);
  const [result, setResult] = useState<Graded | null>(null);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const reload = () => call<ChapterData>('books.chapter', { bookId: book.id, n }).then((d) => { setData(d); if (d.quiz) { setQuiz(d.quiz); setMode('quiz'); } }).catch((e) => setErr((e as Error).message));
  useEffect(() => { setData(null); setMode(typing ? 'type' : 'read'); setResult(null); setQuiz(null); reload(); window.scrollTo?.(0, 0); }, [book.id, n]);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { try { localStorage.setItem('cq.books.typing', typing ? '1' : '0'); } catch { /* fine */ } }, [typing]);

  if (err && !data) return <div class="activity-intro"><p class="error">{err}</p><button class="ghost" onClick={onBack}>Back</button></div>;
  if (!data) return <div class="activity-intro"><p class="muted">Opening the chapter…</p></div>;
  const st = data.status;
  const wait = left(st.retakeAt);
  const name = book.chapters.length === 1 ? st.title : `Chapter ${n}: ${st.title}`;
  const hasNext = book.chapters.some((c) => c.n === n + 1);

  async function startQuiz() {
    setErr('');
    try { const q = await call<{ id: string; questions: Shown[] }>('books.quiz', { bookId: book.id, n, readMs: readTime.take() }); setQuiz(q); setMode('quiz'); window.scrollTo?.(0, 0); }
    catch (e) { setErr((e as Error).message); }
  }

  const head = (
    <div class="reading-head">
      <button class="ghost" onClick={onBack}>← {book.title}</button>
      <h2>{name}</h2>
      {(mode === 'read' || mode === 'type') && !st.passed
        ? <button class={'type-toggle' + (typing ? ' on' : '')} title={`Type the chapter instead: 1 🪙 per ${shelf.wordsPer} words, plus the quiz`} onClick={() => { setTyping(!typing); setMode(typing ? 'read' : 'type'); }}>⌨️ Typing mode: <b>{typing ? 'On' : 'Off'}</b></button>
        : <span />}
    </div>
  );

  const quizBar = (
    <div class="quiz-bar">
      {err && <p class="error">{err}</p>}
      {st.passed ? (
        <>
          <p>✓ You passed this chapter with <b>{st.correct}/{st.total}</b>.</p>
          {st.bonusLeft > 0 && <button class="primary" onClick={() => setMode('bonus')}>⭐ Bonus questions ({st.bonusLeft})</button>}
          {hasNext && <button class={st.bonusLeft > 0 ? 'ghost' : 'primary'} onClick={() => onNext(n + 1)}>Next chapter →</button>}
          <p class="muted small">Each chapter pays once.</p>
        </>
      ) : !st.hasQuiz ? <p class="muted">This chapter's quiz isn't ready yet.</p>
        : wait > 0 ? <><p>⏳ You can take the quiz again in <b>{clock(wait)}</b>. Reading the chapter again helps!</p><button class="primary" disabled>Take the quiz</button></>
        : quiz ? <><p>Your quiz is waiting, just as you left it.</p><button class="primary" onClick={() => { setMode('quiz'); window.scrollTo?.(0, 0); }}>Back to the quiz</button></>
        : <><p>Finished reading? The quiz has <b>{st.quizSize} questions</b>; get 70% to earn <b>{shelf.perCorrect} 🪙</b> for each right answer.</p><button class="primary" onClick={startQuiz}>Take the quiz</button></>}
    </div>
  );

  if (mode === 'quiz' && quiz) return <QuizView title={name} quiz={quiz} bookId={book.id} n={n} onDone={(g) => { setResult(g); setQuiz(null); setMode('result'); reload(); }} onBack={() => setMode('read')} />;
  if (mode === 'result' && result) return <ResultView g={result} onReread={() => setMode(typing ? 'type' : 'read')} onBonus={() => setMode('bonus')} onNext={hasNext ? () => onNext(n + 1) : undefined} onBack={onBack} />;
  if (mode === 'bonus') return <BonusView bookId={book.id} n={n} onDone={() => { reload(); setMode('read'); }} />;

  if (typing && !st.passed && mode !== 'read') return <div class="reading">{head}<TypeChapter data={data} bookId={book.id} n={n} wordsPer={shelf.wordsPer} onChanged={reload} />{quizBar}</div>;
  return (
    <div class="reading">
      {head}
      <article class="book-text">{data.text.split(/\n\s*\n/).map((p) => <p>{p.split('\n').map((l, i) => <>{i > 0 && <br />}{l}</>)}</p>)}</article>
      {quizBar}
    </div>
  );
}

/**
 * Time spent reading a chapter, for the parents' reading speed: only while the chapter is on screen, the window is in
 * use and the child has scrolled, clicked or pressed a key in the last 2 minutes. Kept across visits until the quiz.
 */
function useReadTime(key: string, active: boolean) {
  const store = `cq.books.read.${key}`;
  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    const seen = () => { last = Date.now(); };
    const evs = ['scroll', 'wheel', 'keydown', 'mousemove', 'pointerdown', 'touchstart'] as const;
    for (const e of evs) window.addEventListener(e, seen, { passive: true });
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible' || !document.hasFocus() || Date.now() - last > 120_000) return;
      try { localStorage.setItem(store, String((Number(localStorage.getItem(store)) || 0) + 1000)); } catch { /* fine */ }
    }, 1000);
    return () => { clearInterval(t); for (const e of evs) window.removeEventListener(e, seen); };
  }, [store, active]);
  return { take: () => { try { const ms = Number(localStorage.getItem(store)) || 0; localStorage.removeItem(store); return ms; } catch { return 0; } } };
}

/** Typing mode: the chapter in parts of about 150 words; each part pays once, by its length. */
function TypeChapter({ data, bookId, n, wordsPer, onChanged }: { data: ChapterData; bookId: string; n: number; wordsPer: number; onChanged: () => void }) {
  const [part, setPart] = useState(Math.min(data.status.typed, data.parts.length - 1));
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  async function onTyped(t: TypingDone) {
    setBusy(true);
    try {
      const r = await call<{ coins: number; pending: boolean; again: boolean }>('books.typed', { bookId, n, part, typed: t.typed, startedAt: t.startedAt, finishedAt: t.finishedAt });
      const speed = `${Math.round(t.wpm)} WPM`;
      setMsg(r.again ? `${speed} — typed again, great practice` : r.pending ? `${speed} · +${r.coins} 🪙 waiting for a parent's OK` : `${speed} · +${r.coins} 🪙`);
      onChanged();
      if (part + 1 < data.parts.length) setPart(part + 1);
      else setMsg((m) => m + ' · Chapter typed! Now take the quiz.');
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }
  const words = data.parts[part].split(' ').length;
  return (
    <div class="type-chapter">
      <p class="muted center">Part {part + 1} of {data.parts.length} · {words} words · +{Math.floor(words / wordsPer + 0.5)} 🪙 the first time{msg && <> · <b>{msg}</b></>}</p>
      <div class="type-parts">{data.parts.map((_, i) => <button class={'part-dot' + (i === part ? ' on' : '') + (i < data.status.typed || i < part ? ' done' : '')} title={`Part ${i + 1}`} onClick={() => setPart(i)} />)}</div>
      {!busy && <TypingBox key={`${part}`} text={data.parts[part]} onDone={onTyped} errorless showSpeed highlightKeys="" />}
    </div>
  );
}

function QuizView({ title, quiz, bookId, n, onDone, onBack }: { title: string; quiz: { id: string; questions: Shown[] }; bookId: string; n: number; onDone: (g: Graded) => void; onBack: () => void }) {
  // Picks are kept with the open quiz, so going back to reread and returning finds them as they were.
  const store = `cq.books.quiz.${quiz.id}`;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(store) ?? 'null') as { answers: number[]; flagged: string[] } | null; } catch { return null; } })();
  const [answers, setAnswers] = useState<number[]>(() => saved?.answers?.length === quiz.questions.length ? saved.answers : quiz.questions.map(() => -1));
  const [flagged, setFlagged] = useState<string[]>(() => saved?.flagged ?? []);
  useEffect(() => { try { localStorage.setItem(store, JSON.stringify({ answers, flagged })); } catch { /* fine */ } }, [answers, flagged]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const done = quiz.questions.every((q, i) => answers[i] >= 0 || flagged.includes(q.id));
  async function submit() {
    setBusy(true); setErr('');
    try { const g = await call<Graded>('books.grade', { bookId, n, quizId: quiz.id, answers, flagged }); try { localStorage.removeItem(store); } catch { /* fine */ } onDone(g); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div class="reading quiz">
      <div class="reading-head"><button class="ghost" onClick={onBack}>← Reread the chapter</button><h2>Quiz · {title}</h2><span class="muted">{answers.filter((a) => a >= 0).length}/{quiz.questions.length}</span></div>
      <p class="muted center">Get 70% or more to pass. You can go back and reread — your quiz and answers stay the same. Something wrong with a question? Tap ⚑ and it won't count.</p>
      {quiz.questions.map((q, i) => (
        <div class={'quiz-q' + (flagged.includes(q.id) ? ' flagged' : '')}>
          <div class="quiz-q-head"><b>{i + 1}. {q.q}</b><button class="flag" title="This question seems wrong" onClick={() => setFlagged(flagged.includes(q.id) ? flagged.filter((x) => x !== q.id) : [...flagged, q.id])}>⚑</button></div>
          {flagged.includes(q.id) ? <p class="muted small">Flagged — it won't count, and a parent will see it.</p> : (
            <div class="quiz-choices">
              {q.choices.map((c, k) => <button class={'choice' + (answers[i] === k ? ' on' : '')} onClick={() => setAnswers(answers.map((a, j) => (j === i ? k : a)))}><span class="letter">{'ABCD'[k]}</span>{c}</button>)}
            </div>
          )}
        </div>
      ))}
      {err && <p class="error">{err}</p>}
      <div class="quiz-bar"><button class="primary" disabled={!done || busy} onClick={submit}>{busy ? 'Checking…' : 'Check my answers'}</button></div>
    </div>
  );
}

function ResultView({ g, onReread, onBonus, onNext, onBack }: { g: Graded; onReread: () => void; onBonus: () => void; onNext?: () => void; onBack: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const wait = left(g.retakeAt);
  return (
    <div class="activity-result reading-result">
      <div class={'coins-earned' + (g.pending ? ' pending' : '')}>{g.passed ? `${g.coins} 🪙` : `${g.percent}%`}</div>
      <h2>{g.passed ? `Passed! ${g.correct} of ${g.total} right` : `${g.correct} of ${g.total} right — not quite 70%`}</h2>
      {g.pending && <p class="muted">Waiting for a parent's OK.</p>}
      {!g.passed && <p>{wait > 0 ? <>Read the chapter again — you can retake the quiz in <b>{clock(wait)}</b>.</> : 'You can take the quiz again now.'}</p>}
      {g.passed && g.review && (
        <ol class="review">
          {g.review.map((r) => (
            <li class={r.picked === r.right ? 'ok' : 'miss'}>
              <b>{r.q}</b>
              <span>{r.picked === r.right ? `✓ ${r.choices[r.right]}` : <>✗ {r.picked >= 0 ? r.choices[r.picked] : '(flagged)'} — <b>{r.choices[r.right]}</b></>}</span>
            </li>
          ))}
        </ol>
      )}
      <div>
        {g.passed && g.bonusLeft > 0 && <button class="primary" onClick={onBonus}>⭐ Bonus questions ({g.bonusLeft})</button>}
        {g.passed && onNext && <button class={g.bonusLeft > 0 ? 'ghost' : 'primary'} onClick={onNext}>Next chapter →</button>}
        {!g.passed && <button class="primary" onClick={onReread}>Read it again</button>}
        <button class="ghost" onClick={onBack}>Chapters</button>
      </div>
    </div>
  );
}

function BonusView({ bookId, n, onDone }: { bookId: string; n: number; onDone: () => void }) {
  const [q, setQ] = useState<Shown | null | undefined>(undefined);
  const [leftCount, setLeft] = useState(0);
  const [answer, setAnswer] = useState<{ picked: number; right: number; coins: number } | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const next = () => { setAnswer(null); call<{ question: Shown | null; left: number }>('books.bonus', { bookId, n }).then((r) => { setQ(r.question); setLeft(r.left); }).catch((e) => setErr((e as Error).message)); };
  useEffect(next, []);
  async function pick(k: number) {
    if (!q || answer) return;
    try { const r = await call<{ right: boolean; rightChoice: number; coins: number; left: number }>('books.bonusAnswer', { bookId, n, qid: q.id, choice: k }); setAnswer({ picked: k, right: r.rightChoice, coins: r.coins }); setLeft(r.left); setTotal((t) => t + r.coins); }
    catch (e) { setErr((e as Error).message); }
  }
  if (q === undefined) return <div class="activity-intro"><p class="muted">Finding a bonus question…</p></div>;
  if (q === null) return <div class="activity-result"><div class="coins-earned">{total} 🪙</div><h2>No more bonus questions here</h2><button class="primary" onClick={onDone}>Back to the chapter</button></div>;
  return (
    <div class="reading quiz">
      <div class="reading-head"><button class="ghost" onClick={onDone}>← Done</button><h2>⭐ Bonus question</h2><span class="muted">+{total} 🪙 so far</span></div>
      <div class="quiz-q">
        <div class="quiz-q-head"><b>{q.q}</b></div>
        <div class="quiz-choices">
          {q.choices.map((c, k) => <button class={'choice' + (answer ? (k === answer.right ? ' right' : k === answer.picked ? ' wrong' : '') : '')} onClick={() => pick(k)}><span class="letter">{'ABCD'[k]}</span>{c}</button>)}
        </div>
      </div>
      {err && <p class="error">{err}</p>}
      {answer && (
        <div class="quiz-bar">
          <p>{answer.picked === answer.right ? `Right! +${answer.coins} 🪙` : 'Not this time.'}</p>
          {leftCount > 0 ? <button class="primary" onClick={next}>Next bonus question ({leftCount} left)</button> : <button class="primary" onClick={onDone}>Done</button>}
        </div>
      )}
    </div>
  );
}
