import { describe, expect, it } from 'vitest';

import {
  isSiftQLError,
  SiftQLConfigError,
  SiftQLError,
  SiftQLOperandError,
  SiftQLRecoveredQueryError,
  SiftQLSyntaxError,
  SiftQLValueError,
  signalValueFailure,
} from '../src/errors.js';
import {
  BUILTIN_TYPE_ORDER,
  claimed,
  DECLINED,
  defineValueType,
  dispositionFor,
  malformedOperand,
  malformedValue,
  MISS,
  resolved,
  VALUE_FAILURE_POLICY,
} from '../src/registry.js';
import {
  fieldName,
  fieldPath,
  isSafeUnquotedExpression,
  OPERATOR_PRECEDENCE,
  rangeBracket,
  RECOVERY_REASONS,
  RESERVED_CHARACTERS,
  RESERVED_WORDS,
  SYNTHETIC_LOCATION,
  type Field,
  type RangeBoundary,
  type SourceLocation,
} from '../src/types.js';

const at = (start: number, end: number): SourceLocation => ({ end, start });

const segment = (name: string, quote: '"' | "'" | null = null) =>
  ({ location: at(0, 0), name, quote, type: 'FieldSegment' }) as const;

describe('isSafeUnquotedExpression', () => {
  it('accepts ordinary terms and bare dates', () => {
    expect(isSafeUnquotedExpression('foo')).toBe(true);
    expect(isSafeUnquotedExpression('foo123')).toBe(true);
    expect(isSafeUnquotedExpression('123abc')).toBe(true);
    // Only a LEADING hyphen is structural, which is what keeps bare dates bare.
    expect(isSafeUnquotedExpression('2020-06-01')).toBe(true);
    expect(isSafeUnquotedExpression('first-name')).toBe(true);
    expect(isSafeUnquotedExpression('Ω')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isSafeUnquotedExpression('')).toBe(false);
  });

  it('rejects grammar keywords', () => {
    for (const word of RESERVED_WORDS) {
      expect(isSafeUnquotedExpression(word)).toBe(false);
    }
    // Lowercase is an ordinary term, not a keyword.
    expect(isSafeUnquotedExpression('and')).toBe(true);
  });

  it('rejects a leading negation or required marker', () => {
    expect(isSafeUnquotedExpression('-foo')).toBe(false);
    expect(isSafeUnquotedExpression('+foo')).toBe(false);
  });

  it('rejects every reserved character', () => {
    for (const character of RESERVED_CHARACTERS) {
      expect(isSafeUnquotedExpression(`a${character}b`)).toBe(false);
    }
  });

  it('treats wildcard metacharacters as unsafe when bare', () => {
    expect(isSafeUnquotedExpression('foo*')).toBe(false);
    expect(isSafeUnquotedExpression('foo?')).toBe(false);
  });
});

describe('field path helpers', () => {
  it('reads a nested path from segments', () => {
    const field: Field = {
      location: at(0, 10),
      segments: [segment('name'), segment('first')],
      type: 'Field',
    };

    expect(fieldPath(field)).toEqual(['name', 'first']);
    expect(fieldName(field)).toBe('name.first');
  });

  it('keeps a quoted segment containing a dot as one step', () => {
    const field: Field = {
      location: at(0, 5),
      segments: [segment('a.b', "'")],
      type: 'Field',
    };

    // One traversal step, not two -- this addresses a literal key "a.b".
    expect(fieldPath(field)).toEqual(['a.b']);
    // fieldName is documented as lossy: it renders the same as a nested a.b.
    expect(fieldName(field)).toBe('a.b');
  });

  it('handles a single-segment field', () => {
    const field: Field = {
      location: at(0, 4),
      segments: [segment('name')],
      type: 'Field',
    };

    expect(fieldPath(field)).toEqual(['name']);
    expect(fieldName(field)).toBe('name');
  });
});

describe('rangeBracket', () => {
  const bounded = (inclusive: boolean): RangeBoundary => ({
    bounded: true,
    inclusive,
    location: at(0, 1),
    type: 'RangeBoundary',
    value: {
      literal: 'text',
      location: at(0, 1),
      quote: null,
      quoted: false,
      type: 'LiteralExpression',
      value: '1',
    },
  });

  const unbounded: RangeBoundary = {
    bounded: false,
    location: at(0, 1),
    type: 'RangeBoundary',
  };

  it('prints inclusive boundaries with square brackets', () => {
    expect(rangeBracket('lower', bounded(true))).toBe('[');
    expect(rangeBracket('upper', bounded(true))).toBe(']');
  });

  it('prints exclusive boundaries with braces', () => {
    expect(rangeBracket('lower', bounded(false))).toBe('{');
    expect(rangeBracket('upper', bounded(false))).toBe('}');
  });

  it('prints an unbounded end with a square bracket, since exclusivity is meaningless there', () => {
    expect(rangeBracket('lower', unbounded)).toBe('[');
    expect(rangeBracket('upper', unbounded)).toBe(']');
  });
});

describe('operator precedence', () => {
  it('binds AND tighter than OR', () => {
    const and = OPERATOR_PRECEDENCE.AND;
    const or = OPERATOR_PRECEDENCE.OR;

    expect(and).toBeDefined();
    expect(or).toBeDefined();
    expect(and ?? 0).toBeGreaterThan(or ?? 0);
  });

  it('leaves gaps so a level can be inserted without renumbering', () => {
    const levels = Object.values(OPERATOR_PRECEDENCE).sort((a, b) => a - b);

    for (const [index, level] of levels.entries()) {
      const next = levels[index + 1];

      if (next !== undefined && next !== level) {
        expect(next - level).toBeGreaterThan(1);
      }
    }
  });
});

describe('constants', () => {
  it('exposes a frozen zero-width synthetic location', () => {
    expect(SYNTHETIC_LOCATION).toEqual({ end: 0, start: 0 });
    expect(Object.isFrozen(SYNTHETIC_LOCATION)).toBe(true);
  });

  it('enumerates the recovery reasons the parser emits', () => {
    expect(Object.values(RECOVERY_REASONS)).toContain('unterminated-quote');
    expect(Object.isFrozen(RECOVERY_REASONS)).toBe(true);
  });

  it('resolves built-in types most-specific first, with string last', () => {
    // string claims every operand, so anything after it would be unreachable.
    expect(BUILTIN_TYPE_ORDER.at(-1)).toBe('string');
    expect(BUILTIN_TYPE_ORDER).toContain('datetime');
    expect(new Set(BUILTIN_TYPE_ORDER).size).toBe(BUILTIN_TYPE_ORDER.length);
  });
});

describe('result constructors', () => {
  it('builds operand outcomes', () => {
    expect(claimed(42)).toEqual({ ok: true, operand: 42 });
    expect(DECLINED).toEqual({ kind: 'declined', ok: false });
    expect(malformedOperand('bad', 'try a date')).toEqual({
      hint: 'try a date',
      kind: 'invalid',
      ok: false,
      reason: 'bad',
    });
  });

  it('builds value outcomes', () => {
    expect(resolved('x')).toEqual({ ok: true, value: 'x' });
    expect(MISS).toEqual({ kind: 'miss', ok: false });
    expect(malformedValue('nope')).toEqual({
      kind: 'invalid',
      ok: false,
      reason: 'nope',
    });
  });

  it('freezes the singletons so a caller cannot corrupt them', () => {
    expect(Object.isFrozen(DECLINED)).toBe(true);
    expect(Object.isFrozen(MISS)).toBe(true);
  });
});

describe('value failure policy', () => {
  it('never errors on a bare-keyword sweep', () => {
    // A bare keyword scans every field; a field it cannot read is simply not a
    // match, never an error, or one dirty column would break every free search.
    expect(dispositionFor('scan', 'miss')).toBe('no-match');
    expect(dispositionFor('scan', 'invalid')).toBe('no-match');
    expect(dispositionFor('scan', 'incomparable')).toBe('no-match');
  });

  it('treats an unreadable value as an error under ordered comparison', () => {
    // createdAt:>=2020-01-01 asserts the field is temporal, so a value that is
    // not is dirty data -- exactly what onValueError governs.
    expect(dispositionFor('ordered', 'miss')).toBe('value-error');
    expect(dispositionFor('range', 'invalid')).toBe('value-error');
  });

  it('covers every site and failure kind', () => {
    for (const site of Object.keys(VALUE_FAILURE_POLICY)) {
      for (const kind of ['miss', 'invalid', 'incomparable'] as const) {
        expect(['no-match', 'value-error']).toContain(
          dispositionFor(site as keyof typeof VALUE_FAILURE_POLICY, kind),
        );
      }
    }
  });
});

describe('signalValueFailure', () => {
  const failure = {
    kind: 'invalid',
    location: at(0, 5),
    path: ['createdAt'],
    reason: 'not a date',
    site: 'ordered',
    typeName: 'datetime',
    value: 'n/a',
  } as const;

  it('returns false rather than throwing when the policy says skip', () => {
    expect(signalValueFailure({ ...failure, onValueError: 'skip' })).toBe(
      false,
    );
  });

  it('throws when the policy says error and the caller asked to throw', () => {
    expect(() =>
      signalValueFailure({ ...failure, onValueError: 'throw' }),
    ).toThrow(SiftQLValueError);
  });

  it('still returns false on a scan even when throwing is requested', () => {
    // One dirty row must not be able to destroy an entire free-text search.
    expect(
      signalValueFailure({
        ...failure,
        onValueError: 'throw',
        site: 'scan',
      }),
    ).toBe(false);
  });

  it('names the type and the reason in the message', () => {
    try {
      signalValueFailure({ ...failure, onValueError: 'throw' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('datetime');
      expect((error as Error).message).toContain('not a date');
    }
  });
});

describe('error hierarchy', () => {
  it('roots every error at SiftQLError', () => {
    const errors = [
      new SiftQLError('base'),
      new SiftQLSyntaxError('bad', at(0, 1), 'x'),
      new SiftQLConfigError('bad config'),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(SiftQLError);
      expect(error).toBeInstanceOf(Error);
      expect(isSiftQLError(error)).toBe(true);
    }
  });

  it('does not claim foreign errors', () => {
    expect(isSiftQLError(new TypeError('nope'))).toBe(false);
    expect(isSiftQLError('not an error')).toBe(false);
    expect(isSiftQLError(null)).toBe(false);
  });

  it('carries a machine-readable code', () => {
    expect(new SiftQLSyntaxError('bad', at(0, 1), 'x').code).toBe('SYNTAX');
    expect(new SiftQLConfigError('bad').code).toBe('CONFIG');
  });

  it('reports location, source, and a caret excerpt on syntax errors', () => {
    const error = new SiftQLSyntaxError('Unexpected', at(5, 6), 'name:"bar');

    expect(error.location).toEqual({ end: 6, start: 5 });
    expect(error.source).toBe('name:"bar');
    expect(error.message).toContain('name:"bar');
    expect(error.message).toContain('^');
    expect(error.expected).toEqual([]);
  });

  it('records what the parser expected when given', () => {
    const error = new SiftQLSyntaxError('Unexpected', at(0, 1), 'x', {
      expected: ['a value', 'a range'],
    });

    expect(error.expected).toEqual(['a value', 'a range']);
  });

  it('is never a plain SyntaxError, so it cannot be caught by accident', () => {
    const error = new SiftQLSyntaxError('bad', at(0, 1), 'x');

    expect(error.name).toBe('SiftQLSyntaxError');
    expect(Object.getPrototypeOf(error).constructor.name).toBe(
      'SiftQLSyntaxError',
    );
  });
});

describe('operand errors', () => {
  const field: Field = {
    location: at(0, 6),
    segments: [segment('height')],
    type: 'Field',
  };

  it('records what was tried, so the message can say why nothing claimed it', () => {
    const error = new SiftQLOperandError('No type claimed "m"', {
      candidates: ['datetime', 'number', 'string'],
      location: at(9, 12),
      raw: 'm',
      site: { field, kind: 'ordered', operator: ':>=' },
    });

    expect(error.code).toBe('OPERAND');
    expect(error.raw).toBe('m');
    expect(error.candidates).toEqual(['datetime', 'number', 'string']);
    expect(error.site.kind).toBe('ordered');
    expect(error.reason).toBeNull();
    expect(error.hint).toBeNull();
    expect(isSiftQLError(error)).toBe(true);
  });

  it('carries a narrower code when the failure is more specific', () => {
    const unordered = new SiftQLOperandError('string has no ordering', {
      code: 'UNORDERED_TYPE',
      hint: 'give the type an `ordering`',
      location: at(0, 3),
      raw: 'foo',
      reason: 'no ordering',
      site: { field, kind: 'ordered', operator: ':>' },
    });

    expect(unordered.code).toBe('UNORDERED_TYPE');
    expect(unordered.reason).toBe('no ordering');
    expect(unordered.hint).toBe('give the type an `ordering`');

    const mixed = new SiftQLOperandError('boundaries disagree', {
      code: 'MIXED_RANGE_TYPES',
      location: at(0, 3),
      raw: '2020-01-01',
      site: { field, inclusive: true, kind: 'range', side: 'upper' },
    });

    expect(mixed.code).toBe('MIXED_RANGE_TYPES');
  });
});

describe('value errors', () => {
  it('points at the query clause and names the offending datum', () => {
    const error = new SiftQLValueError('bad row', {
      kind: 'invalid',
      location: at(0, 20),
      path: ['createdAt'],
      reason: 'not a date',
      typeName: 'datetime',
      value: 'n/a',
    });

    expect(error.code).toBe('VALUE');
    expect(error.typeName).toBe('datetime');
    expect(error.path).toEqual(['createdAt']);
    expect(error.value).toBe('n/a');
    expect(error.kind).toBe('invalid');
    expect(error.reason).toBe('not a date');
  });

  it('defaults an absent reason to null rather than undefined', () => {
    const error = new SiftQLValueError('bad row', {
      kind: 'miss',
      location: at(0, 1),
      path: ['a', 0],
      typeName: 'number',
      value: {},
    });

    expect(error.reason).toBeNull();
    expect(error.path).toEqual(['a', 0]);
  });
});

describe('recovered query errors', () => {
  it('reports where the incomplete clause was and why', () => {
    const error = new SiftQLRecoveredQueryError('query is incomplete', {
      location: at(5, 5),
      reason: RECOVERY_REASONS.missingValue,
    });

    expect(error.code).toBe('RECOVERED');
    expect(error.reason).toBe('missing-value');
    expect(error.location).toEqual({ end: 5, start: 5 });
  });
});

describe('describeValueFailure wording', () => {
  const base = {
    location: at(0, 5),
    onValueError: 'throw',
    path: ['when'],
    reason: null,
    typeName: 'datetime',
    value: '14:30',
  } as const;

  it('explains an incomparable value in terms of ordering', () => {
    try {
      signalValueFailure({ ...base, kind: 'incomparable', site: 'ordered' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('ordering');
    }
  });

  it('explains a domain miss differently from an incomparable one', () => {
    try {
      signalValueFailure({ ...base, kind: 'miss', site: 'range' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('domain');
    }
  });
});

describe('defineValueType', () => {
  it('returns the spec unchanged while preserving inference', () => {
    const spec = {
      coerceValue: () => MISS,
      equals: (a: number, b: number) => a === b,
      name: 'demo',
      parseOperand: () => DECLINED,
    };

    expect(defineValueType(spec)).toBe(spec);
  });
});
