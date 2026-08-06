import { describe, expect, it } from 'vitest';

import {
  createEngine,
  defineValueType,
  dispositionFor,
  filter,
  isSiftQLError,
  MAX_AST_DEPTH,
  parse,
  serialize,
  SiftQLArgumentError,
  SiftQLConfigError,
  test as matches,
  type SiftQLAst,
} from '../src/index.js';

/**
 * THE FAILURE BOUNDARY.
 *
 * Every test here pins one promise: an error escaping siftql is a `SiftQLError`,
 * carrying a message that names what went wrong. Each was a raw `TypeError`,
 * `RangeError`, or someone else's `Error` before — true statements about our
 * internals, useless to a caller, and invisible to `isSiftQLError()`, so a
 * consumer's `catch` block filed them all as siftql crashes.
 *
 * The distinction the suite is built around: a wrong QUERY or a broken CONFIG
 * always throws, while a dirty VALUE follows `onValueError` and by default just
 * fails to match. One unreadable field in one record must never be able to
 * destroy a whole result set.
 */

/** Nothing may escape that `isSiftQLError` does not recognise. */
const expectOnlySiftQLErrors = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (error) {
    expect(
      isSiftQLError(error),
      `escaped as ${(error as Error).constructor.name}: ${(error as Error).message}`,
    ).toBe(true);

    return undefined;
  }
};

/**
 * A real BareTextLiteral.
 *
 * Written out in full deliberately: an earlier version of this helper carried
 * `kind` and `raw` — neither of which is in the contract — and no `literal` or
 * `quoted`, which are. It was structurally invalid, and three tests here were
 * passing on it until node-shape validation started refusing it.
 */
const litNode = (): SiftQLAst =>
  ({
    literal: 'text',
    location: { end: 1, start: 0 },
    quoted: false,
    type: 'LiteralExpression',
    value: 'a',
  }) as unknown as SiftQLAst;

/** A tree `parse()` could never emit, at whatever depth is asked for. */
const nestedNode = (levels: number): SiftQLAst => {
  let node = litNode();

  for (let index = 0; index < levels; index += 1) {
    node = {
      expression: node,
      location: { end: 1, start: 0 },
      type: 'ParenthesizedExpression',
    } as unknown as SiftQLAst;
  }

  return node;
};

/**
 * A value type that claims every operand, with one member sabotaged. Used to
 * stand in for any consumer type with a bug in it.
 */
const sabotaged = (overrides: Record<string, unknown>) =>
  createEngine({
    types: [
      defineValueType<unknown, unknown>({
        coerceValue: (value: unknown) => ({ ok: true as const, value }),
        equals: () => true,
        name: 'evil',
        ordering: { compare: () => 0 },
        parseOperand: (token: { readonly value: unknown }) => ({
          ok: true as const,
          value: token.value,
        }),
        ...overrides,
      } as unknown as Parameters<typeof defineValueType>[0]),
    ],
  });

describe('reading values out of hostile records', () => {
  it('finds a leaf 60,000 levels down instead of throwing RangeError', () => {
    // Recursive walks threw a raw RangeError here. A stack limit is not a
    // property of the data, so it must not be a property of the answer.
    let deep: unknown = { v: 'needle' };

    for (let index = 0; index < 60_000; index += 1) {
      deep = { n: deep };
    }

    expect(filter('needle', [deep])).toHaveLength(1);
  });

  it('walks a self-referential record in bounded time', () => {
    // `{ a: [self, self] }` doubled the frontier per path segment: sixteen
    // segments was 65,536 candidates, and the query below never returned.
    const self: Record<string, unknown> = { name: 'x' };

    self.a = [self, self];

    const started = Date.now();
    const path = Array.from({ length: 16 }, () => 'a').join('.');

    filter(`${path}.name:x`, [self]);

    expect(Date.now() - started).toBeLessThan(500);
  });

  it('still finds a value reached by two different paths', () => {
    // The cycle guard must be per-BRANCH. A global visited-set would treat the
    // second reference to a shared object as a cycle and drop real leaves.
    const shared = { v: 'alice' };

    expect(filter('alice', [{ p: shared, q: shared }])).toHaveLength(1);
  });

  it('skips a record whose getter throws, and keeps the rest', () => {
    const rows = [
      { v: 'alice' },
      {
        get v(): string {
          throw new Error('boom');
        },
      },
      { v: 'alicia' },
    ];

    // Default policy: the unreadable row does not match, the other two do.
    expect(filter('ali', rows)).toHaveLength(2);
  });

  it("reports a throwing getter as a value failure under onValueError:'throw'", () => {
    const engine = createEngine({ onValueError: 'throw' });
    const rows = [
      {
        get v(): string {
          throw new Error('boom');
        },
      },
    ];

    // The original exception is preserved, so wrapping costs no debuggability.
    expect(() => engine.filter('v:ali*', rows)).toThrowError(
      /reading this value threw/u,
    );

    try {
      engine.filter('v:ali*', rows);
    } catch (error) {
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
      expect((error as { cause: Error }).cause.message).toBe('boom');
    }
  });

  it('treats Object.create(Date.prototype) as a non-date, not a crash', () => {
    // `instanceof Date` is only a prototype check, so this passed it and then
    // threw `TypeError: this is not a Date object` from getTime(). A
    // prototype-restoring deserializer produces exactly this shape.
    const impostor: unknown = Object.create(Date.prototype);

    expectOnlySiftQLErrors(() =>
      filter('createdAt:>2020-01-01', [{ createdAt: impostor }]),
    );
    expectOnlySiftQLErrors(() => filter('anything', [{ createdAt: impostor }]));

    // A real Date is unaffected: the check reads the internal slot, so it also
    // accepts a cross-realm Date that `instanceof` would reject.
    expect(
      filter('createdAt:>2020-01-01', [{ createdAt: new Date('2021-01-01') }]),
    ).toHaveLength(1);
  });
});

describe('malformed configuration is refused at createEngine()', () => {
  // Eagerly, not on whichever record first holds a date: a failure whose timing
  // depends on the data is far harder to attribute than one at setup.
  const cases: readonly [string, Record<string, unknown>][] = [
    ['dateFormat: 123', { dateFormat: 123 }],
    ['dateFormat: null', { dateFormat: null }],
    ['dateFormat: an empty string', { dateFormat: '' }],
    ['dateFormat: [valid, 7]', { dateFormat: ['YYYY-MM-DD', 7] }],
    ['parseDate: a string', { parseDate: 'nope' }],
    ['onValueError: an unknown word', { onValueError: 'bogus' }],
    ['onRecovered: a number', { onRecovered: 1 }],
    ['tolerant: a string', { tolerant: 'yes' }],
    ['maxPatternLength: negative', { maxPatternLength: -5 }],
    ['maxPatternLength: fractional', { maxPatternLength: 1.5 }],
    ['typeStrategy: an unknown word', { typeStrategy: 'clobber' }],
    ['types: a name-keyed object', { types: {} }],
    ['types: [{}]', { types: [{}] }],
    ['types: a type with no methods', { types: [{ name: 'x' }] }],
  ];

  for (const [label, options] of cases) {
    it(`refuses ${label}`, () => {
      expect(() => createEngine(options)).toThrow(SiftQLConfigError);
    });
  }

  it('names the offending option and what arrived', () => {
    expect(() => createEngine({ dateFormat: 123 as never })).toThrowError(
      /options\.dateFormat must be .*received number \(123\)/u,
    );
  });

  it('accepts an unknown option', () => {
    // Forward compatibility: a consumer who adopts a new option and then has to
    // downgrade for an unrelated reason should find it ignored, not fatal.
    expect(() => createEngine({ soonToExist: true } as never)).not.toThrow();
  });
});

describe('garbage arguments are named, not stumbled over', () => {
  const cases: readonly [string, () => unknown][] = [
    ['parse(null)', () => parse(null as never)],
    ['parse(42)', () => parse(42 as never)],
    ['parse(Symbol())', () => parse(Symbol('x') as never)],
    ['parse("a", 3)', () => parse('a', 3 as never)],
    ['filter(q, null)', () => filter('a', null as never)],
    ['filter(q, a Set)', () => filter('a', new Set([1]) as never)],
    ['filter(q, "xy")', () => filter('a', 'xy' as never)],
    ['test(a bogus node)', () => matches({ type: 'Nope' } as never, {})],
    ['serialize(null)', () => serialize(null as never)],
    ['serialize({type:"B"})', () => serialize({ type: 'B' } as never)],
    ['serialize([])', () => serialize([] as never)],
    ['createEngine(null)', () => createEngine(null as never)],
    ['createEngine("x")', () => createEngine('x' as never)],
    ['createEngine([])', () => createEngine([] as never)],
  ];

  for (const [label, run] of cases) {
    it(`${label} throws a SiftQLArgumentError`, () => {
      expect(run).toThrow(SiftQLArgumentError);
    });
  }

  it('tells a caller holding an iterable what to do about it', () => {
    expect(() => filter('a', new Set([1]) as never)).toThrowError(
      /spread it first/u,
    );
  });

  it('refuses an unknown node type rather than serializing it to nothing', () => {
    // This returned '' — indistinguishable from a legitimately empty query,
    // which turned a typo into a query that matched everything.
    expect(() => serialize({ type: 'bogus' } as never)).toThrowError(
      /"bogus" is not a known node type/u,
    );
  });
});

describe('a value type with a bug in it cannot crash siftql', () => {
  const sabotages: readonly [string, Record<string, unknown>][] = [
    [
      'parseOperand throws',
      {
        parseOperand: () => {
          throw new Error('x');
        },
      },
    ],
    [
      'coerceValue throws',
      {
        coerceValue: () => {
          throw new Error('x');
        },
      },
    ],
    [
      'equals throws',
      {
        equals: () => {
          throw new Error('x');
        },
      },
    ],
    [
      'matches throws',
      {
        matches: () => {
          throw new Error('x');
        },
      },
    ],
    [
      'ordering.compare throws',
      {
        ordering: {
          compare: () => {
            throw new Error('x');
          },
        },
      },
    ],
    [
      'highlight throws',
      {
        highlight: () => {
          throw new Error('x');
        },
      },
    ],
    ['equals returns a string', { equals: () => 'yes' }],
    ['matches returns a number', { matches: () => 1 }],
    ['coerceValue returns undefined', { coerceValue: () => undefined }],
    ['parseOperand returns null', { parseOperand: () => null }],
    ['ordering.compare returns NaN', { ordering: { compare: () => NaN } }],
    ['ordering.compare returns a string', { ordering: { compare: () => 'x' } }],
    [
      'coerceValue returns an unknown failure kind',
      { coerceValue: () => ({ kind: 'bogus', ok: false }) },
    ],
  ];

  const rows = [{ f: 'a' }];

  for (const [label, overrides] of sabotages) {
    it(`${label}: every entry point still fails as a SiftQLError`, () => {
      // All three, because they take different paths through the evaluator: a
      // match site, a range site, and the highlight pass.
      expectOnlySiftQLErrors(() => sabotaged(overrides).filter('f:1', rows));
      expectOnlySiftQLErrors(() =>
        sabotaged(overrides).filter('f:[1 TO 9]', rows),
      );
      expectOnlySiftQLErrors(() =>
        sabotaged(overrides).highlight('f:1', rows[0]),
      );
    });
  }

  it('refuses a truthy non-boolean from matches rather than coercing it', () => {
    // `'no'` is truthy too, so coercing would make such a type match every
    // record — including the ones it meant to reject.
    expect(() =>
      sabotaged({ equals: () => 'yes' }).filter('f:1', rows),
    ).toThrowError(/must return a boolean/u);
  });

  it('treats a throwing factory as a config failure', () => {
    expect(() =>
      createEngine({
        types: [
          () => {
            throw new Error('factory');
          },
        ],
      }),
    ).toThrow(SiftQLConfigError);
  });

  it('refuses a factory that returns something that is not a type', () => {
    expect(() => createEngine({ types: [() => 42 as never] })).toThrow(
      SiftQLConfigError,
    );
  });

  it('lets a throwing highlight cost the highlight, not the match', () => {
    // The record has already matched by the time `highlight` runs. A decorative
    // hook must not be able to change the answer to the query.
    const engine = sabotaged({
      highlight: () => {
        throw new Error('x');
      },
    });

    expect(engine.filter('f:1', rows)).toHaveLength(1);
    expect(engine.highlight('f:1', rows[0])).toHaveLength(1);
  });
});

describe('a value type cannot rewrite engine policy from a callback', () => {
  // `readonly` is a compile-time claim: a type authored in JavaScript, or one
  // that casts, could assign to ctx.options and change how siftql treated every
  // LATER record in the same filter.
  const inspect = <T>(read: (ctx: Record<string, never>) => T): T => {
    let captured: T | undefined;

    sabotaged({
      coerceValue: (value: unknown, ctx: unknown) => {
        captured = read(ctx as Record<string, never>);

        return { ok: true, value };
      },
    }).filter('f:1', [{ f: 'a' }]);

    return captured as T;
  };

  it('freezes the context, its options, its temporal options and its path', () => {
    expect(
      inspect((ctx) =>
        [
          ctx,
          ctx.options,
          ctx.path,
          (ctx.options as unknown as { temporal: object }).temporal,
        ].every((part) => Object.isFrozen(part)),
      ),
    ).toBe(true);
  });

  it('does not expose the failure policy to a value type at all', () => {
    /*
     * Stronger than "the value does not change", which is what this test used to
     * assert. `errors.ts` and `registry.ts` both state that a ValueType never
     * SEES `onValueError` — the split-policy design rests on it, since a type
     * that branched on the policy would decide for itself whether a dirty value
     * is fatal. The key is now absent from the object, not merely read-only.
     *
     * Checked on the VALUE rather than on a thrown TypeError: a frozen write
     * throws only in strict mode, and whether the consumer's module is strict is
     * not ours to decide.
     */
    expect(
      inspect((ctx) => {
        const options = ctx.options as unknown as Record<string, unknown>;

        try {
          options.onValueError = 'throw';
        } catch {
          // Strict-mode caller. Either way nothing must appear.
        }

        return [
          'onValueError' in options,
          'onRecovered' in options,
          options.onValueError,
          // Everything a type legitimately needs is still there.
          typeof options.matchKeys,
          typeof options.temporal,
        ];
      }),
    ).toEqual([false, false, undefined, 'boolean', 'object']);
  });

  it('leaves the path unchanged after an attempt to push onto it', () => {
    expect(
      inspect((ctx) => {
        const path = ctx.path as unknown as string[];

        try {
          path.push('injected');
        } catch {
          // As above.
        }

        return path.length;
      }),
    ).toBe(1);
  });
});

describe('the failure-policy table is looked up, not assumed', () => {
  it('reports undefined for a pair it does not cover', () => {
    // Typed as always returning a disposition, an unknown kind yields undefined,
    // `undefined === 'value-error'` is false, and the strictest row in the table
    // silently becomes the most lenient.
    expect(dispositionFor('bogus' as never, 'miss')).toBeUndefined();
    expect(dispositionFor('scan', 'bogus' as never)).toBeUndefined();
  });

  it('still answers every real pair', () => {
    expect(dispositionFor('ordered', 'miss')).toBe('value-error');
    expect(dispositionFor('scan', 'invalid')).toBe('no-match');
  });
});

describe('shared references in a record', () => {
  /*
   * BOTH directions are pinned. A guard that refuses to revisit an object stops
   * the denial of service and starts answering wrongly; one that always
   * revisits does the reverse. Both have to hold at once.
   */
  it('follows a parent back-reference instead of refusing it', () => {
    const root: Record<string, unknown> = { name: 'root' };
    const kid: Record<string, unknown> = { name: 'kid', parent: root };

    root.children = [kid];

    // Ground truth: root.children[0].parent.name === 'root'. Refusing to
    // re-enter an object already on the branch answered false here — on a path
    // that is finite, because a fielded walk takes one step per query segment
    // and cannot loop.
    expect(matches('children.0.parent.name:root', root)).toBe(true);
    expect(matches('parent.children.0.name:kid', kid)).toBe(true);
  });

  it('gives the same answer whether or not the record shares identity', () => {
    // The sharpest symptom of the ancestor-set bug: an acyclic record of the
    // identical shape answered true, so the result depended on object identity
    // rather than on the data.
    const shared: Record<string, unknown> = { name: 'root' };
    const withSharing = { children: [{ name: 'kid', parent: shared }] };
    const withoutSharing = {
      children: [{ name: 'kid', parent: { name: 'root' } }],
    };

    expect(matches('children.0.parent.name:root', withSharing)).toBe(
      matches('children.0.parent.name:root', withoutSharing),
    );
  });

  it('walks an exponentially-aliased record in bounded time', () => {
    // 21 objects, ~1,000,000 distinct paths. Visiting each object once makes
    // this linear; before, it doubled per level and took 8.7 seconds.
    let unfielded: unknown = { leaf: 'needle' };
    let fielded: unknown = { v: 'needle' };

    for (let index = 0; index < 20; index += 1) {
      unfielded = { a: unfielded, b: unfielded };
      fielded = { a: [fielded, fielded] };
    }

    const started = Date.now();

    expect(filter('needle', [unfielded])).toHaveLength(1);
    expect(
      filter(`${Array.from({ length: 20 }, () => 'a').join('.')}.v:needle`, [
        fielded,
      ]),
    ).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('still finds a value in a cyclic record', () => {
    const self: Record<string, unknown> = { name: 'x' };

    self.a = [self, self];

    // The cycle is bounded by the same visit-once rule, with nothing special
    // about it — and unlike the ancestor-set version, the value is still FOUND.
    const path = Array.from({ length: 12 }, () => 'a').join('.');

    expect(filter(`${path}.name:x`, [self])).toHaveLength(1);
    expect(filter('x', [self])).toHaveLength(1);
  });
});

describe('arrays and accessors that lie', () => {
  it('never expands a declared length', () => {
    // A sparse array declaring 600,000,000 slots and holding one killed the
    // process outright — an uncatchable OOM from a 200-byte record.
    const sparse = new Array<unknown>(600_000_000);

    sparse[0] = 'needle';

    const started = Date.now();

    expect(filter('needle', [{ tags: sparse }])).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('ignores a length trap that lies', () => {
    const liar = new Proxy(['needle'], {
      get: (target, key, receiver): unknown =>
        key === 'length' ? 5e8 : Reflect.get(target, key, receiver),
    });

    expect(filter('needle', [{ tags: liar }])).toHaveLength(1);
  });

  it('survives a getter that throws only on the second read', () => {
    // `safeLength` read `length` twice and guarded only the first.
    let reads = 0;
    const tags = new Proxy(['a'], {
      get(target, key, receiver): unknown {
        if (key === 'length') {
          reads += 1;

          if (reads >= 2) {
            throw new Error('second read');
          }
        }

        return Reflect.get(target, key, receiver);
      },
    });

    expectOnlySiftQLErrors(() => filter('a', [{ tags }]));
  });

  it('survives a throwing getOwnPropertyDescriptor trap', () => {
    // hasOwnProperty invokes this trap, and the own-property TEST had no guard
    // even though every property READ did.
    const trapped = () => {
      throw new Error('gopd');
    };

    expectOnlySiftQLErrors(() =>
      filter('k:a', [
        new Proxy({ k: 'a' }, { getOwnPropertyDescriptor: trapped }),
      ]),
    );
    expectOnlySiftQLErrors(() =>
      filter('a', [
        { tags: new Proxy(['a'], { getOwnPropertyDescriptor: trapped }) },
      ]),
    );
    expectOnlySiftQLErrors(() =>
      filter('tags.0:a', [
        { tags: new Proxy(['a'], { getOwnPropertyDescriptor: trapped }) },
      ]),
    );
  });

  it('routes a read failure on an INTERMEDIATE path segment', () => {
    // This was silently discarded: the branch was dropped and the error with
    // it, so a caller who asked to be told about dirty data was told nothing.
    const rows = [
      {
        get a(): Record<string, unknown> {
          throw new Error('boom');
        },
      },
    ];

    expect(filter('a.b:null', rows)).toHaveLength(0);
    expect(() =>
      createEngine({ onValueError: 'throw' }).filter('a.b:null', rows),
    ).toThrowError(/reading this value threw/u);
  });
});

describe('shared subtrees in an AST', () => {
  const literal = () => litNode();

  /** `{left: v, right: v}` n deep: n+1 nodes, 2^n paths. */
  const shared = (levels: number): SiftQLAst => {
    let node = literal();

    for (let index = 0; index < levels; index += 1) {
      node = {
        left: node,
        location: { end: 1, start: 0 },
        operator: {
          location: { end: 1, start: 0 },
          notation: 'explicit',
          operator: 'OR',
          type: 'BooleanOperator',
        },
        right: node,
        type: 'LogicalExpression',
      } as unknown as SiftQLAst;
    }

    return node;
  };

  it('refuses a tree whose expansion is too large', () => {
    // 41 nodes at depth 20 serialized to a 6 MB string; 29 nodes took the
    // validator itself 32 seconds. Depth saw nothing wrong, because nothing was.
    const started = Date.now();

    expect(() => serialize(shared(24))).toThrow(SiftQLArgumentError);
    expect(() => matches(shared(24), {})).toThrow(SiftQLArgumentError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('says the expansion is the problem, not the depth', () => {
    expect(() => serialize(shared(24))).toThrowError(
      /larger than 500000 nodes when expanded/u,
    );
  });

  it('still accepts modest, legitimate sharing', () => {
    // `const t = builders.term('a'); builders.or(t, t)` is a natural thing to
    // write and must keep working: sharing is not the error, expansion is.
    expect(serialize(shared(8))).toContain('OR');
  });

  it('does not invoke getters on AST nodes', () => {
    // Object.values reads every own enumerable property, so an accessor-backed
    // node would throw a raw error out of serialize().
    const withAccessor = {
      literal: 'text',
      location: { end: 1, start: 0 },
      quoted: false,
      type: 'LiteralExpression',
      value: 'x',
      get extra(): unknown {
        throw new Error('accessor');
      },
    } as unknown as SiftQLAst;

    expect(serialize(withAccessor)).toBe('x');
  });
});

describe('the validator cannot itself fail', () => {
  // describeArgument runs only when an argument is ALREADY known to be wrong,
  // and it read `constructor.name` and `length` unguarded — so the code whose
  // job is to produce SiftQLArgumentError threw the raw error instead.
  const hostile = (): unknown =>
    new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );

  const cases: readonly [string, () => unknown][] = [
    ['parse(a hostile proxy)', () => parse(hostile() as never)],
    [
      'parse with a throwing option accessor',
      () =>
        parse('a', {
          get tolerant(): boolean {
            throw new Error('opt');
          },
        }),
    ],
    [
      'filter with a hostile items proxy',
      () =>
        filter(
          'a',
          new Proxy([1], {
            get(target, key, receiver): unknown {
              if (key === 'length') {
                throw new Error('len');
              }

              return Reflect.get(target, key, receiver);
            },
          }) as never,
        ),
    ],
    [
      'filter with hostile overrides',
      () => filter('a', [{}], hostile() as never),
    ],
    [
      'createEngine with a throwing type name',
      () =>
        createEngine({
          types: [
            {
              get name(): string {
                throw new Error('name');
              },
            } as never,
          ],
        }),
    ],
  ];

  for (const [label, run] of cases) {
    it(`${label} still fails as a SiftQLError`, () => {
      expectOnlySiftQLErrors(run);
    });
  }
});

describe('AST depth', () => {
  it('refuses a hand-built tree too deep to walk', () => {
    const tooDeep = nestedNode(50_000);

    expect(() => serialize(tooDeep)).toThrow(SiftQLArgumentError);
    expect(() => matches(tooDeep, {})).toThrow(SiftQLArgumentError);
  });

  it('says what is wrong and what to look for', () => {
    expect(() => matches(nestedNode(50_000), {})).toThrowError(
      /nested more than 2200 levels deep/u,
    );
  });

  it('accepts a tree right up to the limit', () => {
    expect(serialize(nestedNode(MAX_AST_DEPTH - 2)).length).toBeGreaterThan(0);
  });

  it('round-trips the deepest, largest query parse() will accept', () => {
    // The limit is DERIVED from the parser's own caps precisely so this holds:
    // anything siftql can produce, siftql can consume.
    const maximal = `${'('.repeat(199)}${Array.from(
      { length: 1800 },
      () => 'a',
    ).join(' OR ')}${')'.repeat(199)}`;

    const once = serialize(parse(maximal));

    expect(serialize(parse(once))).toBe(once);
  });
});
