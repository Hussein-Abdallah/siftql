import { describe, expect, it } from 'vitest';

import {
  claimed,
  createEngine,
  DECLINED,
  defineValueType,
  filter,
  malformedOperand,
  MISS,
  resolved,
  SiftQLConfigError,
  SiftQLOperandError,
  SiftQLValueError,
  test as matches,
} from '../src/index.js';

interface Row {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly height: number | null;
  readonly member: boolean | null;
  readonly created: string | number | Date;
  readonly tags: readonly string[];
  readonly bio: string;
  readonly meta?: { readonly owner: { readonly name: string } };
}

const ROWS: readonly Row[] = [
  {
    bio: 'this is just a test',
    created: '2020-06-15T10:00:00Z',
    height: 170,
    id: 1,
    member: true,
    meta: { owner: { name: 'sam' } },
    name: 'Ada Lovelace',
    status: 'In Progress',
    tags: ['red', 'blue'],
  },
  {
    bio: 'nothing here',
    created: '2019-01-01',
    height: 180,
    id: 2,
    member: false,
    name: 'Alan Turing',
    status: 'done',
    tags: ['blue'],
  },
  {
    bio: 'IS JUST shouting',
    created: 1_593_000_000_000,
    height: 165,
    id: 3,
    member: true,
    name: 'Grace Hopper',
    status: 'inactive',
    tags: [],
  },
  {
    bio: '',
    created: new Date('2021-03-01T00:00:00Z'),
    height: null,
    id: 4,
    member: null,
    name: 'ada byron',
    status: 'active',
    tags: ['red'],
  },
];

const ids = (query: string, options = {}): number[] =>
  filter(query, ROWS, options).map((row) => row.id);

describe('whole-value equality', () => {
  it('does not match a substring', () => {
    // The decision this package is built on: status:active never finds
    // "inactive".
    expect(ids('status:active')).toEqual([4]);
  });

  it('finds a substring only when asked with wildcards', () => {
    expect(ids('status:*active*')).toEqual([3, 4]);
  });

  it('keeps FIELDED clauses exact', () => {
    expect(ids('name:ada')).toEqual([]);
    expect(ids('name:"Ada Lovelace"')).toEqual([1]);
    expect(ids('name:*ada*')).toEqual([1, 4]);
  });
});

describe('unfielded terms are loose, fielded terms are exact', () => {
  it('treats a bare word as containment, because the user named no field', () => {
    // A person typing one word into a search box is browsing, not asserting
    // equality -- and would otherwise get an empty screen, since no stored
    // value is ever exactly "ada".
    expect(ids('ada')).toEqual([1, 4]);
    expect(ids('progress')).toEqual([1]);
    expect(ids('"in progress"')).toEqual([1]);
  });

  it('is case-insensitive, since an unfielded term has no operator to double', () => {
    expect(ids('ADA')).toEqual([1, 4]);
    expect(ids('LOVELACE')).toEqual([1]);
  });

  it('ANDs several bare words', () => {
    expect(ids('is just')).toEqual([1, 3]);
    expect(ids('ada lovelace')).toEqual([1]);
  });

  it('does NOT loosen a fielded clause, so status:active still refuses "inactive"', () => {
    // The whole point of the split: looseness is confined to the case where
    // the user gave no field to be precise about.
    expect(ids('status:active')).toEqual([4]);
    expect(ids('name:ada')).toEqual([]);
  });

  it('leaves typed operands alone when unfielded', () => {
    // Only free TEXT is loosened; keywords and numbers keep their meaning.
    expect(ids('true')).toEqual([1, 3]);
    expect(ids('null')).toEqual([4]);
    expect(ids('170')).toEqual([1]);
  });

  it('still never errors on a scan, whatever onValueError says', () => {
    expect(() =>
      filter('anything', ROWS, { onValueError: 'throw' }),
    ).not.toThrow();
  });
});

describe('case sensitivity', () => {
  it('ignores case by default', () => {
    expect(ids('status:"in progress"')).toEqual([1]);
    expect(ids('name:"ADA LOVELACE"')).toEqual([1]);
  });

  it('respects case under the doubled colon', () => {
    expect(ids('status::"In Progress"')).toEqual([1]);
    expect(ids('status::"in progress"')).toEqual([]);
  });

  it('answers the multi-word containment question in both collations', () => {
    expect(ids('bio:"is just"')).toEqual([]);
    expect(ids('bio:"*is just*"')).toEqual([1, 3]);
    expect(ids('bio::"*is just*"')).toEqual([1]);
  });

  it('leaves a regular expression to its own flags', () => {
    // Neither : nor :: adds or removes `i`.
    expect(ids('name:/^A/')).toEqual([1, 2]);
    expect(ids('name:/^A/i')).toEqual([1, 2, 4]);
  });
});

describe('numbers', () => {
  it('matches and orders', () => {
    expect(ids('height:170')).toEqual([1]);
    expect(ids('height:>170')).toEqual([2]);
    expect(ids('height:>=170')).toEqual([1, 2]);
    expect(ids('height:<170')).toEqual([3]);
  });

  it('agrees between : and := , since number omits `matches`', () => {
    expect(ids('height:170')).toEqual(ids('height:=170'));
  });

  it('treats a quoted number as text', () => {
    // Quoting is what preserves leading zeros and version-like strings.
    expect(ids('height:"170"')).toEqual([]);
  });
});

describe('ranges', () => {
  it('honours inclusivity per boundary', () => {
    expect(ids('height:[165 TO 180]')).toEqual([1, 2, 3]);
    expect(ids('height:{165 TO 180}')).toEqual([1]);
    expect(ids('height:[165 TO 180}')).toEqual([1, 3]);
    expect(ids('height:{165 TO 180]')).toEqual([1, 2]);
  });

  it('supports half-open bounds', () => {
    expect(ids('height:[* TO 170]')).toEqual([1, 3]);
    expect(ids('height:[170 TO *]')).toEqual([1, 2]);
  });
});

describe('real dates', () => {
  it('resolves ISO strings, epoch numbers and Date objects alike', () => {
    // Rows 1, 3 and 4 store their date in three different shapes.
    expect(ids('created:>=2020-01-01')).toEqual([1, 3, 4]);
    expect(ids('created:<2020-01-01')).toEqual([2]);
  });

  it('applies timezone offsets', () => {
    // 09:00+02:00 is 07:00Z, so row 1 at 10:00Z qualifies.
    expect(ids('created:>=2020-06-15T09:00:00+02:00')).toEqual([1, 3, 4]);
    // 13:00+02:00 is 11:00Z, which is after row 1, so it drops out.
    expect(ids('created:>=2020-06-15T13:00:00+02:00')).toEqual([3, 4]);
  });

  it('evaluates temporal ranges through the same code as numbers', () => {
    expect(ids('created:[2020-01-01 TO 2020-12-31]')).toEqual([1, 3]);
  });
});

describe('booleans, null and arrays', () => {
  it('matches booleans by keyword only', () => {
    expect(ids('member:true')).toEqual([1, 3]);
    expect(ids('member:false')).toEqual([2]);
    // Quoted "true" is a four-character string, not the keyword.
    expect(ids('member:"true"')).toEqual([]);
  });

  it('treats an absent key and an explicit null alike', () => {
    expect(ids('member:null')).toEqual([4]);
    expect(ids('height:null')).toEqual([4]);
  });

  it('matches a multi-valued field if any element matches', () => {
    expect(ids('tags:red')).toEqual([1, 4]);
    expect(ids('tags:blue')).toEqual([1, 2]);
  });

  it('walks a nested path', () => {
    expect(ids('meta.owner.name:sam')).toEqual([1]);
  });
});

describe('logic', () => {
  it('evaluates conjunction, disjunction and negation', () => {
    expect(ids('member:true AND height:>=170')).toEqual([1]);
    expect(ids('status:done OR status:active')).toEqual([2, 4]);
    expect(ids('NOT member:true')).toEqual([2, 4]);
    expect(ids('-status:done')).toEqual([1, 3, 4]);
  });

  it('evaluates a field group by pushing the field, not by desugaring', () => {
    expect(ids('status:(active OR done)')).toEqual([2, 4]);
  });

  it('respects precedence', () => {
    expect(ids('status:done OR member:true AND height:>=170')).toEqual([1, 2]);
  });

  it('matches everything on an empty query', () => {
    expect(ids('')).toEqual([1, 2, 3, 4]);
  });
});

describe('fail loud on a bad query', () => {
  it('refuses to order an unordered type', () => {
    // string has no `ordering`, and that absence IS the error.
    expect(() => filter('name:>="m"', ROWS)).toThrow(SiftQLOperandError);
  });

  it('refuses an operand shaped like a date that is not one', () => {
    expect(() => filter('created:>=2021-02-29', ROWS)).toThrow(
      SiftQLOperandError,
    );
  });

  it('throws before touching any row', () => {
    // The operand resolves once at compile time, not per record.
    let visited = 0;
    const watched = new Proxy([{ name: 'x' }], {
      get(target, key, receiver) {
        visited += 1;

        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    expect(() => filter('name:>="m"', watched)).toThrow(SiftQLOperandError);
    expect(visited).toBe(0);
  });
});

describe('dirty data is a policy, not a crash', () => {
  const dirty = [
    { when: '2020-06-01' },
    { when: 'n/a' },
    { when: '2021-01-01' },
  ];

  it('skips an unreadable value by default', () => {
    expect(filter('when:>=2020-01-01', dirty)).toEqual([
      { when: '2020-06-01' },
      { when: '2021-01-01' },
    ]);
  });

  it('throws when asked to', () => {
    expect(() =>
      filter('when:>=2020-01-01', dirty, { onValueError: 'throw' }),
    ).toThrow(SiftQLValueError);
  });

  it('never errors on an unfielded sweep, whatever the setting', () => {
    // One dirty column must not be able to destroy a free-text search.
    expect(() =>
      filter('anything', dirty, { onValueError: 'throw' }),
    ).not.toThrow();
  });
});

describe('per-engine configuration', () => {
  it('lets two engines disagree about the same data', () => {
    const rows = [{ d: '01-06-2020' }, { d: '15-06-2020' }];
    const european = createEngine({ dateFormat: 'DD-MM-YYYY' });
    const american = createEngine({ dateFormat: 'MM-DD-YYYY' });

    expect(european.filter('d:>=05-06-2020', rows)).toEqual([
      { d: '15-06-2020' },
    ]);
    // Under MM-DD-YYYY neither value is a real date (month 15, month 01 day 06
    // is January), so the comparison finds nothing.
    expect(american.filter('d:>=05-06-2020', rows)).toEqual([]);
  });

  it('routes parseDate through the engine', () => {
    const engine = createEngine({
      parseDate: (value) =>
        typeof value === 'number' ? new Date(value * 1000) : null,
    });

    // Epoch SECONDS, reinterpreted by the hook.
    expect(
      engine.filter('at:>=2020-01-01', [{ at: 1_593_000_000 }]),
    ).toHaveLength(1);
  });

  it('supports matchKeys', () => {
    const rows = [{ colour: 'red' }, { size: 'large' }];

    expect(filter('colour', rows)).toEqual([]);
    expect(filter('colour', rows, { matchKeys: true })).toEqual([
      { colour: 'red' },
    ]);
  });
});

describe('test()', () => {
  it('answers for a single item', () => {
    expect(matches('status:active', ROWS[3])).toBe(true);
    expect(matches('status:active', ROWS[0])).toBe(false);
  });

  it('accepts a pre-parsed AST', () => {
    const engine = createEngine();
    const ast = engine.parse('member:true');

    expect(engine.test(ast, ROWS[0])).toBe(true);
    expect(engine.filter(ast, ROWS)).toHaveLength(2);
  });
});

describe('extensibility — a custom type with no core changes', () => {
  interface Semver {
    readonly parts: readonly [number, number, number];
  }

  const parseSemver = (text: string): Semver | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text);

    return match
      ? {
          parts: [Number(match[1]), Number(match[2]), Number(match[3])],
        }
      : null;
  };

  const semverType = defineValueType<Semver, Semver>({
    coerceValue: (value) => {
      if (typeof value !== 'string') {
        return MISS;
      }

      const parsed = parseSemver(value);

      return parsed === null ? MISS : resolved(parsed);
    },

    equals: (value, operand) =>
      value.parts.every((part, index) => part === operand.parts[index]),

    name: 'semver',

    ordering: {
      compare: (value, operand) => {
        for (const [index, part] of value.parts.entries()) {
          const other = operand.parts[index] ?? 0;

          if (part !== other) {
            return part - other;
          }
        }

        return 0;
      },
    },

    parseOperand: (operand) => {
      if (operand.kind !== 'text') {
        return DECLINED;
      }

      const parsed = parseSemver(operand.text);

      return parsed === null ? DECLINED : claimed(parsed);
    },
  });

  const releases = [
    { v: '1.2.3' },
    { v: '1.10.0' },
    { v: '0.9.9' },
    { v: '2.0.0' },
  ];

  it('orders correctly where a string comparison would not', () => {
    const engine = createEngine({ types: [semverType] });

    // Lexically "1.10.0" < "1.2.3"; semantically it is greater.
    expect(engine.filter('v:>=1.2.3', releases)).toEqual([
      { v: '1.2.3' },
      { v: '1.10.0' },
      { v: '2.0.0' },
    ]);
  });

  it('works in ranges through the same core code as every other type', () => {
    const engine = createEngine({ types: [semverType] });

    expect(engine.filter('v:[1.0.0 TO 1.99.99]', releases)).toEqual([
      { v: '1.2.3' },
      { v: '1.10.0' },
    ]);
  });

  it('outranks the built-ins by default, so it claims its own tokens', () => {
    const engine = createEngine({ types: [semverType] });

    expect(engine.types.types[0]?.name).toBe('semver');
    expect(engine.types.describe()[0]).toMatchObject({
      builtin: false,
      name: 'semver',
      ordered: true,
    });
  });

  it('is scoped to its engine and leaks into no other', () => {
    const withSemver = createEngine({ types: [semverType] });
    const plain = createEngine();

    expect(withSemver.types.get('semver')).toBeDefined();
    expect(plain.types.get('semver')).toBeUndefined();
  });

  it('reports a duplicate type name as a configuration error', () => {
    expect(() => createEngine({ types: [semverType, semverType] })).toThrow(
      SiftQLConfigError,
    );
  });

  it('lets a claiming type report a malformed operand loudly', () => {
    const strictSemver = defineValueType<Semver, Semver>({
      ...semverType,
      name: 'strict-semver',
      parseOperand: (operand) => {
        if (operand.kind !== 'text' || !operand.text.includes('.')) {
          return DECLINED;
        }

        const parsed = parseSemver(operand.text);

        return parsed === null
          ? malformedOperand(
              'not a valid semantic version',
              'use MAJOR.MINOR.PATCH',
            )
          : claimed(parsed);
      },
    });

    const engine = createEngine({ types: [strictSemver] });

    // Claimed and rejected -- so the user gets a real reason instead of
    // falling through to `string` and getting nothing.
    expect(() => engine.filter('v:>=1.2.3.4.5', releases)).toThrow(
      SiftQLOperandError,
    );
  });
});

describe('the built-in resolution order', () => {
  it('places string last, because it claims everything', () => {
    const engine = createEngine();
    const names = engine.types.describe().map((type) => type.name);

    expect(names.at(-1)).toBe('string');
  });

  it('reports which types are ordered', () => {
    const engine = createEngine();
    const ordered = Object.fromEntries(
      engine.types.describe().map((type) => [type.name, type.ordered]),
    );

    expect(ordered.number).toBe(true);
    expect(ordered.datetime).toBe(true);
    // The absence of ordering on `string` is what makes name:>="m" throw.
    expect(ordered.string).toBe(false);
    expect(ordered.boolean).toBe(false);
  });

  it('resolves a date before a number, but leaves plain numbers alone', () => {
    // date-shaped -> datetime; not date-shaped -> number.
    expect(ids('created:>=2020-01-01')).toEqual([1, 3, 4]);
    expect(ids('height:>1000')).toEqual([]);
  });
});
