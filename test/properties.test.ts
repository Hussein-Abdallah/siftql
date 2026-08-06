import { describe, expect, it } from 'vitest';

import {
  builders,
  createEngine,
  resolveTemporal,
  filter,
  highlight,
  isSiftQLError,
  parse,
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
  /*
   * DEFERRED, and this one is an unfixed denial of service rather than a
   * cosmetic gap: a chain-shaped record — threaded comments, a linked list — has
   * a leaf at every level, and `materialise` builds an O(depth) path for each
   * one, so time AND retained memory are quadratic. An ~830 KB record kills the
   * process.
   *
   * The linked-list trail already fixed the case with one leaf at the bottom.
   * Fixing this one needs the path to stay lazy all the way into `emit`, since
   * only a matching or failing candidate ever needs its path materialised — a
   * real refactor of the Candidate contract, not a patch.
   */
  it.fails('is not quadratic in record depth', () => {
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
     * THE PROPERTY THE MATCHER OWES, and the one no version of the SCREEN could
     * keep: whatever is accepted must not hang.
     *
     * Every pattern below was found by an auditor rather than by this suite, and
     * every one of them defeated the screen — two are its own commit message's
     * headline examples with one parenthesis added. They are all accepted now,
     * because an automaton makes them linear.
     */
    const suspects = [
      '^(a+)+$',
      '^(a+){1,99}$',
      '^(a*){1,99}$',
      '^(a+){99}$',
      '^(a{1,3})+$',
      '^(a{1,99})+$',
      '^([a-z]{1,99})+$',
      '^(a|a)*$',
      '^((a|a))*$',
      '^(?:(a|a))*$',
      '^((a|a?))*$',
      '^([a-z]|[a-c])*$',
      '^((a|b)|(a|c))*$',
      String.raw`^(\w{1,50})+$`,
      '^(x+x+){1,99}y$',
    ];

    const slow: string[] = [];

    for (const pattern of suspects) {
      const compiled = compileLinear(pattern, '');

      if (!compiled.ok) {
        continue;
      }

      const started = Date.now();

      compiled.matcher.test(`${'a'.repeat(40)}!`);

      const elapsed = Date.now() - started;

      if (elapsed > 100) {
        slow.push(`${pattern} accepted, ${String(elapsed)}ms`);
      }
    }

    expect(slow).toEqual([]);
  });

  it('agrees with RegExp on patterns RegExp can safely run', () => {
    /*
     * The other half of replacing an engine: it has to give the SAME ANSWERS.
     * A fast matcher that disagrees with `RegExp` would trade a denial of
     * service for silently wrong results, which is the worse bargain.
     */
    const next = rng(90_210);
    const atoms = [
      'a',
      'b',
      '1',
      '.',
      String.raw`\d`,
      String.raw`\w`,
      String.raw`\s`,
      '[abc]',
      '[^abc]',
      '[a-c]',
      String.raw`\.`,
    ];
    const quantifiers = ['', '', '*', '+', '?', '{2}', '{1,3}', '*?', '+?'];
    const build = (depth: number): string => {
      if (depth === 0) {
        return pick(next, atoms) + pick(next, quantifiers);
      }

      const roll = next();

      if (roll < 0.25) {
        return `(${build(depth - 1)})${pick(next, quantifiers)}`;
      }

      if (roll < 0.45) {
        return `${build(depth - 1)}|${build(depth - 1)}`;
      }

      if (roll < 0.55) {
        return `^${build(depth - 1)}`;
      }

      if (roll < 0.65) {
        return `${build(depth - 1)}$`;
      }

      return build(depth - 1) + build(depth - 1);
    };

    const subjects = ['', 'a', 'ab', 'abc', 'aab', 'xyz', 'a1b2', 'AAA', 'cab'];
    const disagreements: string[] = [];

    for (let run = 0; run < RUNS * 4; run += 1) {
      const source = build(3);
      const flags = pick(next, ['', '', 'i', 'm', 's']);

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
        if (native.test(subject) !== compiled.matcher.test(subject)) {
          disagreements.push(
            `/${source}/${flags} vs ${JSON.stringify(subject)}`,
          );
        }
      }
    }

    expect(disagreements.slice(0, 5)).toEqual([]);
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
