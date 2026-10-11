# Adding an earning module

A module is one folder under `src/web/src/modules/<id>/` plus one scorer in `src/web/src/modules/<id>/score.ts`. Nothing in the core needs to change.

## The contract

```ts
// src/web/src/core/module.ts
export interface LessonModule {
  id: string;                      // "bible-typing"
  title: string;                   // shown to the child
  description: string;             // shown to the parent in Quests
  verification: "in_app" | "observed" | "parent_approved";
  defaults: { coinsPerActivity: number; dailyCap: number };
  requiredSites?: string[];        // auto-allowlisted when module is enabled

  /** Pick the next activity for this child. Pure: same progress in → same activity out. */
  nextActivity(progress: Progress, rng: () => number): Activity;

  /** Render the activity. Call ctx.submit(result) when done. */
  mount(el: HTMLElement, activity: Activity, ctx: ActivityContext): () => void;

  /** Score a result. Runs in Scholar for feedback AND re-runs in Guardian for the real credit. Must be pure. */
  score(activity: Activity, result: Result, settings: ModuleSettings): ScoreOutcome;
}
```

`score()` is the important one. It runs twice: once in the child's app for instant feedback, and again inside the Guardian service with the same inputs to decide how many coins are actually minted. Because it is pure and deterministic, a child who tampers with the UI can't change the outcome — the Guardian recomputes it.

For `parent_approved` modules, `score()` returns a *claim* (`{ coins, needsApproval: true }`) and the Guardian queues it for the Parent Console instead of crediting.

## Checklist

1. Create `src/web/src/modules/<id>/index.ts` exporting a `LessonModule`.
2. Register it in `src/web/src/modules/registry.ts`.
3. Add `score.test.ts` — at minimum: zero result → zero coins; perfect result → `coinsPerActivity`; tampered result (e.g. 200% accuracy) → clamped.
4. If the module needs content, put it under `content/<id>/` and import it; the installer copies `content/` wholesale.
5. Run `npm test` and `npm run build`.

## Verification levels

| Level | Who decides | When to use |
|---|---|---|
| `in_app` | `score()` in Guardian | The whole activity happened inside Scholar (typing, quizzes). |
| `observed` | Browser extension reports it; `score()` validates shape | Progress on an external site (Khan Academy) that the extension can read. |
| `parent_approved` | A parent in Approvals | Anything the software can't see (reading a chapter of a physical book). |
