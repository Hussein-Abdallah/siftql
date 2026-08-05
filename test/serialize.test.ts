import { describe, expect, it } from 'vitest';

import { parse } from '../src/parser/parser.js';
import { serialize } from '../src/serialize.js';
import type { Expression, SiftQLAst } from '../src/types.js';

/**
 * Strip `location` recursively. The round-trip law is stated over AST SHAPE:
 * serialize normalises whitespace and quote style, so character offsets legally
 * move even though nothing about the tree's meaning does.
 */
const stripLocations = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripLocations);
  }

  if (value !== null && typeof value === 'object') {
    const stripped: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(value)) {
      if (key !== 'location') {
        stripped[key] = stripLocations(nested);
      }
    }

    return stripped;
  }

  return value;
};

/** parse(serialize(parse(q))) deep-equals parse(q), ignoring location. */
const roundTrips = (query: string): void => {
  const once = parse(query);
  const text = serialize(once);
  const twice = parse(text);

  expect(
    stripLocations(twice),
    `round trip failed: ${query} -> ${text}`,
  ).toEqual(stripLocations(once));
};

/**
 * Every construct the grammar accepts. This corpus is the round-trip law's
 * actual test surface, so anything added to the grammar belongs here too.
 */
const CORPUS = [
  // terms
  '',
  'foo',
  '"foo"',
  '"foo bar"',
  '"in progress"',
  '123abc',
  'Ω',
  // fields
  'name:foo',
  '"full name":foo',
  'name.first:foo',
  '"name.first":foo',
  'first-name:foo',
  'a.b.c.d:foo',
  // typed values
  'member:true',
  'member:false',
  'member:null',
  'member:"true"',
  'height:100',
  'height:1.50',
  'height:007',
  'id:9007199254740993',
  // case sensitivity
  'status:active',
  'status::Active',
  'text:"*is just*"',
  'text::"*is just*"',
  'v::[a TO z]',
  // comparisons
  'h:=100',
  'h:>100',
  'h:>=100',
  'h:<100',
  'h:<=100',
  'h::>=100',
  // ranges
  'h:[1 TO 2]',
  'h:{1 TO 2}',
  'h:[1 TO 2}',
  'h:{1 TO 2]',
  'h:[1 TO *]',
  'h:["a b" TO "c d"]',
  'd:[2020-01-01 TO 2020-12-31]',
  'd:[2020-01-01T00:00:00Z TO 2020-12-31T23:59:59Z]',
  // wildcards
  'name:foo*bar',
  'name:*bar',
  'name:foo*',
  'name:*foo*',
  'name:foo?bar',
  'name:a*b?c',
  'name:"*is just*"',
  String.raw`name:foo\*bar`,
  String.raw`status:in\ progress`,
  // regex
  'name:/foo/',
  'name:/foo/i',
  'name:/foo/gi',
  String.raw`name:/a\/b/`,
  'name:/[/]/',
  // dates
  'date:2020-06-01',
  'date:>=2020-06-01',
  'date:>=2020-06-01T00:00:00Z',
  'date:<2020-06-01T12:00:00+02:00',
  'start:14:30',
  // logic
  'a AND b',
  'a OR b',
  'a b',
  'a AND b AND c',
  'a OR b OR c',
  'a OR b AND c',
  'a AND b OR c',
  'NOT a',
  '-a',
  'NOT a:b',
  '-a:b',
  'NOT a AND b',
  'a AND (b OR c)',
  '(a OR b) AND c',
  '((a))',
  'a AND (b OR (c AND d))',
  // field groups
  'status:(active OR pending)',
  'status:(a OR (b AND c))',
  'status:(NOT a)',
  // combinations
  'name:foo AND height:>=100 OR NOT status:(a OR b)',
  'date:[2020-01-01 TO *] AND text:"*is just*" AND -archived:true',
];

describe('round-trip law', () => {
  for (const query of CORPUS) {
    it(`round-trips ${JSON.stringify(query)}`, () => {
      roundTrips(query);
    });
  }

  it('is idempotent: serializing twice changes nothing', () => {
    for (const query of CORPUS) {
      const once = serialize(parse(query));
      const twice = serialize(parse(once));

      expect(twice).toBe(once);
    }
  });
});

describe('normalisation — the four things serialize is allowed to change', () => {
  it('collapses whitespace runs between tokens', () => {
    expect(serialize(parse('a    AND     b'))).toBe('a AND b');
    expect(serialize(parse('name:foo   height:1'))).toBe('name:foo height:1');
  });

  it('canonicalises quote style, since the two are synonyms', () => {
    expect(serialize(parse("name:'foo bar'"))).toBe('name:"foo bar"');
    expect(serialize(parse('name:"foo bar"'))).toBe('name:"foo bar"');
  });

  it('drops a redundant escape inside quotes', () => {
    // \a inside quotes just means a.
    expect(serialize(parse(String.raw`name:"a\b"`))).toBe('name:"ab"');
  });

  it('normalises the bracket on an unbounded range end', () => {
    // An unbounded boundary has no inclusivity, so these are deep-equal.
    expect(serialize(parse('h:{* TO 2]'))).toBe('h:[* TO 2]');
    expect(serialize(parse('h:[1 TO *}'))).toBe('h:[1 TO *]');
  });

  it('changes nothing else', () => {
    expect(serialize(parse('name:foo AND height:>=100'))).toBe(
      'name:foo AND height:>=100',
    );
    expect(serialize(parse('status::Active'))).toBe('status::Active');
    expect(serialize(parse('a b'))).toBe('a b');
  });
});

describe('escaping', () => {
  it('escapes reserved characters in a bare term', () => {
    const node = parse('foo');
    const withSpace: SiftQLAst = {
      ...(node as Extract<Expression, { type: 'LiteralExpression' }>),
      value: 'in progress',
    } as SiftQLAst;

    expect(serialize(withSpace)).toBe(String.raw`in\ progress`);
  });

  it('escapes a leading negation marker only in first position', () => {
    // A leading `-` is structural; interior hyphens are not, which is what
    // keeps bare dates bare.
    expect(serialize(parse(String.raw`\-foo`))).toBe(String.raw`\-foo`);
    expect(serialize(parse('2020-06-01'))).toBe('2020-06-01');
    expect(serialize(parse('first-name:x'))).toBe('first-name:x');
  });

  it('escapes wildcard metacharacters that are meant literally', () => {
    expect(serialize(parse(String.raw`name:foo\*bar`))).toBe(
      String.raw`name:foo\*bar`,
    );
    expect(serialize(parse(String.raw`name:"foo\*bar"`))).toBe(
      String.raw`name:"foo\*bar"`,
    );
  });

  it('escapes a dot inside an unquoted field segment', () => {
    // Otherwise a key that literally contains a dot returns as a nested path.
    const query = String.raw`a\.b:x`;
    const node = parse(query);

    expect(
      node.type === 'Tag' && node.field.segments.map((s) => s.name),
    ).toEqual(['a.b']);
    roundTrips(query);
  });

  it('keeps a regex pattern byte-exact', () => {
    // RegExp#source is lossy, so the pattern is never round-tripped through one.
    expect(serialize(parse(String.raw`name:/a\/b\\c/`))).toBe(
      String.raw`name:/a\/b\\c/`,
    );
  });
});

describe('parentheses', () => {
  it('preserves explicit groups', () => {
    expect(serialize(parse('a AND (b OR c)'))).toBe('a AND (b OR c)');
    expect(serialize(parse('((a))'))).toBe('((a))');
  });

  it('adds brackets a hand-built AST needs to keep its shape', () => {
    // No ParenthesizedExpression node anywhere: (a OR b) AND c built directly.
    const or = parse('a OR b');
    const c = parse('c');
    const built: SiftQLAst = {
      left: or as Expression,
      location: { end: 0, start: 0 },
      operator: {
        location: { end: 0, start: 0 },
        notation: 'explicit',
        operator: 'AND',
        type: 'BooleanOperator',
      },
      right: c as Expression,
      type: 'LogicalExpression',
    };

    // Without brackets this would print `a OR b AND c` and re-parse as
    // a OR (b AND c) -- a different tree.
    expect(serialize(built)).toBe('(a OR b) AND c');
  });

  it('brackets an equal-precedence right operand, since operators are left-associative', () => {
    const left = parse('a');
    const right = parse('b OR c');
    const built: SiftQLAst = {
      left: left as Expression,
      location: { end: 0, start: 0 },
      operator: {
        location: { end: 0, start: 0 },
        notation: 'explicit',
        operator: 'OR',
        type: 'BooleanOperator',
      },
      right: right as Expression,
      type: 'LogicalExpression',
    };

    expect(serialize(built)).toBe('a OR (b OR c)');
  });

  it('brackets a low-precedence operand under NOT', () => {
    const built: SiftQLAst = {
      location: { end: 0, start: 0 },
      operand: parse('a AND b') as Expression,
      operator: 'NOT',
      type: 'UnaryOperator',
    };

    expect(serialize(built)).toBe('NOT (a AND b)');
  });

  it('does not bracket what does not need it', () => {
    expect(serialize(parse('a AND b AND c'))).toBe('a AND b AND c');
    expect(serialize(parse('NOT a'))).toBe('NOT a');
    expect(serialize(parse('-a'))).toBe('-a');
  });
});

describe('tolerant ASTs', () => {
  it('serializes a hole to nothing, yielding the incomplete text', () => {
    expect(serialize(parse('name:', { tolerant: true }))).toBe('name:');
    expect(serialize(parse('a AND', { tolerant: true }))).toBe('a AND ');
  });
});

describe('position-aware escaping', () => {
  it('leaves colons alone in value position', () => {
    // This is the whole reason value mode exists in the tokenizer: after a
    // comparison operator a colon is an ordinary character, so escaping it
    // would assert something about the grammar that is false there.
    expect(serialize(parse('createdAt:>=2020-06-01T12:00:00+02:00'))).toBe(
      'createdAt:>=2020-06-01T12:00:00+02:00',
    );
    expect(serialize(parse('start:14:30'))).toBe('start:14:30');
    expect(
      serialize(parse('d:[2020-01-01T00:00:00Z TO 2020-12-31T23:59:59Z]')),
    ).toBe('d:[2020-01-01T00:00:00Z TO 2020-12-31T23:59:59Z]');
  });

  it('escapes a colon in TERM position, where it would start a field', () => {
    const tagged = parse('a:b');
    const bare = parse('"a:b"');

    // The quoted form holds the colon without ceremony...
    expect(serialize(bare)).toBe('"a:b"');
    // ...while the tagged form is genuinely a field and a value.
    expect(tagged.type).toBe('Tag');
  });

  it('round-trips an unfielded term containing a colon', () => {
    roundTrips('"12:00"');
    roundTrips('"a:b"');
  });

  it('still escapes what is structural in value position', () => {
    expect(serialize(parse(String.raw`status:in\ progress`))).toBe(
      String.raw`status:in\ progress`,
    );
    expect(serialize(parse(String.raw`name:foo\*bar`))).toBe(
      String.raw`name:foo\*bar`,
    );
  });
});
