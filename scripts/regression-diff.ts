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
  'n:>=',
  'n:<',
  'n:=',
  // A QUOTED PATH SEGMENT. Without one, the corpus cannot emit a dot followed
  // by a quote, and the path-folding branch is never exercised. A generator
  // with a blind spot certifies that spot.
  "a.'b':",
  'a."b".c:',
  "'full name'.first:",
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
    d: pick(next, ['2020-06-01', '14:30', 1_591_000_000_000, new Date(0)]),
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
 *  - THE ERROR'S CLASS, CODE AND MESSAGE. Two round-nine regressions turned a
 *    located SiftQLSyntaxError into a raw RangeError; class alone catches that.
 *    But the message carries the caret and the offset, so without it the entire
 *    positional contract is uncovered — rewording a refusal, or moving a token's
 *    start from 1 to 0, both reported nothing.
 *  - LOCATIONS. Both trees parse the same source, so a differing span IS a
 *    behavioural change. Stripping them was a choice made to reduce noise, and
 *    it removed the only signal for the caret contract.
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
    const code = (error as { code?: unknown }).code;
    const message = (error as Error).message;

    return `throw:${name}:${typeof code === 'string' ? code : '-'}:${
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
}

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

    for (let run = 0; run < RUNS + SCALE.length; run += 1) {
      const q = SCALE[run] ?? query(next);
      const item = SCALE[run] === undefined ? record(next) : { name: 'ada' };

      for (const tolerant of [false, true]) {
        const options = { tolerant };

        for (const [kind, act] of [
          ['parse', (s: Surface) => s.parse(q, options)],
          ['serialize', (s: Surface) => s.serialize(s.parse(q, options))],
          [
            'test',
            (s: Surface) => (s.createEngine(options) as Surface).test(q, item),
          ],
          [
            'filter',
            (s: Surface) =>
              (s.createEngine(options) as Surface).filter(q, [item]),
          ],
          [
            'highlight',
            (s: Surface) =>
              (s.createEngine(options) as Surface).highlight(q, item),
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
              (s.createEngine(options) as Surface).test(
                s.parse(q, options),
                item,
              ),
          ],
          [
            'highlight (ast)',
            (s: Surface) =>
              (s.createEngine(options) as Surface).highlight(
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
