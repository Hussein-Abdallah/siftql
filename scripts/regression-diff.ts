/**
 * Behavioural diff between this working tree and an earlier commit.
 *
 * WHY THIS EXISTS. Nine adversarial audits have run against this package, and
 * every round found defects in the previous round's REPAIRS. The two worst
 * findings of round nine were both regressions: `parse(':'.repeat(5000))` threw
 * a located error before the change and overflowed the stack after it, and `+`
 * bypassed a depth limit that `NOT` and `-` both enforced. Neither needed
 * insight to find. Both were visible the moment you ran the same input through
 * both commits.
 *
 * The property suite did not catch them, and could not have: a property asserts
 * what its author thought to assert. This asserts nothing. It runs a large
 * generated corpus through both trees and reports every place they disagree,
 * which catches the changes nobody thought to look for — including the ones the
 * author did not intend to make.
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

const FIELDS = ['', 'n:', 'n::', 'd:', 'a.b:', 'a.0:', 'n:>=', 'n:<', 'n:='];

/** Structural characters, emitted in RUNS — the shape a stack overflow needs. */
const STRAY = [':', '+', '}', ']', ')', '~', '^', '=', '<', '>', '*', '?', '/'];

const query = (next: () => number, depth = 3): string => {
  if (depth === 0) {
    return pick(next, ATOMS);
  }

  const roll = next();

  if (roll < 0.1) {
    const run = 1 + Math.floor(next() * 8);

    return (
      Array.from({ length: run }, () => pick(next, STRAY)).join('') +
      (next() < 0.5 ? pick(next, ATOMS) : '')
    );
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
    name: pick(next, ['ada', 'ADA', 'in progress', 'İstanbul', '']),
    tags: ['red', 'blue'],
  };
};

/**
 * Inputs a random generator will never reach, because the failures they expose
 * are failures OF SCALE.
 *
 * This list is the whole lesson of round nine. The property generator emitted
 * one stray character; the bug needed a run of five thousand. It exercised the
 * branch and could not reach the depth that broke it. A generator explores
 * SHAPE; scale has to be asked for by name.
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
 * An ERROR'S CLASS AND CODE ARE PART OF THE OUTCOME, not an absence of one.
 * Both round-nine regressions turned a located `SiftQLSyntaxError` into a raw
 * `RangeError`; a comparison that only looked at return values would have
 * called both "threw" and reported nothing.
 *
 * Locations are excluded: two commits may legitimately place a caret
 * differently, and that would swamp the signal.
 */
const outcome = (act: () => unknown): string => {
  try {
    const value = act();

    return `ok:${JSON.stringify(value, (key, inner: unknown) =>
      key === 'location' ? undefined : inner,
    )}`;
  } catch (error) {
    const name = (error as Error).constructor.name;
    const code = (error as { code?: unknown }).code;

    return `throw:${name}:${typeof code === 'string' ? code : '-'}`;
  }
};

interface Surface {
  parse(query: string, options?: unknown): unknown;
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
  const scratch = mkdtempSync(join(tmpdir(), 'siftql-diff-'));
  const basePath = join(scratch, 'base');

  console.log(
    `comparing working tree (${headSha}${dirty ? ' + uncommitted' : ''}) against ${BASE_REF} (${baseSha})`,
  );
  console.log(`${String(RUNS)} generated cases\n`);

  git('worktree', 'add', '--detach', '--quiet', basePath, baseSha);

  try {
    const head = await load(repo);
    const base = await load(basePath);
    const next = rng(0x51f7d1);
    const differences = new Map<string, string[]>();

    let compared = 0;

    const note = (kind: string, detail: string): void => {
      const seen = differences.get(kind) ?? [];

      if (seen.length < SHOW) {
        seen.push(detail);
      }

      differences.set(kind, seen);
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
        ] as const) {
          const a = outcome(() => act(base));
          const b = outcome(() => act(head));

          compared += 1;

          if (a !== b) {
            note(
              `${kind}${tolerant ? ' (tolerant)' : ''}`,
              `${JSON.stringify(q.slice(0, 60))}\n      ${divergence(a, b)}`,
            );
          }
        }
      }
    }

    console.log(`${String(compared)} comparisons\n`);

    if (differences.size === 0) {
      console.log('no behavioural differences.');

      return;
    }

    let total = 0;

    for (const [kind, examples] of [...differences].sort()) {
      total += examples.length;
      console.log(
        `${kind}: ${String(examples.length)}${examples.length === SHOW ? '+' : ''} distinct`,
      );

      for (const example of examples) {
        console.log(`    ${example}`);
      }

      console.log('');
    }

    console.log(
      `${String(total)} difference groups. Every one is either something you meant\nto change or a regression — read them, do not count them.`,
    );
  } finally {
    // Always, even on a throw: a stranded worktree corrupts the next run and
    // shows up as a mystery entry in `git worktree list`.
    try {
      git('worktree', 'remove', '--force', basePath);
      git('worktree', 'prune');
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  }
};

void main();
