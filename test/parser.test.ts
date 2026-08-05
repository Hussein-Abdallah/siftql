import { describe, expect, it } from 'vitest';

import { SiftQLSyntaxError } from '../src/errors.js';
import { parse, type ParseOptions } from '../src/parser/parser.js';
import type { AstNode, SiftQLAst } from '../src/types.js';

/**
 * Compact s-expression rendering, so a test asserts the SHAPE of a tree in one
 * readable line instead of a page of object literals. Structural details that
 * this elides (locations, quoting flags) get their own dedicated tests below.
 */
const show = (node: AstNode | SiftQLAst): string => {
  switch (node.type) {
    case 'EmptyExpression':
      return '<empty>';
    case 'LiteralExpression':
      return node.literal === 'text'
        ? node.quoted
          ? `"${node.value}"`
          : node.value
        : String(node.value);
    case 'LogicalExpression':
      return `(${node.operator.operator}${
        node.operator.notation === 'implicit' ? '*' : ''
      } ${show(node.left)} ${show(node.right)})`;
    case 'MissingExpression':
      return `<missing:${node.recovered?.reason ?? '?'}>`;
    case 'ParenthesizedExpression':
      return `[${show(node.expression)}]`;
    case 'RangeExpression': {
      const bound = (side: typeof node.lower): string =>
        side.bounded ? show(side.value) : '*';
      const open = node.lower.bounded && !node.lower.inclusive ? '{' : '[';
      const close = node.upper.bounded && !node.upper.inclusive ? '}' : ']';

      return `${open}${bound(node.lower)} TO ${bound(node.upper)}${close}`;
    }
    case 'RegexExpression':
      return `/${node.pattern}/${node.flags.join('')}`;
    case 'Tag': {
      const field = node.field.segments.map((s) => s.name).join('.');
      const colon = node.caseSensitive ? '::' : ':';
      const operator =
        node.operator.operator === ':' ? '' : node.operator.operator.slice(1);

      return `${field}${colon}${operator}${show(node.expression)}`;
    }
    case 'UnaryOperator':
      return `(${node.operator} ${show(node.operand)})`;
    case 'WildcardExpression':
      return `${node.quoted ? 'q' : ''}{${node.pattern
        .map((segment) =>
          segment.type === 'WildcardAny'
            ? '*'
            : segment.type === 'WildcardSingle'
              ? '?'
              : segment.value,
        )
        .join('')}}`;
    default:
      return node.type;
  }
};

const ast = (query: string, options: ParseOptions = {}): string =>
  show(parse(query, options));

describe('terms', () => {
  it('parses the empty query as its own node', () => {
    expect(ast('')).toBe('<empty>');
    expect(ast('   ')).toBe('<empty>');
  });

  it('parses a bare term as a naked literal, never a tag', () => {
    const node = parse('foo');

    expect(node.type).toBe('LiteralExpression');
    expect(ast('foo')).toBe('foo');
  });

  it('records quoting without recording which quote was used', () => {
    // The two quote characters are exact synonyms.
    expect(parse("'foo'")).toEqual(parse('"foo"'));
    expect(ast('"foo bar"')).toBe('"foo bar"');
  });
});

describe('fields', () => {
  it('parses a field match', () => {
    expect(ast('name:foo')).toBe('name:foo');
  });

  it('splits a dotted path into segments', () => {
    const node = parse('name.first:foo');

    expect(
      node.type === 'Tag' && node.field.segments.map((s) => s.name),
    ).toEqual(['name', 'first']);
  });

  it('never splits a quoted field name', () => {
    const node = parse("'name.first':foo");

    expect(
      node.type === 'Tag' && node.field.segments.map((s) => s.name),
    ).toEqual(['name.first']);
    expect(node.type === 'Tag' && node.field.segments[0].quoted).toBe(true);
  });
});

describe('typed values', () => {
  it('gives node identity to the bare keywords', () => {
    expect(ast('member:true')).toBe('member:true');
    expect(ast('member:false')).toBe('member:false');
    expect(ast('member:null')).toBe('member:null');
  });

  it('treats a quoted keyword as an ordinary string', () => {
    const node = parse('member:"true"');

    expect(
      node.type === 'Tag' &&
        node.expression.type === 'LiteralExpression' &&
        node.expression.literal,
    ).toBe('text');
  });

  it('keeps numbers lexical', () => {
    const node = parse('height:100');

    expect(
      node.type === 'Tag' &&
        node.expression.type === 'LiteralExpression' &&
        node.expression.value,
    ).toBe('100');
  });
});

describe('case sensitivity', () => {
  it('defaults to insensitive and flips on the doubled colon', () => {
    expect(parse('status:active')).toMatchObject({ caseSensitive: false });
    expect(parse('status::Active')).toMatchObject({ caseSensitive: true });
  });

  it('is unaffected by quoting', () => {
    expect(parse('status:"in progress"')).toMatchObject({
      caseSensitive: false,
    });
  });

  it('scopes a whole range rather than a boundary', () => {
    const node = parse('v::[a TO z]');

    expect(node).toMatchObject({ caseSensitive: true });
    expect(ast('v::[a TO z]')).toBe('v::[a TO z]');
  });
});

describe('comparison operators', () => {
  it('parses each relational form', () => {
    expect(ast('h:=100')).toBe('h:=100');
    expect(ast('h:>100')).toBe('h:>100');
    expect(ast('h:>=100')).toBe('h:>=100');
    expect(ast('h:<100')).toBe('h:<100');
    expect(ast('h:<=100')).toBe('h:<=100');
  });

  it('discriminates match from relational at the top level', () => {
    expect(parse('h:1')).toMatchObject({ kind: 'match' });
    expect(parse('h:>1')).toMatchObject({ kind: 'relational' });
  });

  it('refuses operands that have no ordering', () => {
    // These are unconstructible in the AST, so they are refused at parse time.
    expect(() => parse('h:>[1 TO 2]')).toThrow(SiftQLSyntaxError);
    expect(() => parse('h:>true')).toThrow(SiftQLSyntaxError);
    expect(() => parse('h:>null')).toThrow(SiftQLSyntaxError);
    expect(() => parse('h:>/re/')).toThrow(SiftQLSyntaxError);
    expect(() => parse('h:>foo*bar')).toThrow(SiftQLSyntaxError);
  });
});

describe('ranges', () => {
  it('parses every inclusivity combination', () => {
    expect(ast('h:[1 TO 2]')).toBe('h:[1 TO 2]');
    expect(ast('h:{1 TO 2}')).toBe('h:{1 TO 2}');
    expect(ast('h:[1 TO 2}')).toBe('h:[1 TO 2}');
    expect(ast('h:{1 TO 2]')).toBe('h:{1 TO 2]');
  });

  it('records inclusivity per boundary', () => {
    const node = parse('h:[1 TO 2}');

    expect(
      node.type === 'Tag' && node.expression.type === 'RangeExpression'
        ? [node.expression.lower, node.expression.upper]
        : [],
    ).toMatchObject([{ inclusive: true }, { inclusive: false }]);
  });

  it('parses half-open bounds', () => {
    expect(ast('h:[* TO 2]')).toBe('h:[* TO 2]');
    expect(ast('h:[1 TO *]')).toBe('h:[1 TO *]');
    expect(ast('h:[* TO *]')).toBe('h:[* TO *]');
  });

  it('gives an unbounded end no inclusivity at all', () => {
    const node = parse('h:[* TO 2]');
    const lower =
      node.type === 'Tag' && node.expression.type === 'RangeExpression'
        ? node.expression.lower
        : null;

    expect(lower).toMatchObject({ bounded: false });
    expect(lower && 'inclusive' in lower).toBe(false);
  });

  it('treats an ESCAPED asterisk as a value, not as unbounded', () => {
    // Bare `*` is the unbounded marker; `\*` is a literal asterisk. A quoted
    // `"*"` is neither -- wildcards are live inside quotes, so it is a pattern,
    // and a pattern has no meaning as a range endpoint (asserted below).
    const node = parse(String.raw`h:[\* TO 2]`);
    const lower =
      node.type === 'Tag' && node.expression.type === 'RangeExpression'
        ? node.expression.lower
        : null;

    expect(lower).toMatchObject({ bounded: true });
  });

  it('accepts unquoted dates as boundaries', () => {
    expect(ast('d:[2020-01-01 TO 2020-12-31]')).toBe(
      'd:[2020-01-01 TO 2020-12-31]',
    );
  });

  it('refuses a wildcard boundary in either spelling', () => {
    expect(() => parse('h:[a*b TO z]')).toThrow(SiftQLSyntaxError);
    expect(() => parse('h:["*" TO 2]')).toThrow(SiftQLSyntaxError);
  });

  it('requires TO', () => {
    expect(() => parse('h:[1 2]')).toThrow(SiftQLSyntaxError);
  });
});

describe('wildcards', () => {
  it('segments a pattern, merging adjacent literals', () => {
    expect(ast('name:foo*bar')).toBe('name:{foo*bar}');
    expect(ast('name:*bar')).toBe('name:{*bar}');
    expect(ast('name:foo*')).toBe('name:{foo*}');
    expect(ast('name:foo?bar')).toBe('name:{foo?bar}');
    expect(ast('name:*foo*')).toBe('name:{*foo*}');
  });

  it('produces one segment per metacharacter', () => {
    const node = parse('name:a*b?c');
    const pattern =
      node.type === 'Tag' && node.expression.type === 'WildcardExpression'
        ? node.expression.pattern.map((s) => s.type)
        : [];

    expect(pattern).toEqual([
      'WildcardLiteral',
      'WildcardAny',
      'WildcardLiteral',
      'WildcardSingle',
      'WildcardLiteral',
    ]);
  });

  it('treats an escaped metacharacter as a literal, not a wildcard', () => {
    const node = parse(String.raw`name:foo\*bar`);

    expect(node.type === 'Tag' && node.expression.type).toBe(
      'LiteralExpression',
    );
    // The backslash is gone and the asterisk is ordinary text.
    expect(ast(String.raw`name:foo\*bar`)).toBe('name:foo*bar');
  });

  it('keeps wildcards live inside quotes', () => {
    // This is what makes case-insensitive multi-word containment writable.
    expect(ast('text:"*is just*"')).toBe('text:q{*is just*}');
  });

  it('resolves an escaped space in a bare term', () => {
    expect(ast(String.raw`status:in\ progress`)).toBe('status:in progress');
  });

  it('gives every segment a location inside the source', () => {
    const source = 'name:ab*cd';
    const node = parse(source);
    const pattern =
      node.type === 'Tag' && node.expression.type === 'WildcardExpression'
        ? node.expression.pattern
        : [];

    expect(
      pattern.map((s) => source.slice(s.location.start, s.location.end)),
    ).toEqual(['ab', '*', 'cd']);
  });
});

describe('regular expressions', () => {
  it('preserves the pattern exactly', () => {
    expect(ast(String.raw`name:/a\/b/`)).toBe(String.raw`name:/a\/b/`);
  });

  it('records flags in order', () => {
    const node = parse('name:/foo/gi');

    expect(
      node.type === 'Tag' && node.expression.type === 'RegexExpression'
        ? node.expression.flags
        : [],
    ).toEqual(['g', 'i']);
  });

  it('rejects unknown and duplicated flags', () => {
    expect(() => parse('name:/foo/Q')).toThrow(SiftQLSyntaxError);
    expect(() => parse('name:/foo/ii')).toThrow(SiftQLSyntaxError);
  });
});

describe('boolean structure and precedence', () => {
  it('binds AND tighter than OR', () => {
    expect(ast('a OR b AND c')).toBe('(OR a (AND b c))');
    expect(ast('a AND b OR c')).toBe('(OR (AND a b) c)');
  });

  it('is left-associative', () => {
    expect(ast('a OR b OR c')).toBe('(OR (OR a b) c)');
    expect(ast('a AND b AND c')).toBe('(AND (AND a b) c)');
  });

  it('marks juxtaposition as implicit AND at the same precedence', () => {
    expect(ast('a b')).toBe('(AND* a b)');
    expect(ast('a b OR c')).toBe('(OR (AND* a b) c)');
  });

  it('gives an implicit operator a zero-width location', () => {
    const node = parse('a b');
    const operator = node.type === 'LogicalExpression' ? node.operator : null;

    expect(operator?.notation).toBe('implicit');
    expect(operator?.location.start).toBe(operator?.location.end);
  });

  it('parses both negation spellings into one node type', () => {
    expect(ast('NOT a')).toBe('(NOT a)');
    expect(ast('-a')).toBe('(- a)');
    expect(ast('NOT a:b')).toBe('(NOT a:b)');
    expect(ast('-a:b')).toBe('(- a:b)');
  });

  it('binds negation tighter than conjunction', () => {
    expect(ast('NOT a AND b')).toBe('(AND (NOT a) b)');
  });

  it('retains parentheses as nodes', () => {
    expect(ast('a AND (b OR c)')).toBe('(AND a [(OR b c)])');
    expect(ast('((a))')).toBe('[[a]]');
  });
});

describe('field groups', () => {
  it('keeps a group instead of desugaring it', () => {
    // Desugaring to (status:active OR status:pending) would fabricate
    // locations that point at text the user never wrote.
    expect(ast('status:(active OR pending)')).toBe(
      'status:[(OR active pending)]',
    );
  });

  it('nests', () => {
    expect(ast('status:(a OR (b AND c))')).toBe('status:[(OR a [(AND b c)])]');
  });

  it('refuses a nested field, which the AST cannot represent', () => {
    expect(() => parse('status:(a OR b:c)')).toThrow(SiftQLSyntaxError);
  });
});

describe('locations', () => {
  it('spans each node back onto the source text', () => {
    const source = 'name:foo AND height:>=100';
    const node = parse(source);

    expect(source.slice(node.location.start, node.location.end)).toBe(source);

    if (node.type === 'LogicalExpression') {
      expect(
        source.slice(node.left.location.start, node.left.location.end),
      ).toBe('name:foo');
      expect(
        source.slice(node.right.location.start, node.right.location.end),
      ).toBe('height:>=100');
    }
  });
});

describe('syntax errors', () => {
  it('reports a missing value', () => {
    expect(() => parse('name:')).toThrow(SiftQLSyntaxError);
  });

  it('reports a dangling operator', () => {
    expect(() => parse('a AND')).toThrow(SiftQLSyntaxError);
    expect(() => parse('a OR')).toThrow(SiftQLSyntaxError);
    expect(() => parse('NOT')).toThrow(SiftQLSyntaxError);
  });

  it('reports an unclosed group', () => {
    expect(() => parse('(a')).toThrow(SiftQLSyntaxError);
    expect(() => parse('a AND (b OR c')).toThrow(SiftQLSyntaxError);
  });

  it('reports trailing junk', () => {
    expect(() => parse('a )')).toThrow(SiftQLSyntaxError);
  });

  it('refuses the reserved required marker rather than ignoring it', () => {
    // Silently dropping `+` would make `+a b` and `a b` the same query.
    try {
      parse('+a');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as SiftQLSyntaxError).code).toBe('UNSUPPORTED_SYNTAX');
    }
  });

  it('carries a location and an expectation set', () => {
    try {
      parse('name:');
      expect.unreachable('should have thrown');
    } catch (error) {
      const syntaxError = error as SiftQLSyntaxError;

      expect(syntaxError.location.start).toBeGreaterThanOrEqual(0);
      expect(syntaxError.expected.length).toBeGreaterThan(0);
      expect(syntaxError.message).toContain('^');
    }
  });
});

describe('tolerant mode', () => {
  it('represents a missing value as a hole', () => {
    expect(ast('name:', { tolerant: true })).toBe(
      'name:<missing:missing-value>',
    );
  });

  it('represents a missing operand as a hole', () => {
    expect(ast('a AND', { tolerant: true })).toBe(
      '(AND a <missing:missing-operand>)',
    );
  });

  it('closes an unclosed group', () => {
    expect(ast('(a', { tolerant: true })).toBe('[a]');
  });

  it('closes an unclosed quote', () => {
    expect(ast('name:"bar', { tolerant: true })).toBe('name:"bar"');
  });

  it('stamps every recovered node so a UI can grey it out', () => {
    const node = parse('name:', { tolerant: true });

    expect(node.type === 'Tag' && node.expression.recovered?.synthetic).toBe(
      true,
    );
  });

  it('leaves a well-formed query untouched', () => {
    expect(parse('a AND b', { tolerant: true })).toEqual(parse('a AND b'));
  });
});

describe('range edge cases', () => {
  it('accepts a quoted boundary', () => {
    expect(ast('h:["a b" TO z]')).toBe('h:["a b" TO z]');
  });

  it('reports a boundary that is not a value', () => {
    expect(() => parse('h:[( TO z]')).toThrow(SiftQLSyntaxError);
    expect(() => parse('h:[1 TO ]')).toThrow(SiftQLSyntaxError);
  });

  it('recovers an unclosed range in tolerant mode', () => {
    expect(ast('h:[1 TO 2', { tolerant: true })).toBe('h:[1 TO 2]');
  });

  it('refuses an unclosed range in strict mode', () => {
    expect(() => parse('h:[1 TO 2')).toThrow(SiftQLSyntaxError);
  });

  it('recovers an unclosed field group in tolerant mode', () => {
    expect(ast('status:(a OR b', { tolerant: true })).toBe('status:[(OR a b)]');
  });
});

describe('escaped field names', () => {
  it('decodes escapes in a field segment', () => {
    const node = parse(String.raw`first\-name:foo`);

    expect(
      node.type === 'Tag' && node.field.segments.map((s) => s.name),
    ).toEqual(['first-name']);
  });
});
