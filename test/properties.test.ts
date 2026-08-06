import { describe, expect, it } from 'vitest';

import {
  builders,
  createEngine,
  filter,
  highlight,
  isSiftQLError,
  parse,
  resolveTemporal,
  serialize,
  test as matches,
  type SiftQLAst,
} from '../src/index.js';
import { compileLinear } from '../src/regex/linear.js';

/**
 * EXECUTABLE PROPERTIES.
 *
 * Why this file exists, stated plainly: for five audits running, every defect
 * found in this package passed the entire test suite. The suite is written the
 * way a person writes tests — one case per bug, plus a few neighbours the author
 * thought of. The audits found things by generating tens of thousands of inputs
 * and checking a PROPERTY. That asymmetry, and not the difficulty of the code,
 * is why fixes kept introducing new defects.
 *
 * So the promises this package makes are written here as assertions over
 * GENERATED input, not as prose in a doc comment. A comment claiming "every
 * error is a SiftQLError" decays the moment someone adds a fast path outside a
 * try block — which is exactly what happened. A property fails the build.
 *
 * FOUR HOSTILE INPUT CHANNELS, because those are the four ways something the
 * package did not write gets in:
 *
 *   1. query text          — arbitrary strings, including half-typed ones
 *   2. record values       — arbitrary JS, including Proxies and accessors
 *   3. consumer callbacks  — custom value types that may throw or lie
 *   4. hand-built ASTs     — trees from JSON, builders, or a class instance
 *
 * Scale is deliberately modest by default so `npm test` stays fast. Set
 * `SIFTQL_PROPERTY_RUNS` to raise it — the audits used 10k–100k per property,
 * and that is the setting to reach for before believing a fix.
 */

const RUNS = Number(process.env.SIFTQL_PROPERTY_RUNS ?? 300);

/* ------------------------------------------------------------------------- *
 * A deterministic PRNG, so a failure is reproducible from its seed alone.
 * `Math.random` would report a counterexample nobody can reproduce.
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

/* ------------------------------------------------------------------------- *
 * The vacuity guard
 * ------------------------------------------------------------------------- */

/**
 * Assert that a property actually did some work, not just that it found nothing.
 *
 * A property whose loop body stops executing stays GREEN and reports nothing,
 * and that is indistinguishable from a property that is passing. It has already
 * happened here: "never hands a consumer a pattern that can hang them" probed
 * `hit.query`, `regexType` moved to `highlightSpans`, and from that moment the
 * body ran ZERO times and the assertion was `expect([]).toEqual([])`. It stayed
 * green through two audits while the risk it was written for moved to `ranges`,
 * where a real defect was then found by someone else.
 *
 * So every property below counts the comparisons it genuinely made and states a
 * floor. A refactor that silently empties one now fails the build, which is the
 * only reason to trust a green run.
 */
const didWork = (label: string, count: number, floor: number): void => {
  expect(
    count,
    `${label}: made ${String(count)} meaningful checks, expected at least ${String(floor)}. A property that stops doing work still passes — this is the guard against that.`,
  ).toBeGreaterThanOrEqual(floor);
};

/* ------------------------------------------------------------------------- *
 * Generators
 * ------------------------------------------------------------------------- */

const ATOMS = [
  'a',
  'ada',
  '3',
  '007',
  '-3',
  '- 3',
  'x*',
  'a**b',
  '?x',
  '/re/i',
  'true',
  'false',
  'null',
  '"in progress"',
  "'quoted'",
  '[1 TO 9]',
  '[* TO 9}',
  '2020-06-01',
  '14:30',
  '2020-06-01T12:00:00Z',
  'a\\ b',
  '\\*',
  'ünïcode',
  'content-type',
];

const FIELDS = [
  '',
  'n:',
  'n::',
  'd:',
  'a.b:',
  'a.0:',
  "'full name'.first:",
  'n:>=',
  'n:<',
  'n:=',
  'content-type:',
];

/** A query built from the grammar, biased toward the shapes that broke before. */
const query = (next: () => number, depth = 3): string => {
  if (depth === 0) {
    return pick(next, ATOMS);
  }

  const roll = next();

  if (roll < 0.28) {
    const field = pick(next, FIELDS);

    return next() < 0.4
      ? `${field}(${query(next, depth - 1)})`
      : field + pick(next, ATOMS);
  }

  if (roll < 0.45) {
    return `(${query(next, depth - 1)})`;
  }

  if (roll < 0.58) {
    return `${pick(next, ['NOT ', '-'])}${query(next, depth - 1)}`;
  }

  return `${query(next, depth - 1)} ${pick(next, ['AND', 'OR', ''])} ${query(
    next,
    depth - 1,
  )}`;
};

/** A record, including the shapes that have produced wrong answers before. */
const record = (next: () => number): unknown => {
  const roll = next();

  if (roll < 0.15) {
    // Shared reference reachable by two paths.
    const shared = { v: 'ada', z: 3 };

    return { p: shared, q: shared };
  }

  if (roll < 0.25) {
    // Parent back-reference: finite, but a naive cycle guard drops it.
    const root: Record<string, unknown> = { name: 'root' };

    root.children = [{ name: 'kid', parent: root }];

    return root;
  }

  if (roll < 0.35) {
    const self: Record<string, unknown> = { name: 'x' };

    self.loop = self;

    return self;
  }

  return {
    'content-type': 'json',
    d: pick(next, ['2020-06-01', '14:30', 1_591_000_000_000, new Date()]),
    n: pick(next, [3, -3, 7, '007', 0]),
    name: pick(next, ['ada', 'ADA', 'in progress', '']),
    tags: ['red', 'blue'],
  };
};

/** Values engineered to run consumer code from inside a property read. */
const hostileValues = (): readonly unknown[] => {
  const revoked = Proxy.revocable({}, {});

  revoked.revoke();

  return [
    new Proxy(
      {},
      {
        get() {
          throw new Error('get trap');
        },
      },
    ),
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('gopd trap');
        },
      },
    ),
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
      },
    ),
    new Proxy(
      {},
      {
        has() {
          throw new Error('has trap');
        },
      },
    ),
    revoked.proxy,
    {
      get v(): string {
        throw new Error('throwing getter');
      },
    },
    Object.defineProperty({}, Symbol.toStringTag, {
      get() {
        throw new Error('toStringTag');
      },
    }),
    Object.create(Date.prototype),
    Object.create(null),
    new Array<unknown>(600_000_000),
    new Map([['a', 'b']]),
    new Set(['a']),
    Symbol('s'),
    10n,
  ];
};

/** Option objects whose accessors run consumer code. */
const hostileOptions = (): readonly unknown[] =>
  [
    'tolerant',
    'matchKeys',
    'regexGuard',
    'onValueError',
    'onRecovered',
    'typeStrategy',
    'dateFormat',
    'id',
    'parseDate',
    'maxPatternLength',
    'types',
  ].map((key) =>
    Object.defineProperty({}, key, {
      enumerable: true,
      get() {
        throw new Error(`option ${key}`);
      },
    }),
  );

/** ASTs that did not come from `parse()`. */
const hostileAsts = (): readonly unknown[] => {
  const at = { end: 1, start: 0 };

  /*
   * GETTERS, not fields, and eslint is told so below: the whole point of this
   * fixture is that the children live on the PROTOTYPE rather than as own
   * enumerable properties, which is what `Object.values` cannot see. Rewriting
   * them as readonly fields would remove the defect being tested.
   */
  /* eslint-disable @typescript-eslint/class-literal-property-style */
  class Empty {
    public get type(): string {
      return 'EmptyExpression';
    }

    public get location(): object {
      return at;
    }
  }

  class Paren {
    readonly #inner: unknown;

    public constructor(inner: unknown) {
      this.#inner = inner;
    }

    public get type(): string {
      return 'ParenthesizedExpression';
    }

    public get location(): object {
      return at;
    }

    public get expression(): unknown {
      return this.#inner;
    }
  }
  /* eslint-enable @typescript-eslint/class-literal-property-style */

  // A class instance whose children live on the prototype, not as own
  // enumerable properties — the "rehydrated AST" shape.
  let nested: unknown = new Empty();

  for (let index = 0; index < 5000; index += 1) {
    nested = new Paren(nested);
  }

  const shared = (levels: number): unknown => {
    // Deliberately SHARED, not copied: n+1 nodes, 2^n paths. This is the shape
    // that made serialize produce a 100 MB string from 49 objects.
    let node = builders.term('a') as never;

    for (let index = 0; index < levels; index += 1) {
      node = builders.or(node, node) as never;
    }

    return node;
  };

  return [
    nested,
    shared(24),
    { location: at, type: 'Tag' },
    { literal: 'text', location: at, quoted: false, type: 'LiteralExpression' },
    { literal: 'null', location: at, quoted: false, type: 'LiteralExpression' },
    { location: at, type: 'LogicalExpression' },
    new Proxy(parse('a:b'), {
      get() {
        throw new Error('ast trap');
      },
    }),
  ];
};

/** Value types that throw or return the wrong thing. */
const hostileTypes = (): readonly unknown[] =>
  [
    {
      coerceValue: () => {
        throw new Error('coerce');
      },
    },
    {
      // Deliberately invalid: a value type may hand back a RegExp whose `source`
      // is not a compilable pattern, and reading it must not escape.
      // eslint-disable-next-line no-invalid-regexp
      highlight: () => new RegExp('(', 'g'),
    },
    {
      highlight: () => /(a+)+$/u,
    },
    {
      matches: () => 'yes',
    },
  ].map((over) => ({
    coerceValue: (value: unknown) => ({ ok: true, value }),
    equals: () => true,
    name: 'hostile',
    parseOperand: (token: { value: unknown }) => ({
      ok: true,
      value: token.value,
    }),
    ...over,
  }));

/** Every public entry point, applied to one input. */
const entryPoints = (
  q: unknown,
  item: unknown,
  options?: unknown,
): readonly (() => unknown)[] => [
  () => parse(q as string, options as never),
  () => serialize(q as SiftQLAst),
  () => matches(q as string, item, options as never),
  () => filter(q as string, [item], options as never),
  () => highlight(q as string, item, options as never),
  () => createEngine(options as never).test(q as string, item),
];

/** Run something and report only a NON-SiftQLError escape. */
const escape = (run: () => unknown): string | null => {
  try {
    run();

    return null;
  } catch (error) {
    if (isSiftQLError(error)) {
      return null;
    }

    return `${(error as Error).name}: ${(error as Error).message}`.slice(
      0,
      120,
    );
  }
};

/* ========================================================================= *
 * P1. THE FAILURE BOUNDARY
 *
 * "Every error siftql throws is a SiftQLError." Asserted here rather than in a
 * comment, because the comment has now been falsified twice by edits made after
 * it was written.
 * ========================================================================= */

describe('P1: no entry point throws a non-SiftQLError', () => {
  it('for hostile record values', () => {
    const escapes: string[] = [];

    for (const value of hostileValues()) {
      for (const q of ['anything', 'v:x', 'v:>1', 'v:[1 TO 9]', 'v:/a/']) {
        for (const run of entryPoints(q, value)) {
          const failure = escape(run);

          if (failure) {
            escapes.push(`${q} / ${failure}`);
          }
        }
      }
    }

    expect(escapes).toEqual([]);
  });

  it('for hostile option objects', () => {
    const escapes: string[] = [];

    for (const options of hostileOptions()) {
      for (const run of entryPoints('a:b', { a: 'b' }, options)) {
        const failure = escape(run);

        if (failure) {
          escapes.push(failure);
        }
      }

      const failure = escape(() =>
        createEngine({ matchKeys: true }).extend(options as never),
      );

      if (failure) {
        escapes.push(`extend: ${failure}`);
      }
    }

    expect(escapes).toEqual([]);
  });

  it('for hand-built ASTs', () => {
    const escapes: string[] = [];

    for (const ast of hostileAsts()) {
      for (const run of [
        () => serialize(ast as SiftQLAst),
        () => matches(ast as SiftQLAst, { a: 1 }),
        () => filter(ast as SiftQLAst, [{ a: 1 }]),
        () => highlight(ast as SiftQLAst, { a: 1 }),
      ]) {
        const failure = escape(run);

        if (failure) {
          escapes.push(failure);
        }
      }
    }

    expect(escapes).toEqual([]);
  });

  it('for misbehaving value types', () => {
    const escapes: string[] = [];

    for (const type of hostileTypes()) {
      for (const q of ['f:1', 'f:[1 TO 9]']) {
        const failure =
          escape(() =>
            createEngine({ types: [type as never] }).filter(q, [{ f: 'a' }]),
          ) ??
          escape(() =>
            createEngine({ types: [type as never] }).highlight(q, { f: 'a' }),
          );

        if (failure) {
          escapes.push(`${q} / ${failure}`);
        }
      }
    }

    expect(escapes).toEqual([]);
  });

  it('for generated queries against generated records', () => {
    const next = rng(20_260_805);
    const escapes: string[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      const q = query(next);
      const item = record(next);

      for (const entry of entryPoints(q, item)) {
        const failure = escape(entry);

        if (failure) {
          escapes.push(`${JSON.stringify(q)} -> ${failure}`);
        }
      }
    }

    expect(escapes.slice(0, 5)).toEqual([]);
  });
});

/* ========================================================================= *
 * P2. THE ROUND-TRIP LAW (I4)
 * ========================================================================= */

describe('P2: serialize round-trips and is idempotent', () => {
  const strip = (node: SiftQLAst): string =>
    JSON.stringify(node, (key, value: unknown) =>
      key === 'location' ? undefined : value,
    );

  it('over generated queries', () => {
    const next = rng(11);
    const violations: string[] = [];

    for (let run = 0; run < RUNS * 4; run += 1) {
      const q = query(next);

      let ast: SiftQLAst;

      try {
        ast = parse(q);
      } catch {
        continue;
      }

      const once = serialize(ast);

      try {
        if (strip(parse(once)) !== strip(ast)) {
          violations.push(`${JSON.stringify(q)} -> ${JSON.stringify(once)}`);
        } else if (serialize(parse(once)) !== once) {
          violations.push(`not idempotent: ${JSON.stringify(once)}`);
        }
      } catch (error) {
        violations.push(
          `${JSON.stringify(once)} does not re-parse: ${(error as Error).message.slice(0, 60)}`,
        );
      }
    }

    expect(violations.slice(0, 5)).toEqual([]);
  });
});

/* ========================================================================= *
 * P3. MATCHING ALGEBRA
 * ========================================================================= */

describe('P3: matching obeys its own algebra', () => {
  it('filter partitions, and test agrees with filter', () => {
    const next = rng(7);
    const violations: string[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      const q = query(next);
      const left = record(next);
      const right = record(next);

      let both: unknown[];

      try {
        both = filter(q, [left, right]);
      } catch {
        continue;
      }

      const split = [...filter(q, [left]), ...filter(q, [right])];

      if (both.length !== split.length) {
        violations.push(`partition: ${JSON.stringify(q)}`);
      }

      if (matches(q, left) !== filter(q, [left]).includes(left)) {
        violations.push(`test/filter: ${JSON.stringify(q)}`);
      }
    }

    expect(violations.slice(0, 5)).toEqual([]);
  });

  it('a highlight implies a match, and its regex terminates', () => {
    const next = rng(99);
    const violations: string[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      const q = query(next);
      const item = record(next);

      let hits: readonly { query?: RegExp | undefined }[];

      try {
        hits = highlight(q, item);
      } catch {
        continue;
      }

      if (hits.length > 0 && !matches(q, item)) {
        violations.push(`highlight without match: ${JSON.stringify(q)}`);
      }

      for (const hit of hits) {
        if (!hit.query) {
          continue;
        }

        let steps = 0;

        while (hit.query.exec('abcdefghij') !== null) {
          steps += 1;

          if (steps > 100) {
            violations.push(
              `exec loop does not terminate: ${String(hit.query)}`,
            );
            break;
          }
        }
      }
    }

    expect(violations.slice(0, 5)).toEqual([]);
  });
});

/* ========================================================================= *
 * P4. ENGINE CONFIGURATION
 * ========================================================================= */

describe('P4: an engine honours its configuration', () => {
  it('extend() merges over the parent instead of resetting it', () => {
    // Documented as "a new engine with additional options merged over this
    // one's". Every one of these silently reverted to its default.
    const custom = {
      coerceValue: () => ({ kind: 'miss' as const, ok: false as const }),
      equals: () => true,
      name: 'mine',
      parseOperand: () => ({ ok: true as const, value: 1 }),
    };
    const base = createEngine({
      matchKeys: true,
      onValueError: 'throw',
      tolerant: true,
      types: [custom as never],
    });
    const extended = base.extend({ id: 'child' });

    expect(extended.options.matchKeys).toBe(true);
    expect(extended.options.onValueError).toBe('throw');
    expect(extended.options.tolerant).toBe(true);
    expect(extended.types.get('mine')).toBeDefined();
    expect(extended.options.id).toBe('child');
  });

  it('never shows a value type the failure policy', () => {
    let seen: Record<string, unknown> = {};

    createEngine({
      onValueError: 'throw',
      types: [
        {
          coerceValue: (_value: unknown, ctx: { options: object }) => {
            seen = { ...ctx.options };

            return { kind: 'miss', ok: false };
          },
          equals: () => true,
          name: 'spy',
          parseOperand: (token: { value: unknown }) => ({
            ok: true,
            value: token.value,
          }),
        } as never,
      ],
    }).filter('f:1', [{ f: 1 }]);

    expect('onValueError' in seen).toBe(false);
    expect('onRecovered' in seen).toBe(false);
  });

  it('never throws in tolerant mode, for any prefix of any query', () => {
    /*
     * `parse`'s own docblock promises that in tolerant mode "the result is
     * always usable". It is not a nice-to-have: a search box parses on every
     * keystroke, so EVERY PREFIX of a query is an input the package will see,
     * and a throw there blanks the result list mid-typing.
     *
     * Prefixes rather than random strings, because that is what a half-typed
     * query actually looks like — and it is the generator that found the classes
     * an enumerated list of cases kept missing.
     */
    const next = rng(31_337);
    const throwing: string[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      const full = query(next);

      for (let cut = 1; cut <= full.length; cut += 1) {
        try {
          parse(full.slice(0, cut), { tolerant: true });
        } catch (error) {
          throwing.push(
            `${JSON.stringify(full.slice(0, cut))}: ${(error as Error).message.slice(0, 50)}`,
          );
        }
      }
    }

    expect(throwing.slice(0, 5)).toEqual([]);
  });

  it('keeps every clause a tolerant parse can still see', () => {
    // Ignoring everything after a stray closer made the result a SUPERSET:
    // `a:b } zzz` dropped the `zzz` conjunct and matched rows it should not.
    const engine = createEngine({ tolerant: true });
    const rows = [{ a: 'b' }, { a: 'b', z: 'zzz' }];

    expect(engine.filter('a:b zzz', rows)).toHaveLength(1);
    expect(engine.filter('a:b } zzz', rows)).toHaveLength(1);
  });

  it("refuses every recovered tree under onRecovered: 'throw'", () => {
    const strict = createEngine({ onRecovered: 'throw', tolerant: true });
    const next = rng(4242);
    const leaks: string[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      const full = query(next);
      const cut = full.slice(0, 1 + Math.floor(next() * full.length));

      let ast: SiftQLAst;

      try {
        ast = parse(cut, { tolerant: true });
      } catch {
        continue;
      }

      if (!JSON.stringify(ast).includes('"recovered"')) {
        continue;
      }

      try {
        strict.test(cut, { a: 1 });
        leaks.push(JSON.stringify(cut));
      } catch {
        // Refused, as it must be.
      }
    }

    expect(leaks.slice(0, 5)).toEqual([]);
  });
});

/* ========================================================================= *
 * P3b. EVERY LOCATION POINTS AT THE TEXT IT CLAIMS
 * ========================================================================= */

describe('P3b: a node location slices back to its own source', () => {
  it('holds for every field segment of every generated query', () => {
    /*
     * `SourceLocation` is contractually "a half-open character range into the
     * original query string", and consumers slice it — a caret excerpt, a
     * highlight offset. Field segments were the one place it lied: spans were
     * reconstructed by walking a cursor forward by `name.length + 1`, which
     * assumes a decoded name occupies its own length in the source. For
     * `'full name'.first` that reported `'full nam` and `'.fir`.
     */
    const next = rng(515);
    const wrong: string[] = [];

    const check = (node: unknown, source: string): void => {
      if (typeof node !== 'object' || node === null) {
        return;
      }

      const record = node as Record<string, unknown>;

      if (record.type === 'FieldSegment') {
        const location = record.location as { start: number; end: number };
        const slice = source.slice(location.start, location.end);
        const name = record.name as string;

        if (
          location.start < 0 ||
          location.end > source.length ||
          location.start > location.end
        ) {
          wrong.push(`${source}: segment span out of range`);
        } else if (!slice.includes(name) && name !== '') {
          // Quotes and escapes make the slice longer than the name, never
          // shorter, and never a different run of characters.
          wrong.push(
            `${source}: segment ${JSON.stringify(name)} spans ${JSON.stringify(slice)}`,
          );
        }
      }

      for (const value of Object.values(record)) {
        check(value, source);
      }
    };

    for (let run = 0; run < RUNS * 2; run += 1) {
      const text = query(next);

      try {
        check(parse(text), text);
      } catch {
        continue;
      }
    }

    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('reports per-segment quoting, which types.ts calls load-bearing', () => {
    const ast = parse("name.'first name':x") as unknown as {
      field: { segments: { name: string; quoted: boolean }[] };
    };

    expect(ast.field.segments.map((segment) => segment.quoted)).toEqual([
      false,
      true,
    ]);
  });
});

/* ========================================================================= *
 * P4b. A DECLARED LAYOUT IS OBEYED, OR THE VALUE IS REFUSED
 *
 * `format.ts` promises "you state the layout; siftql obeys it exactly". Written
 * as a property because two commits have now claimed to deliver it and both left
 * a class of values being read by the built-in ISO parser instead — the second
 * one moved the split rather than removing it, which a case-by-case test could
 * not have shown.
 * ========================================================================= */

describe('P4b: a declared dateFormat is never silently overridden', () => {
  it('reads every value through the layout, or refuses it', () => {
    /*
     * Under `YYYY-DD-MM`, a value is EITHER the layout's reading or refused.
     * Never ISO's. The counterexample was `2020-02-29`: day 29 is not a valid
     * month, so the layout declined and ISO took it — while `2020-02-11` used
     * the layout. One column, two calendars, split on whether the second field
     * exceeded 12.
     */
    const layout = 'YYYY-DD-MM';
    const wrong: string[] = [];

    for (let day = 1; day <= 28; day += 1) {
      for (let month = 1; month <= 28; month += 1) {
        const text = `2020-${String(day).padStart(2, '0')}-${String(
          month,
        ).padStart(2, '0')}`;
        const resolved = resolveTemporal(text, { dateFormat: layout });

        if (resolved === null) {
          // Refused: only legitimate when the layout genuinely cannot read it.
          if (month <= 12) {
            wrong.push(`${text} refused but the layout accepts it`);
          }

          continue;
        }

        // Accepted: it must be the LAYOUT's reading, never ISO's.
        const asLayout = Date.UTC(2020, month - 1, day);

        if (resolved.value !== asLayout) {
          wrong.push(
            `${text} read as ${new Date(resolved.value).toISOString().slice(0, 10)}, not the layout's`,
          );
        }
      }
    }

    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('refuses an impossible date rather than matching it against itself', () => {
    // `d:31-02-2020` matched a field holding `31-02-2020`, because both sides
    // degraded to `string` — an impossible date matching itself.
    const engine = createEngine({ dateFormat: 'DD-MM-YYYY' });

    expect(() => engine.test('d:31-02-2020', { d: '31-02-2020' })).toThrow();
    expect(engine.test('d:01-06-2020', { d: '01-06-2020' })).toBe(true);
  });

  it('lets a layout with separators leave bare numbers alone', () => {
    // `YYYY-MM-DD` cannot match a bare number, but its width was counted with
    // the dashes, so every 10-digit number was refused — including ordinary
    // epoch seconds.
    expect(
      resolveTemporal(1_593_000_000, { dateFormat: 'YYYY-MM-DD' }),
    ).not.toBeNull();
    // An all-digit layout still claims a number of its own width.
    expect(resolveTemporal(20_200_631, { dateFormat: 'YYYYMMDD' })).toBeNull();
  });
});

/* ========================================================================= *
 * P5. COST
 *
 * Stated as a property because "this is linear" has been asserted in a comment
 * three times and been false twice. A wall-clock ceiling is crude, but it is
 * checkable, and quadratic blowup clears it by orders of magnitude.
 * ========================================================================= */

describe('P5: cost stays bounded', () => {
  it('is not quadratic in record depth', () => {
    /*
     * A chain-shaped record — threaded comments, a linked list, an ORM parent
     * chain — has a leaf at EVERY level, so its paths sum to n²/2 entries. It
     * took two seconds at 16,000 levels and exhausted the heap at 32,000, from a
     * record under a megabyte. A flat record with the same LEAF COUNT took 19 ms,
     * which is the tell: the cost was never the leaves.
     *
     * Fixed by never materialising a path until something reads one, which
     * happens on a match or a failure and not once per candidate. Three places
     * had to become lazy before the curve moved — the walk, the value context,
     * and the failure descriptor — and it stayed quadratic until the last of
     * them, which is why this is a property and not three separate tests.
     */
    const chain = (levels: number): unknown => {
      let node: Record<string, unknown> = { text: 'leaf' };

      for (let index = 0; index < levels; index += 1) {
        node = { reply: node, text: 'leaf' };
      }

      return node;
    };

    const time = (levels: number): number => {
      const started = Date.now();

      matches('zzz', chain(levels));

      return Date.now() - started;
    };

    /*
     * A FOURFOLD size step, not a doubling, so the signal dominates timing
     * noise: linear predicts ~4x, quadratic ~16x. A doubling put the threshold
     * within the noise floor and made this flap between runs — which matters
     * more than usual here, because the assertion is currently expected to fail
     * and a flake would turn the build red at random.
     */
    time(1000);

    const small = Math.max(time(4000), 1);
    const large = time(16_000);

    expect(large / small).toBeLessThan(8);
  });

  it('never accepts a regex that then runs away', () => {
    /*
     * MEASURED AS A RATIO, at lengths chosen so a regression cannot hang.
     *
     * The first version timed one 41-character subject. When an auditor broke
     * the matcher to check this property was not vacuous, `vitest` produced no
     * output for ten minutes — `^(a+)+$` on 41 characters is 2^40 steps and a
     * synchronous regex cannot be interrupted, so the property was real and
     * structurally unable to REPORT. A test that hangs instead of failing is
     * worse than no test: CI stalls and nobody learns why.
     *
     * 16 and 22 characters instead. Linear predicts a ratio near 1.4; anything
     * backtracking predicts about 64, and the worst case is 2^22 steps — tens of
     * milliseconds, not geological time.
     */
    const suspects = [
      '^(a+)+$',
      '^(a+){1,99}$',
      '^(a+){99}$',
      '^(a{1,3})+$',
      '^(a{1,99})+$',
      '^([a-z]{1,99})+$',
      '^(a|a)*$',
      '^((a|a))*$',
      '^(?:(a|a))*$',
      '^([a-z]|[a-c])*$',
      '^((a|b)|(a|c))*$',
      String.raw`^(\w{1,50})+$`,
      '^(x+x+){1,99}y$',
    ];

    /*
     * `^(a*){1,99}$` and `^((a|a?))*$` used to be here and are now REFUSED —
     * their loop bodies can match the empty string. That is a strictly stronger
     * guarantee than the one this property checks, so they are asserted
     * separately rather than dropped silently.
     */
    for (const refused of ['^(a*){1,99}$', '^((a|a?))*$']) {
      expect(compileLinear(refused, '').ok, refused).toBe(false);
    }

    const runaway: string[] = [];

    for (const pattern of suspects) {
      const compiled = compileLinear(pattern, '');

      expect(compiled.ok, `${pattern} should compile`).toBe(true);

      if (!compiled.ok) {
        continue;
      }

      const time = (length: number): number => {
        const started = Date.now();

        compiled.matcher.test(`${'a'.repeat(length)}!`);

        return Date.now() - started;
      };

      time(16);

      const short = Math.max(time(16), 1);
      const long = Math.max(time(22), 1);

      if (long / short > 8) {
        runaway.push(`${pattern}: ${String(short)}ms -> ${String(long)}ms`);
      }
    }

    expect(runaway).toEqual([]);
  });

  it('never hands a consumer a pattern that can hang them', () => {
    /*
     * `filter` and `test` being safe is only half the promise. `highlight`
     * publishes what to underline, and a consumer acts on it — so anything that
     * leaves this package has to be safe in THEIR loop too, not just in ours.
     *
     * This is pinned because a previous change broke exactly this: replacing the
     * matcher with the automaton meant patterns the old screen had REFUSED now
     * compiled, and their highlighters were handed out. `bio:/^.|(.+)+;/` — nine
     * characters — filtered in 3 ms and took the consumer 8.8 seconds on a
     * 30-character value.
     */
    const hostile = [
      'v:/^.|(.+)+;/',
      'v:/^.|(a+)+$/',
      'v:/^.|(a|a)*b/',
      String.raw`v:/^.|(\d+)*x/`,
      'v:/^.|([a-z]|[a-c])*z/',
    ];
    const value = 'Lorem ipsum dolor sit amet xy';
    const slow: string[] = [];
    let checked = 0;

    /*
     * THIS PROPERTY WENT VACUOUS AND STAYED GREEN FOR TWO AUDITS.
     *
     * It used to read `if (!hit?.query) continue;` and then time the consumer's
     * exec loop. When `regexType` moved to `highlightSpans` no hit carried a
     * `query` any more, so all five patterns hit the `continue`, the loop body
     * ran ZERO times, and the assertion became `expect([]).toEqual([])`. The
     * hazard had not gone away — it had moved to `ranges`, where nothing was
     * looking, and a real defect was later found there by someone else.
     *
     * So the absence of a `query` is now the ASSERTION rather than a reason to
     * skip, and the work counter below fails the build if this ever empties out
     * again.
     */
    for (const query of hostile) {
      const started = Date.now();
      const [hit] = highlight(query, { v: value });
      const elapsed = Date.now() - started;

      checked += 1;

      if (hit?.query) {
        slow.push(
          `${query}: published a RegExp built from a user pattern, which the caller runs on the backtracking engine`,
        );
        continue;
      }

      if (elapsed > 100) {
        slow.push(`${query}: highlight() itself took ${String(elapsed)}ms`);
      }

      // Spans are data, so the only way they can hurt a caller is by being
      // wrong. Every one must address real text inside the value.
      for (const range of hit?.ranges ?? []) {
        if (range.start < 0 || range.end > value.length) {
          slow.push(`${query}: span ${JSON.stringify(range)} is out of bounds`);
        }
      }
    }

    didWork('hostile highlight patterns', checked, hostile.length);
    expect(slow).toEqual([]);
  });

  it('agrees with RegExp on patterns RegExp can safely run', () => {
    /*
     * The other half of replacing an engine: it has to give the SAME ANSWERS. A
     * fast matcher that disagrees would trade a denial of service for silently
     * wrong search results, which is the worse bargain.
     *
     * THE GENERATOR IS ESCAPE-FIRST, and that is the whole lesson here. The
     * version this replaces was atom-first over eleven simple atoms against nine
     * lowercase-ASCII subjects, reported ZERO mismatches, and was quoted in a
     * commit message as evidence the engine was correct. An auditor wrote an
     * escape-first generator with control characters, non-ASCII and astral
     * subjects and found 244 distinct disagreements — every one of them in escape
     * and character-class handling, which is exactly what the old generator could
     * not emit.
     *
     * It also generates what the README claims to support and the old one never
     * produced: `\b`, non-capturing and named groups, `{n,}`, and subjects
     * containing newlines, so the `m` and `s` flags are not inert.
     */
    const next = rng(90_210);

    const escapes = [
      String.raw`\d`,
      String.raw`\D`,
      String.raw`\w`,
      String.raw`\W`,
      String.raw`\s`,
      String.raw`\S`,
      String.raw`\.`,
      String.raw`\-`,
      String.raw`\\`,
      String.raw`\n`,
      String.raw`\t`,
      String.raw`\0`,
      String.raw`\x41`,
      String.raw`\x00`,
    ];
    const classes = [
      '[abc]',
      '[^abc]',
      '[a-c]',
      '[a-]',
      '[-a]',
      '[^]',
      String.raw`[\x41-\x43]`,
      String.raw`[\x00-\x1f]`,
      '[A-Z]',
      String.raw`[\d]`,
      String.raw`[\w-]`,
      String.raw`[a\-z]`,
      String.raw`[\]]`,
    ];
    const atoms = ['a', 'b', 'A', '1', ' ', '.', 'é', ...escapes, ...classes];
    const quantifiers = [
      '',
      '',
      '*',
      '+',
      '?',
      '{2}',
      '{1,3}',
      '{2,}',
      '*?',
      '+?',
      '??',
    ];
    const anchors = ['^', '$', String.raw`\b`, String.raw`\B`];

    const build = (depth: number): string => {
      if (depth === 0) {
        return pick(next, atoms) + pick(next, quantifiers);
      }

      const roll = next();

      if (roll < 0.14) {
        return `(${build(depth - 1)})${pick(next, quantifiers)}`;
      }

      if (roll < 0.24) {
        return `(?:${build(depth - 1)})${pick(next, quantifiers)}`;
      }

      if (roll < 0.3) {
        return `(?<g${String(Math.floor(next() * 1000))}>${build(depth - 1)})`;
      }

      if (roll < 0.46) {
        return `${build(depth - 1)}|${build(depth - 1)}`;
      }

      if (roll < 0.58) {
        return pick(next, anchors) + build(depth - 1);
      }

      if (roll < 0.64) {
        return build(depth - 1) + pick(next, anchors);
      }

      return build(depth - 1) + build(depth - 1);
    };

    // Newlines, control characters, non-ASCII and an astral pair, so `m`, `s`
    // and case folding all actually bite.
    const nl = String.fromCharCode(10);
    const subjects = [
      '',
      'a',
      'ab',
      'abc',
      'aab',
      'A',
      'AB',
      'xyz',
      'a1b2',
      'cab',
      'a b',
      `a${nl}b`,
      `a${String.fromCharCode(13)}${nl}b`,
      nl,
      `ab${nl}`,
      String.fromCharCode(0),
      String.fromCharCode(8),
      String.fromCharCode(9),
      String.fromCharCode(1),
      'é',
      'É',
      'ß',
      'ſ',
      'ı',
      'K',
      'σ',
      'ς',
      'Σ',
      '\u{1F600}',
      'a-c',
      '-',
      ']',
      '^',
    ];

    const disagreements: string[] = [];

    for (let run = 0; run < RUNS * 20; run += 1) {
      const source = build(3);
      const flags = pick(next, ['', '', 'i', 'm', 's', 'im', 'is', 'ms']);

      let native: RegExp;

      try {
        native = new RegExp(source, flags);
      } catch {
        continue;
      }

      const compiled = compileLinear(source, flags);

      if (!compiled.ok) {
        continue;
      }

      for (const subject of subjects) {
        const want = native.test(subject);

        if (want !== compiled.matcher.test(subject)) {
          disagreements.push(
            `/${source}/${flags} vs ${JSON.stringify(subject)}: RegExp=${String(want)}`,
          );
        }
      }
    }

    expect(disagreements.slice(0, 8)).toEqual([]);
  });

  it('does not refuse patterns that are provably fast', () => {
    // The other direction, which matters just as much: a false positive rejects
    // a query the user legitimately wants. The screen refused eight of these.
    const ordinary = [
      String.raw`^(\d+,)*\d+$`,
      '^([^/]+/)*[^/]+$',
      '^(ab+c)+$',
      String.raw`^(?:[^,]*,)*[^,]*$`,
      String.raw`^(/[\w.-]+)*/?$`,
      '^([A-Z]{3}-){1,4}[0-9]{2}$',
      String.raw`^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$`,
    ];

    const refused: string[] = [];

    for (const pattern of ordinary) {
      const started = Date.now();

      new RegExp(pattern, 'u').test(`${'a,'.repeat(120)}!`);

      const elapsed = Date.now() - started;

      if (!compileLinear(pattern, '').ok && elapsed < 50) {
        refused.push(`${pattern} refused, but runs in ${String(elapsed)}ms`);
      }
    }

    expect(refused).toEqual([]);
  });
});

/* ========================================================================= *
 * P6. THE PROMISES THIS ROUND FOUND UNGUARDED
 *
 * Every property here corresponds to a defect that reached a release because
 * nothing asserted the promise it broke. They are grouped separately so the
 * provenance stays visible: this is the list an audit produced by diffing the
 * package's stated promises against what the harness actually checked.
 * ========================================================================= */

describe('P6: spans say where the match really is', () => {
  it('agrees with a native global exec, offset for offset', () => {
    /*
     * `spans()` resumed each scan with `run(code, input.slice(at), ...)`. A slice
     * looks like an offset and is not: every assertion is positional, so `^`
     * matched at each restart and `\b` saw an empty left context. /^foo/ over
     * "foofoofoo" reported three matches where there is one.
     *
     * The existing parity property compares `test()` only, so it could never see
     * this — the two never disagree about WHETHER there is a match, only where.
     */
    const next = rng(4242);
    const ATOM = ['a', 'b', '.', '\\d', '\\w', '[ab]', '[^a]', '[a-c]'];
    const ANCHOR = ['^', '$', '\\b', '\\B'];
    const QUANT = ['', '*', '+', '?', '*?', '+?', '{1,2}'];
    const SUBJECTS = [
      '',
      'a',
      'aa',
      'aaa',
      'ab',
      'a b',
      'foofoo',
      'the cat',
      'ab\ncd',
      'a,b,,c',
      'xaxbxc',
    ];

    const violations: string[] = [];
    let compared = 0;

    for (let run = 0; run < RUNS * 2; run += 1) {
      let source = '';

      for (let part = 0; part < 1 + Math.floor(next() * 3); part += 1) {
        source +=
          next() < 0.25
            ? pick(next, ANCHOR)
            : pick(next, ATOM) + pick(next, QUANT);
      }

      const flags = pick(next, ['', 'i', 'm', 's']);

      try {
        new RegExp(source, flags);
      } catch {
        continue;
      }

      const compiled = compileLinear(source, flags);

      if (!compiled.ok) {
        continue;
      }

      for (const subject of SUBJECTS) {
        const native = new RegExp(source, `${flags}g`);
        const want: string[] = [];

        for (
          let hit = native.exec(subject);
          hit !== null;
          hit = native.exec(subject)
        ) {
          want.push(`${String(hit.index)}-${String(hit.index + hit[0].length)}`);

          if (hit[0].length === 0) {
            native.lastIndex += 1;
          }
        }

        const mine = compiled.matcher
          .spans(subject)
          .map((span) => `${String(span.start)}-${String(span.end)}`);

        compared += 1;

        if (want.join(',') !== mine.join(',')) {
          violations.push(
            `/${source}/${flags} on ${JSON.stringify(subject)}: RegExp=[${want.join(',')}] ours=[${mine.join(',')}]`,
          );
        }
      }
    }

    didWork('spans parity', compared, RUNS);
    expect(violations.slice(0, 5)).toEqual([]);
  });

  it('never points outside the value, or at text that does not match', () => {
    // Custom `ranges` were checked with Array.isArray and nothing else, so
    // [{start:999,end:-5}] reached a caller verbatim.
    const next = rng(4343);
    const violations: string[] = [];
    let checked = 0;

    for (let run = 0; run < RUNS * 3; run += 1) {
      const value = Array.from(
        { length: 1 + Math.floor(next() * 8) },
        () => pick(next, Array.from('abAB sſKkİß')),
      ).join('');
      const needle = pick(next, ['a', 'b', 'A', 's', 'k', 'ab']);
      const q = pick(next, [needle, `v:*${needle}*`, `v:${needle}`]);

      let hits;

      try {
        hits = highlight(q, { v: value });
      } catch {
        continue;
      }

      for (const hit of hits) {
        for (const range of hit.ranges ?? []) {
          checked += 1;

          const inside =
            Number.isInteger(range.start) &&
            Number.isInteger(range.end) &&
            range.start >= 0 &&
            range.start < range.end &&
            range.end <= value.length;
          const slice = value.slice(range.start, range.end);
          // Either it is the term itself, or the whole value (an exact match).
          const truthful =
            slice.toLowerCase() === needle.toLowerCase() ||
            (range.start === 0 && range.end === value.length);

          if (!inside || !truthful) {
            violations.push(
              `${q} on ${JSON.stringify(value)}: ${JSON.stringify(range)} covers ${JSON.stringify(slice)}`,
            );
          }
        }
      }
    }

    didWork('span truthfulness', checked, RUNS / 2);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('P6: highlight() reports every clause that contributed', () => {
  it('is commutative over AND', () => {
    /*
     * The sink keyed on `segments + query`, and `regexType` publishes `ranges`
     * and no `query` — so two regex clauses at one path collapsed to one entry
     * and `highlight()` gave a different answer depending on operand order.
     */
    const next = rng(4444);
    const CLAUSES = [
      'v:/Lorem/',
      'v:/dolor/',
      'v:/ipsum/',
      'v:Lorem*',
      'v:*dolor',
      'v:/[a-z]+/',
      'w:/x/',
      'v:*o*',
    ];
    const row = { v: 'Lorem ipsum dolor', w: 'x' };
    const shape = (hits: readonly unknown[]): string =>
      JSON.stringify(hits.map((hit) => JSON.stringify(hit)).sort());

    const violations: string[] = [];
    let compared = 0;

    for (let run = 0; run < RUNS * 2; run += 1) {
      const left = pick(next, CLAUSES);
      const right = pick(next, CLAUSES);

      try {
        const forwards = highlight(`${left} AND ${right}`, row);
        const backwards = highlight(`${right} AND ${left}`, row);

        compared += 1;

        if (shape(forwards) !== shape(backwards)) {
          violations.push(`${left} AND ${right}`);
        }
      } catch {
        continue;
      }
    }

    didWork('AND commutativity', compared, RUNS);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('P6: tolerant mode never throws at the ENGINE boundary', () => {
  it('survives every prefix of every generated query', () => {
    /*
     * P4 asserts this at `parse()`, which is one layer above where it matters.
     * `prune()` removed only MissingExpression, so an invented range bound
     * reached operand resolution and threw — 15 of the 28 prefixes of
     * `d:[2020-01-01 TO 2020-12-31]` threw before any record was read.
     */
    const next = rng(4545);
    const engine = createEngine({ tolerant: true });
    const rows = [
      { d: '2020-06-01', n: 5, name: 'ada', tags: ['x'] },
      { d: '2021-01-01', n: 50, name: 'bob', tags: [] },
    ];

    const violations: string[] = [];
    let evaluated = 0;

    /*
     * Shapes the generator cannot spell, each of which threw at PARSE level
     * until an audit found them: a half-typed regex flag, a duplicate one, and
     * the reserved `+` marker, which had no tolerant branch at all while `^`
     * and `~` both did.
     */
    const HAND = [
      '//=',
      '/a/ii',
      '/a/x',
      '+',
      'a +',
      '+name:ada',
      '/ada/gg',
      'name:ada AND +bob',
    ];

    for (let run = 0; run < RUNS + HAND.length; run += 1) {
      const q = HAND[run] ?? query(next);

      for (let cut = 1; cut <= q.length; cut += 1) {
        const prefix = q.slice(0, cut);

        evaluated += 1;

        try {
          engine.filter(prefix, rows);
          engine.highlight(prefix, rows[0]);
        } catch (error) {
          violations.push(
            `${JSON.stringify(prefix)}: ${(error as Error).name}: ${(error as Error).message.slice(0, 50)}`,
          );
        }
      }
    }

    didWork('tolerant prefixes', evaluated, RUNS);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('P6: every consumer-callback member is read through a guard', () => {
  it('raises a SiftQLError when any member is a throwing accessor', () => {
    /*
     * `ordering` was read raw at four sites, so a throwing accessor escaped as a
     * plain Error from test(), filter() and types.describe(). P1 covers this
     * channel; its fixture just never varied `ordering`.
     */
    const MEMBERS = [
      'name',
      'parseOperand',
      'coerceValue',
      'equals',
      'matches',
      'ordering',
      'highlight',
      'highlightSpans',
    ];

    const violations: string[] = [];
    let attempted = 0;

    for (const member of MEMBERS) {
      const type: Record<string, unknown> = {
        coerceValue: (value: unknown) =>
          typeof value === 'string'
            ? { ok: true, value }
            : { kind: 'miss', ok: false },
        equals: () => true,
        name: `hostile-${member}`,
        parseOperand: (token: { kind: string; text?: string }) =>
          token.kind === 'text'
            ? { ok: true, operand: token.text ?? '' }
            : { declined: true },
      };

      Object.defineProperty(type, member, {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error(`reading ${member} threw`);
        },
      });

      for (const act of [
        () => createEngine({ types: [type] as never }).test('n:>5', { n: 1 }),
        () => createEngine({ types: [type] as never }).test('a', { a: 'a' }),
        () =>
          createEngine({ types: [type] as never }).filter('n:[1 TO 9]', [
            { n: 5 },
          ]),
        () =>
          createEngine({ types: [type] as never }).highlight('a', { a: 'a' }),
        () => createEngine({ types: [type] as never }).types.describe(),
      ]) {
        attempted += 1;

        try {
          act();
        } catch (error) {
          if (!isSiftQLError(error)) {
            violations.push(
              `${member}: ${(error as Error).name}: ${(error as Error).message.slice(0, 40)}`,
            );
          }
        }
      }
    }

    didWork('hostile members', attempted, MEMBERS.length);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('P6: the round-trip law over raw characters', () => {
  it('holds for queries no atom list can spell', () => {
    /*
     * P2's generator can only emit what ATOMS and FIELDS spell, so it could not
     * produce `.`, `..`, a trailing backslash, or an empty field segment — and
     * I4 was broken for every one of those: `a.:1` serialized to `a."":1` and
     * re-parsed to a tree that was not deep-equal.
     */
    const next = rng(4646);
    const ALPHABET = Array.from('ab.:"\\ ()[]{}*?/<>=-!TO019');
    const strip = (node: SiftQLAst): string =>
      JSON.stringify(node, (key, value: unknown) =>
        key === 'location' ? undefined : value,
      );

    const violations: string[] = [];
    let parsed = 0;

    for (let run = 0; run < RUNS * 20; run += 1) {
      let q = '';

      for (let at = 0; at < 1 + Math.floor(next() * 9); at += 1) {
        q += pick(next, ALPHABET);
      }

      let ast: SiftQLAst;

      try {
        ast = parse(q);
      } catch {
        continue;
      }

      parsed += 1;

      const once = serialize(ast);

      try {
        if (strip(parse(once)) !== strip(ast)) {
          violations.push(`I4: ${JSON.stringify(q)} -> ${JSON.stringify(once)}`);
        } else if (serialize(parse(once)) !== once) {
          violations.push(`idempotence: ${JSON.stringify(once)}`);
        }
      } catch (error) {
        violations.push(
          `${JSON.stringify(once)} does not re-parse: ${(error as Error).message.slice(0, 40)}`,
        );
      }
    }

    didWork('raw-character round-trip', parsed, RUNS);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('P6: the walk is linear in record depth for every leaf type', () => {
  it('does not go quadratic on a chain whose leaves are not strings', () => {
    /*
     * The G10 benchmark used a STRING leaf at every level — the one leaf type
     * that never reaches the failure branch that materialised a path per
     * candidate — and the property built on it inherited the blind spot. A
     * realistic comment thread took 31 seconds.
     */
    const chain = (levels: number, leaf: unknown): unknown => {
      let node: Record<string, unknown> = { text: leaf };

      for (let at = 0; at < levels; at += 1) {
        node = {
          author: leaf,
          created: leaf,
          pinned: leaf,
          reply: node,
          text: leaf,
        };
      }

      return node;
    };

    const time = (levels: number, leaf: unknown): number => {
      const built = chain(levels, leaf);
      const started = Date.now();

      matches('zzz', built);

      return Math.max(Date.now() - started, 1);
    };

    const violations: string[] = [];
    let measured = 0;

    /*
     * Measured RELATIVE to the string-leaf case rather than as a growth curve.
     * At these depths the absolute times are a few milliseconds and noise swamps
     * a doubling ratio — but the defect's signature is unmistakable in the
     * comparison: string leaves ran in 16ms where number leaves took 666ms,
     * because only the non-string ones reached the branch that built a path.
     */
    const DEEP = 32_000;
    const baseline = Math.min(
      time(DEEP, 'leaf'),
      time(DEEP, 'leaf'),
      time(DEEP, 'leaf'),
    );

    for (const leaf of [42, true, null, new Date()]) {
      const best = Math.min(time(DEEP, leaf), time(DEEP, leaf));

      measured += 1;

      if (best > baseline * 6) {
        violations.push(
          `${String(leaf)} leaves took ${String(best)}ms against a ${String(baseline)}ms string-leaf baseline at depth ${String(DEEP)}`,
        );
      }
    }

    didWork('depth scaling', measured, 4);
    expect(violations).toEqual([]);
  });
});

describe('P7: tolerant mode drops exactly what it cannot use, and no more', () => {
  it('keeps a resolvable clause when a sibling is unresolvable', () => {
    /*
     * The other half of "tolerant never throws", and the half nothing asserted:
     * a repair that drops too much is worse than one that throws, because it
     * silently WIDENS the result set. `repairUnresolvableHoles` trial-compiled a
     * Tag whole, so one bad term inside a field group deleted every sibling with
     * it — `d:(2020-06-01 OR 2021-02-29)` matched every row, including rows with
     * no `d` key at all, while the flat form correctly kept the good half.
     *
     * `prune` had already learned this exact lesson on its own walk and named
     * the consequence a false-positive leak. This walk was written without it.
     */
    const next = rng(4747);
    const engine = createEngine({ tolerant: true });
    const rows = [
      { d: '2020-06-01', name: 'ada', n: 5 },
      { d: '2019-01-01', name: 'bob', n: 50 },
      { unrelated: 1 },
    ];

    const GOOD = ['name:ada', 'n:>1', 'd:2020-06-01', 'name:*a*'];
    /*
     * Every one of these REFUSES in strict mode — verified, not assumed. An
     * earlier draft of this list included `d:2020-13-01`, which does not refuse:
     * month 13 is claimed by `string`, so the clause resolves and legitimately
     * matches nothing. A property whose fixture is wrong reports a defect that
     * is not there, which wastes exactly as much time as missing one.
     */
    const BAD = [
      'd:2021-02-29',
      'd:2020-02-30',
      String.raw`name:/(a+)\1/`,
      'name:/(?=a)a/',
      'name:>="m"',
    ];

    const violations: string[] = [];
    let compared = 0;

    for (let run = 0; run < RUNS; run += 1) {
      const good = pick(next, GOOD);
      const bad = pick(next, BAD);
      const field = good.split(':')[0] ?? 'name';
      const bare = bad.slice(bad.indexOf(':') + 1);

      let alone: unknown[];

      try {
        alone = engine.filter(good, rows);
      } catch {
        continue;
      }

      compared += 1;

      // A dropped clause constrains nothing, so the pair must equal the good
      // clause alone — under AND, and in either order.
      for (const q of [`${good} AND ${bad}`, `${bad} AND ${good}`]) {
        const got = engine.filter(q, rows);

        if (got.length !== alone.length) {
          violations.push(
            `${q}: ${String(got.length)} rows, but ${good} alone gives ${String(alone.length)}`,
          );
        }
      }

      // And a field GROUP must agree with the flat form of the same clauses.
      if (good.startsWith(`${field}:`) && bad.startsWith(`${field}:`)) {
        const grouped = engine.filter(
          `${field}:(${good.slice(field.length + 1)} OR ${bare})`,
          rows,
        );
        const flat = engine.filter(`${good} OR ${bad}`, rows);

        if (grouped.length !== flat.length) {
          violations.push(
            `group ${field}:(...) gives ${String(grouped.length)} rows where the flat form gives ${String(flat.length)}`,
          );
        }
      }
    }

    didWork('tolerant over-drop', compared, RUNS / 2);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('P7: a hostile value TYPE cannot escape a non-SiftQLError', () => {
  it('survives a throwing accessor anywhere on the type or on what it returns', () => {
    /*
     * P1 covers hostile records, option objects and hand-built ASTs — but not
     * hostile value TYPES, which is the channel the contract calls out and the
     * blind spot behind three separate findings: `type.name` read raw in sixteen
     * places, `type.ordering` read raw on the per-record path, and every field
     * of a returned result object except `.ok` read outside the guard.
     */
    const throwing = (label: string): PropertyDescriptor => ({
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(`${label} threw`);
      },
    });

    const base = (): Record<string, unknown> => ({
      coerceValue: (value: unknown) =>
        typeof value === 'string'
          ? { ok: true, value }
          : { kind: 'miss', ok: false },
      equals: () => true,
      name: 'hostile',
      ordering: { compare: (a: number, b: number) => a - b },
      parseOperand: (token: { kind: string; text?: string }) =>
        token.kind === 'text'
          ? { ok: true, operand: token.text ?? '' }
          : { kind: 'declined', ok: false },
    });

    const MEMBERS = [
      'name',
      'parseOperand',
      'coerceValue',
      'equals',
      'matches',
      'ordering',
      'highlight',
      'highlightSpans',
    ];
    const RESULT_FIELDS = ['ok', 'operand', 'value', 'kind', 'reason', 'code'];
    const QUERIES = ['a', 'n:>5', 'n:[1 TO 9]', 'n:x', 'v:*a*', 'v:/a/'];

    const violations: string[] = [];
    let attempted = 0;

    const check = (type: unknown): void => {
      for (const q of QUERIES) {
        for (const act of [
          () => createEngine({ types: [type] as never }).test(q, { n: 5, v: 'a' }),
          () =>
            createEngine({ types: [type] as never }).filter(q, [{ n: 5, v: 'a' }]),
          () =>
            createEngine({ types: [type] as never }).highlight(q, {
              n: 5,
              v: 'a',
            }),
          () => createEngine({ types: [type] as never }).types.describe(),
        ]) {
          attempted += 1;

          try {
            act();
          } catch (error) {
            if (!isSiftQLError(error)) {
              violations.push(
                `${q}: ${(error as Error).name}: ${(error as Error).message.slice(0, 40)}`,
              );
            }
          }
        }
      }
    };

    // A throwing accessor on each member of the type itself...
    for (const member of MEMBERS) {
      const type = base();

      Object.defineProperty(type, member, throwing(member));
      check(type);
    }

    // ...on a member that survives its first read and throws later...
    for (const member of ['name', 'ordering']) {
      const type = base();
      let reads = 0;

      Object.defineProperty(type, member, {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1;

          if (reads > 1) {
            throw new Error(`${member} threw on read ${String(reads)}`);
          }

          return member === 'name'
            ? 'hostile'
            : { compare: (a: number, b: number) => a - b };
        },
      });
      check(type);
    }

    // ...and on each field of what the callbacks hand back.
    for (const field of RESULT_FIELDS) {
      for (const method of ['parseOperand', 'coerceValue']) {
        const type = base();

        type[method] = () =>
          Object.defineProperty({ ok: true }, field, throwing(field));
        check(type);
      }
    }

    didWork('hostile value types', attempted, MEMBERS.length * QUERIES.length);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe('P8: a built tree and a parsed one are the same tree', () => {
  it('agrees with the parser on every regex flag ordering', () => {
    /*
     * `builders.regex` sorted its flags under a comment claiming the parser
     * sorted them too. It does not — `types.ts` calls the array order-preserving
     * on purpose — so the sorting was the one thing preventing the equality the
     * comment promised, and nothing asserted it either way.
     */
    const next = rng(4848);
    const FLAGS = ['d', 'g', 'i', 'm', 's', 'y'] as const;
    const violations: string[] = [];
    let compared = 0;

    for (let run = 0; run < RUNS; run += 1) {
      const chosen: string[] = [];

      for (let at = 0; at < 1 + Math.floor(next() * 4); at += 1) {
        const flag = pick(next, FLAGS);

        if (!chosen.includes(flag)) {
          chosen.push(flag);
        }
      }

      const source = pick(next, ['a', 'ab', String.raw`\d+`, '[a-z]']);
      const built = builders.regex(source, chosen as never);
      const parsed = parse(`/${source}/${chosen.join('')}`) as {
        flags?: readonly string[];
      };

      compared += 1;

      if (JSON.stringify(built.flags) !== JSON.stringify(parsed.flags)) {
        violations.push(
          `/${source}/${chosen.join('')}: built ${JSON.stringify(built.flags)} vs parsed ${JSON.stringify(parsed.flags)}`,
        );
      }
    }

    didWork('builder/parser flag agreement', compared, RUNS / 2);
    expect(violations.slice(0, 5)).toEqual([]);
  });

  it('serializes to text that is a fixed point', () => {
    /*
     * The round-trip law stated from the BUILDER side. I4 is asserted over
     * queries the parser accepts; a tree assembled by hand never goes through
     * `parse()` first, so nothing checked that the builders produce trees the
     * rest of the package agrees with.
     *
     * The law here is TEXT idempotence, not node-for-node identity, and the
     * difference is not a weakening — it is what is actually true. A hand-built
     * tree can be a shape the parser never emits: `or(a, or(b, c))` is
     * right-nested where parsing always yields left-nested. `serialize` handles
     * that correctly by emitting `a OR (b OR c)`, and re-parsing those
     * parentheses necessarily produces a `ParenthesizedExpression` the built
     * tree did not contain. The meaning survives, the text survives, one
     * structural node appears. Demanding deep equality would be demanding that
     * `serialize` lose the grouping it just added to preserve the shape.
     */
    const next = rng(4949);
    const leaf = (): SiftQLAst => {
      switch (Math.floor(next() * 6)) {
        case 0:
          return builders.term(pick(next, ['ada', 'in progress', '', 'true']));
        case 1:
          return builders.quoted(pick(next, ['ada', 'in progress', 'true']));
        case 2:
          return builders.boolean(next() < 0.5);
        case 3:
          return builders.regex('a+', ['i']);
        case 4:
          return builders.wildcard(pick(next, ['a*b', '*x', '?y']));
        default:
          return builders.null();
      }
    };

    const tree = (depth: number): SiftQLAst => {
      if (depth === 0) {
        return leaf();
      }

      switch (Math.floor(next() * 5)) {
        case 0:
          return builders.and(
            tree(depth - 1) as never,
            tree(depth - 1) as never,
          );
        case 1:
          return builders.or(
            tree(depth - 1) as never,
            tree(depth - 1) as never,
          );
        case 2:
          return builders.not(tree(depth - 1) as never);
        case 3:
          return builders.group(tree(depth - 1) as never);
        default:
          return builders.tag(
            builders.field(...(pick(next, [['a'], ['a', 'b'], ['x']]) as [string])),
            leaf() as never,
          );
      }
    };

    const violations: string[] = [];
    let checked = 0;

    for (let run = 0; run < RUNS; run += 1) {
      const built = tree(2);
      const text = serialize(built);

      checked += 1;

      try {
        const again = serialize(parse(text));

        if (again !== text) {
          violations.push(
            `${JSON.stringify(text)} re-serialized to ${JSON.stringify(again)}`,
          );
        }
      } catch (error) {
        violations.push(
          `${JSON.stringify(text)} does not re-parse: ${(error as Error).message.slice(0, 50)}`,
        );
      }
    }

    didWork('builder round-trip', checked, RUNS / 2);
    expect(violations.slice(0, 5)).toEqual([]);
  });
});
