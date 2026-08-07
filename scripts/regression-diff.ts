/**
 * Behavioural diff between this working tree and an earlier commit.
 *
 * WHY THIS EXISTS. A property suite asserts what someone thought to assert.
 * This asserts nothing: it runs a large generated corpus through both trees and
 * reports every place they disagree, which catches changes nobody thought to
 * look for — including unintended ones. A regression is usually obvious the
 * moment the same input goes through both commits, and invisible otherwise.
 *
 * A disagreement is NOT automatically a defect. Most runs here are expected to
 * report some, because deliberate changes show up too. The output is a list to
 * read, not a pass/fail gate: the question it answers is "is every difference
 * one I meant?", which is exactly the question a changed comment cannot answer
 * for you.
 *
 *   npm run diff              # against HEAD~1
 *   npm run diff -- v0.1.0    # against any ref
 *   SIFTQL_DIFF_RUNS=50000 npm run diff
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNS = Number(process.env.SIFTQL_DIFF_RUNS ?? 20_000);
const BASE_REF = process.argv[2] ?? 'HEAD~1';
const SHOW = 8;
const WINDOW = 80;

/**
 * Show the two outcomes AROUND their first difference, not from the start.
 *
 * The first version printed the leading 110 characters of each, which for two
 * ASTs that differ in one nested field printed the same prefix twice and told
 * the reader nothing — the tool defeated its own purpose on exactly the case it
 * exists for.
 */
const divergence = (base: string, head: string): string => {
  let at = 0;

  while (at < base.length && at < head.length && base[at] === head[at]) {
    at += 1;
  }

  const from = Math.max(0, at - 20);
  const clip = (text: string): string =>
    `${from > 0 ? '…' : ''}${text.slice(from, at + WINDOW)}${at + WINDOW < text.length ? '…' : ''}`;

  return `base: ${clip(base)}\n      head: ${clip(head)}`;
};

const git = (...args: readonly string[]): string =>
  execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();

/* ------------------------------------------------------------------------- *
 * Generators — deterministic, so a reported disagreement is reproducible.
 * ------------------------------------------------------------------------- */

const rng = (seed: number) => {
  let state = seed >>> 0;

  return (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;

    return state / 0x1_00_00_00_00;
  };
};

const pick = <T>(next: () => number, items: readonly T[]): T =>
  items[Math.floor(next() * items.length)] as T;

const ATOMS = [
  'a',
  'ada',
  '3',
  '007',
  '-3',
  'x*',
  '?x',
  // Wildcards and terms over a value whose case fold CHANGES LENGTH, so the
  // guard that suppresses spans for those is exercised.
  '*i*',
  '*I*',
  'İstanbul',
  '*stanbul',
  // A regex and a term that match MORE THAN ONCE in one value, so an
  // off-by-one in the span walk has somewhere to show up.
  '/a/',
  '/a.a/',
  '*a*',
  '/re/i',
  String.raw`/(a+)\1/`,
  '/(a*)*/',
  '/a{2}{3}/',
  'true',
  'null',
  // Claimed by the custom `sku` type, so the registry's resolution ORDER
  // decides the answer rather than being a choice between identical arrays.
  'sku-42',
  '"in progress"',
  '[1 TO 9]',
  '[* TO 9}',
  '2020-06-01',
  '2021-02-29',
  '14:30',
  String.raw`a\ b`,
  'ünïcode',
];

const FIELDS = [
  '',
  'n:',
  'n::',
  // A CASE-SENSITIVE clause against a STRING field. `n::` alone never reaches
  // the string type, because every record holds a number in `n`.
  'name::',
  'name:=',
  // `::=` — case-sensitive EQUALITY. `::` alone routes through `matches` and
  // `:=` alone is case-insensitive, so only the combination reaches `equals`
  // with case sensitivity on.
  'name::=',
  'name:',
  'd:',
  'a.b:',
  'a.0:',
  'sku:',
  'tags:',
  'tags.0:',
  // ALL FOUR ordering operators. With only `>=` and `<`, a boundary flip on
  // `>` or `<=` changed an answer and this reported nothing: half the operator
  // surface was untestable, and the half that was covered certified the whole.
  'n:>=',
  'n:>',
  'n:<',
  'n:<=',
  'n:=',
  // A QUOTED PATH SEGMENT. Without one, the corpus cannot emit a dot followed
  // by a quote, and the path-folding branch is never exercised. A generator
  // with a blind spot certifies that spot.
  "a.'b':",
  'a."b".c:',
  "'full name'.first:",
  /*
   * A path long enough to STRADDLE the cap. The corpus topped out at three
   * segments and SCALE jumped straight to 60, so nothing sat between 17 and 32:
   * halving MAX_FIELD_SEGMENTS moved the enforced boundary invisibly, and was
   * only detected because the constant is interpolated into the message.
   */
  `${Array.from({ length: 24 }, (_, at) => `s${String(at)}`).join('.')}:`,
];

/** Structural characters, emitted in RUNS — the shape a stack overflow needs. */
const STRAY = [':', '+', '}', ']', ')', '~', '^', '=', '<', '>', '*', '?', '/'];

const query = (next: () => number, depth = 3): string => {
  if (depth === 0) {
    return pick(next, ATOMS);
  }

  const roll = next();

  if (roll < 0.1) {
    const run = 1 + Math.floor(next() * 8);

    /*
     * What follows the strays is a full sub-query, not just an atom.
     *
     * The first version appended `pick(ATOMS)`, so a stray was never followed
     * by a FIELD — and the regression live in this very commit pair needed a
     * stray followed by a dotted-quoted path (`:a.'b':c`). Adding quoted paths
     * to FIELDS was not enough on its own: the two halves have to be able to
     * meet: a corpus is only as good as the combinations it can form.
     */
    const strays = Array.from({ length: run }, () => pick(next, STRAY)).join(
      '',
    );
    const roll2 = next();

    if (roll2 < 0.4) {
      return strays;
    }

    return strays + (roll2 < 0.7 ? pick(next, ATOMS) : query(next, depth - 1));
  }

  if (roll < 0.35) {
    const field = pick(next, FIELDS);

    return next() < 0.35
      ? `${field}(${query(next, depth - 1)})`
      : field + pick(next, ATOMS);
  }

  if (roll < 0.5) {
    return `(${query(next, depth - 1)})`;
  }

  if (roll < 0.62) {
    return `${pick(next, ['NOT ', '-', '+'])}${query(next, depth - 1)}`;
  }

  return `${query(next, depth - 1)} ${pick(next, ['AND', 'OR', ''])} ${query(
    next,
    depth - 1,
  )}`;
};

const record = (next: () => number): unknown => {
  const roll = next();

  if (roll < 0.12) {
    const shared = { v: 'ada', z: 3 };

    return { p: shared, q: shared };
  }

  if (roll < 0.2) {
    const self: Record<string, unknown> = { name: 'x' };

    self.loop = self;

    return self;
  }

  return {
    a: { b: pick(next, ['ada', 3, null]) },
    d: pick(next, [
      '2020-06-01',
      '14:30',
      1_591_000_000_000,
      new Date(0),
      // Claimable by the `parseDate` hook and the `DD-MM-YYYY` layout in
      // ENGINES. Without a value they can read, both options are inert.
      'epoch',
      '01-06-2020',
    ]),
    n: pick(next, [3, -3, '007', 0]),
    name: pick(next, [
      'ada',
      'ADA',
      'Ada',
      'in progress',
      'İstanbul',
      'banana',
      // ADJACENT repeats. `banana` has its `a`s two apart, so a span walk that
      // over-advances by one still lands on the same next match and looks
      // identical — the off-by-one only shows up when matches touch.
      'aaa',
      'aaab',
      '',
    ]),
    sku: pick(next, ['sku-42', '42', 'sku-7']),
    // `tags:red` — array flattening under a terminal array is a documented
    // headline and had no corpus value to exercise it.
    tags: ['red', 'blue'],
  };
};

/**
 * Inputs a random generator will never reach, because the failures they expose
 * are failures OF SCALE.
 *
 * A generator explores SHAPE; scale has to be asked for by name. One stray
 * character exercises a branch, but only a run of thousands reaches the depth
 * that breaks it.
 *
 * Everything here is cheap to run and each entry names a limit or a recursion.
 */
const SCALE: readonly string[] = [
  ':'.repeat(5000),
  ':}~^'.repeat(4000),
  '+'.repeat(20_000) + 'a',
  '-'.repeat(500) + 'a',
  'NOT '.repeat(500) + 'a',
  '('.repeat(500) + 'a' + ')'.repeat(500),
  Array.from({ length: 3000 }, () => 'a').join(' OR '),
  Array.from({ length: 3000 }, () => 'a').join(' '),
  `f:${'*a'.repeat(600)}`,
  `${Array.from({ length: 60 }, (_, i) => `s${String(i)}`).join('.')}:x`,
  `bio:/${'a|'.repeat(480)}b/`,
  `bio:/[${'\\s'.repeat(490)}]{900}/i`,
  `v:/${'('.repeat(400)}a${')*'.repeat(400)}/`,
  `"${'x'.repeat(20_000)}`,
  `a:[${'1'.repeat(5000)}`,
];

/* ------------------------------------------------------------------------- *
 * Outcome capture
 * ------------------------------------------------------------------------- */

/**
 * What happened, as a comparable string.
 *
 * Three things are deliberately IN it, each because leaving one out made this
 * tool report "no behavioural differences" for a change it was staring at:
 *
 *  - THE ERROR'S CLASS, MESSAGE AND EVERY OWN FIELD. Two round-nine regressions
 *    turned a located SiftQLSyntaxError into a raw RangeError; class alone
 *    catches that. The message carries the caret and the offset, so without it
 *    the positional contract is uncovered. And comparing only class, code and
 *    message left every other published field — `location` on the classes that
 *    do not print it, `site`, `raw`, `candidates`, `reason`, `hint`,
 *    `argument`, `received`, `expected`, `source` — replaceable in silence.
 *  - LOCATIONS. Both trees parse the same source, so a differing span IS a
 *    behavioural change: they are compared inside the returned AST, and on the
 *    error for a refusal.
 *  - A CYCLE-SAFE WALK. `JSON.stringify` THROWS on a cyclic value, and the
 *    corpus generates self-referential records on purpose; `filter` returns the
 *    item, so both trees produced `throw:TypeError` and compared equal. The one
 *    failure class the cyclic corpus exists to probe was the one class this was
 *    blind to.
 */
const outcome = (act: () => unknown): string => {
  let value: unknown;

  try {
    value = act();
  } catch (error) {
    const name = (error as Error).constructor.name;
    const message = (error as Error).message;

    /*
     * EVERY OWN FIELD, not just the code and the message.
     *
     * Comparing three properties meant `location`, `source`, `expected`,
     * `site`, `raw`, `candidates`, `reason`, `hint`, `argument` and `received`
     * could all be replaced wholesale and this reported "no behavioural
     * differences". Only `SiftQLSyntaxError` was covered at all, and only by
     * accident: it bakes the offset and the caret into its own message.
     *
     * `stack` is excluded because it carries absolute paths, which differ
     * between the two worktrees for reasons that are not behaviour. `message`
     * is already in the key.
     */
    const fields = Object.getOwnPropertyNames(error as object)
      .filter((key) => key !== 'stack' && key !== 'message')
      .sort()
      .map((key) => {
        const own = (error as Record<string, unknown>)[key];

        // Handled before stringify, which returns undefined for both and would
        // erase the difference between an absent field and a present one.
        if (own === undefined || typeof own === 'function') {
          return `${key}=${typeof own}`;
        }

        try {
          return `${key}=${JSON.stringify(own)}`;
        } catch {
          return `${key}=<unserialisable>`;
        }
      })
      .join(',');

    return `throw:${name}:${fields}:${
      typeof message === 'string' ? message : '-'
    }`;
  }

  const seen = new WeakSet();

  try {
    return `ok:${JSON.stringify(value, (_key, inner: unknown) => {
      if (typeof inner !== 'object' || inner === null) {
        return inner;
      }

      if (seen.has(inner)) {
        return '[cycle]';
      }

      seen.add(inner);

      return inner;
    })}`;
  } catch (error) {
    // Serialisation itself failed — a BigInt, a getter that throws. Reported as
    // its own outcome so it can never masquerade as a library throw.
    return `unserialisable:${(error as Error).constructor.name}`;
  }
};

/**
 * Hand-built trees, which no query string can produce.
 *
 * `parse()` caps nesting at MAX_DEPTH (200), so the evaluator's MAX_AST_DEPTH
 * guard (2,200) is unreachable through text. `types.ts` advertises hand-built
 * and JSON-deserialized ASTs as a supported transport, and nothing else here
 * covers that surface.
 */
const handBuilt = (
  surface: Surface,
): readonly (readonly [string, unknown])[] => {
  const b = surface.builders;
  const deep = (levels: number): unknown => {
    let node: unknown = b.term('ada');

    for (let at = 0; at < levels; at += 1) {
      node = b.not(node);
    }

    return node;
  };

  return [
    ['deep NOT chain, under the guard', deep(500)],
    ['deep NOT chain, over the guard', deep(2500)],
    [
      'shared subtree',
      (() => {
        const shared = b.term('ada');

        return b.or(b.and(shared, shared), shared);
      })(),
    ],
    ['bare field group', b.tag(b.field('a', 'b'), b.term('ada'))],
  ];
};

interface Surface {
  parse(query: string, options?: unknown): unknown;
  builders: {
    term(value: string): unknown;
    not(node: unknown): unknown;
    and(left: unknown, right: unknown): unknown;
    or(left: unknown, right: unknown): unknown;
    tag(field: unknown, expression: unknown): unknown;
    field(...path: string[]): unknown;
  };
  serialize(ast: unknown): string;
  test(query: unknown, item: unknown, options?: unknown): boolean;
  filter(query: unknown, items: readonly unknown[], options?: unknown): unknown;
  highlight(query: unknown, item: unknown, options?: unknown): unknown;
  createEngine(options?: unknown): unknown;
  extend(options: unknown): unknown;
  /*
   * Enough to build a CUSTOM VALUE TYPE from each tree's own exports.
   *
   * Without one, `types` is always empty, so `createRegistry` runs with
   * `added.length === 0` on every call: the dedup check, the append/prepend
   * order and the `lookup` bridge are all unreachable, and `typeStrategy` picks
   * between two identical arrays. Six registry mutations were invisible.
   *
   * The type has to be constructed PER TREE, like `handBuilt` does with
   * `builders` — a type built from one tree's `claimed`/`DECLINED` sentinels is
   * not comparable against the other tree's registry.
   */
  defineValueType(definition: unknown): unknown;
  claimed(value: unknown): unknown;
  resolved(value: unknown): unknown;
  DECLINED: unknown;
  MISS: unknown;
}

/** A custom type built from ONE tree's exports, so both sides are comparable. */
const customType = (surface: Surface): unknown =>
  surface.defineValueType({
    coerceValue: (value: unknown) =>
      typeof value === 'string' && value.startsWith('sku-')
        ? surface.claimed(value.slice(4))
        : surface.MISS,
    equals: (value: unknown, operand: unknown) => value === operand,
    matches: (value: unknown, operand: unknown) =>
      String(value).includes(String(operand)),
    name: 'sku',
    parseOperand: (token: { kind: string; text?: string }) =>
      token.kind === 'text' && token.text?.startsWith('sku-') === true
        ? surface.resolved(token.text.slice(4))
        : surface.DECLINED,
  });

const load = async (root: string): Promise<Surface> =>
  (await import(`${root}/src/index.ts`)) as Surface;

/* ------------------------------------------------------------------------- *
 * The comparison
 * ------------------------------------------------------------------------- */

const main = async (): Promise<void> => {
  const repo = git('rev-parse', '--show-toplevel');
  const baseSha = git('rev-parse', '--short', BASE_REF);
  const headSha = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain').length > 0;
  let scratch: string | null = null;
  let basePath: string | null = null;

  /*
   * Cleanup is a named function called from `finally` AND from the signal
   * handlers, because `finally` does not run on SIGINT — and interrupting a
   * long run is the normal way to abort one. Verified: without this, Ctrl-C
   * left both a registered worktree and a full checkout behind.
   *
   * `prune` runs even when `remove` fails, which it did not before: `remove`
   * threw on a locked worktree, `prune` was the next statement and never ran,
   * and the directory was deleted anyway — leaving a permanent entry in
   * `git worktree list` pointing at nothing. That is precisely the "mystery
   * entry" the old comment claimed to prevent.
   */
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) {
      return;
    }

    cleaned = true;

    if (basePath !== null) {
      try {
        git('worktree', 'remove', '--force', basePath);
      } catch {
        // Locked, or already gone. `prune` below is the recovery, so this must
        // not stop it.
      }
    }

    try {
      git('worktree', 'prune');
    } catch {
      // Nothing to prune, or not a worktree host.
    }

    if (scratch !== null) {
      rmSync(scratch, { force: true, recursive: true });
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  console.log(
    `comparing working tree (${headSha}${dirty ? ' + uncommitted' : ''}) against ${BASE_REF} (${baseSha})`,
  );
  console.log(`${String(RUNS)} generated cases\n`);

  try {
    // Inside the try, so a failure creating either one still reaches cleanup.
    scratch = mkdtempSync(join(tmpdir(), 'siftql-diff-'));
    basePath = join(scratch, 'base');

    git('worktree', 'add', '--detach', '--quiet', basePath, baseSha);

    const head = await load(repo);
    const base = await load(basePath);
    const next = rng(0x51f7d1);
    /*
     * COUNTED IN FULL, shown in part — and the two numbers kept separate.
     *
     * The first version pushed at most SHOW details per kind and then summed
     * the details it had KEPT, printing that as "difference groups". On a run
     * with 4,523 real differences it printed "16 difference groups", a number
     * that was neither the group count nor the difference count. An operator
     * who read all sixteen examples and found them intended had examined 0.35%
     * of what changed and had no way to know.
     *
     * Examples are also deduplicated by their divergence text, so a flood of
     * one difference cannot crowd out a rare second one — which is exactly how
     * a real defect hides behind an intended change.
     */
    const differences = new Map<
      string,
      { count: number; examples: Map<string, string> }
    >();

    let compared = 0;

    const note = (kind: string, key: string, detail: string): void => {
      const entry = differences.get(kind) ?? {
        count: 0,
        examples: new Map(),
      };

      entry.count += 1;

      if (entry.examples.size < SHOW && !entry.examples.has(key)) {
        entry.examples.set(key, detail);
      }

      differences.set(kind, entry);
    };

    /*
     * THE ENGINE SHAPES the corpus builds, cycled by run.
     *
     * Varying only `tolerant` left every other option uncovered, and that is
     * most of the package: 14 mutations across `extend()`, the registry,
     * `matchKeys`, `onValueError` routing, `typeStrategy` and the whole of
     * `temporal/format.ts` were all invisible to this tool, because
     * `readWithFormats` only runs when `dateFormat` is set and nothing here
     * ever set it.
     */
    const ENGINES: readonly Record<string, unknown>[] = [
      {},
      { matchKeys: true },
      { onValueError: 'throw' },
      { onRecovered: 'prune' },
      { regexGuard: false },
      { dateFormat: ['DD-MM-YYYY', 'YYYY-MM-DD'] },
      { onRecovered: 'throw' },
      { maxPatternLength: 200 },
      /*
       * CUSTOM TYPES, in both resolution orders.
       *
       * `typeStrategy` decides nothing while `types` is empty — the append and
       * prepend branches build identical arrays — so these two entries are what
       * make the registry reachable at all: its dedup check, its ordering, and
       * the `lookup` bridge a type uses to delegate to a built-in.
       *
       * `__types` is a marker the loop replaces with a type built from the tree
       * being called, since a type carrying one tree's sentinels is not
       * comparable against the other tree's registry.
       */
      { __types: true, typeStrategy: 'append' },
      { __types: true, typeStrategy: 'prepend' },
      { dateFormat: 'DD-MM-YYYY' },
      {
        parseDate: (value: unknown) =>
          value === 'epoch' ? new Date(0) : undefined,
      },
    ];

    /*
     * Per-call overrides, which take a different route than engine options.
     *
     * All FIVE EvaluateOptions members, because three were missing and each
     * one's `overrides.x ?? resolved.x` fallback could be replaced by
     * `resolved.x` — dropping the caller's per-call choice — in silence.
     *
     * The length is coprime with ENGINES so the two cycles do not stay in
     * phase: at 8 and 4 only 8 of the 32 pairings ever occurred.
     */
    const OVERRIDES: readonly Record<string, unknown>[] = [
      {},
      { matchKeys: true },
      { onValueError: 'throw' },
      { regexGuard: false },
      { maxPatternLength: 100 },
      { onRecovered: 'throw' },
      { matchKeys: false, onValueError: 'skip' },
    ];

    for (let run = 0; run < RUNS + SCALE.length; run += 1) {
      const q = SCALE[run] ?? query(next);
      const item = SCALE[run] === undefined ? record(next) : { name: 'ada' };

      for (const tolerant of [false, true]) {
        const shape = ENGINES[run % ENGINES.length] ?? {};
        /*
         * The engine options FOR ONE SIDE. A custom type must come from the
         * tree being called, so this is resolved per surface rather than once.
         */
        const engineOptions = (surface: Surface): Record<string, unknown> =>
          shape.__types === true
            ? {
                ...shape,
                __types: undefined,
                tolerant,
                types: [customType(surface)],
              }
            : { ...shape, tolerant };
        // `parse` takes no types, so the shared shape is fine for it.
        const options = { ...shape, __types: undefined, tolerant };
        const overrides = OVERRIDES[run % OVERRIDES.length];

        for (const [kind, act] of [
          ['parse', (s: Surface) => s.parse(q, options)],
          ['serialize', (s: Surface) => s.serialize(s.parse(q, options))],
          [
            'test',
            (s: Surface) =>
              (s.createEngine(engineOptions(s)) as Surface).test(
                q,
                item,
                overrides,
              ),
          ],
          [
            'filter',
            (s: Surface) =>
              (s.createEngine(engineOptions(s)) as Surface).filter(
                q,
                [item],
                overrides,
              ),
          ],
          [
            'highlight',
            (s: Surface) =>
              (s.createEngine(engineOptions(s)) as Surface).highlight(
                q,
                item,
                overrides,
              ),
          ],
          /*
           * THE ENGINE'S OWN parse(), which applies the engine's `tolerant` and
           * its recovery policy. A mutation that made it drop the engine's
           * options was invisible while the only parse surface was the free
           * function.
           */
          [
            'engine.parse',
            (s: Surface) =>
              (s.createEngine(engineOptions(s)) as Surface).parse(q),
          ],
          /*
           * extend() MERGES over the parent. Nothing exercised it, so a
           * mutation that made it reset instead reported nothing — and losing
           * `onValueError: 'throw'` is a silent failure-policy downgrade.
           */
          [
            'extend',
            (s: Surface) =>
              (
                (s.createEngine(engineOptions(s)) as Surface).extend({
                  id: 'child',
                }) as Surface
              ).filter(q, [item]),
          ],
          /*
           * THE SAME QUERY AS AN AST, not a string.
           *
           * Every surface above passes text, so without this the hand-built
           * and JSON transport `types.ts` advertises has no coverage.
           */
          [
            'test (ast)',
            (s: Surface) =>
              (s.createEngine(engineOptions(s)) as Surface).test(
                s.parse(q, options),
                item,
              ),
          ],
          [
            'highlight (ast)',
            (s: Surface) =>
              (s.createEngine(engineOptions(s)) as Surface).highlight(
                s.parse(q, options),
                item,
              ),
          ],
        ] as const) {
          const a = outcome(() => act(base));
          const b = outcome(() => act(head));

          compared += 1;

          if (a !== b) {
            note(
              `${kind}${tolerant ? ' (tolerant)' : ''}`,
              divergence(a, b),
              `${JSON.stringify(q.slice(0, 60))}\n      ${divergence(a, b)}`,
            );
          }
        }
      }
    }

    // Hand-built trees, once each — they are fixed, not generated.
    for (const [label, tree] of handBuilt(head)) {
      const baseTree = handBuilt(base).find(([name]) => name === label)?.[1];

      for (const [kind, act] of [
        ['serialize', (s: Surface, t: unknown) => s.serialize(t)],
        [
          'test',
          (s: Surface, t: unknown) =>
            (s.createEngine({}) as Surface).test(t, { a: { b: 'ada' } }),
        ],
      ] as const) {
        const a = outcome(() => act(base, baseTree));
        const b = outcome(() => act(head, tree));

        compared += 1;

        if (a !== b) {
          note(
            `${kind} (hand-built)`,
            divergence(a, b),
            `${label}\n      ${divergence(a, b)}`,
          );
        }
      }
    }

    console.log(`${String(compared)} comparisons\n`);

    if (differences.size === 0) {
      console.log('no behavioural differences.');

      return;
    }

    let total = 0;
    let shown = 0;

    for (const [kind, entry] of [...differences].sort()) {
      total += entry.count;
      shown += entry.examples.size;
      console.log(
        `${kind}: ${String(entry.count)} comparisons differed, ${String(entry.examples.size)} distinct shape${entry.examples.size === 1 ? '' : 's'} shown`,
      );

      for (const example of entry.examples.values()) {
        console.log(`    ${example}`);
      }

      console.log('');
    }

    console.log(
      `${String(total)} of ${String(compared)} comparisons differed, across ${String(differences.size)} surface${differences.size === 1 ? '' : 's'}.`,
    );
    console.log(
      `${String(shown)} example${shown === 1 ? '' : 's'} shown above (at most ${String(SHOW)} distinct per surface).`,
    );

    if (shown < total) {
      console.log(
        `\n${String(total - shown)} differing comparisons are NOT shown. Raise SHOW, or narrow the\nrun, if you need to see them — a difference you have not read is not a\ndifference you have approved.`,
      );
    }
  } finally {
    cleanup();
  }
};

void main();
