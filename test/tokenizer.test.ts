import { describe, expect, it } from 'vitest';

import { SiftQLSyntaxError } from '../src/errors.js';
import { Tokenizer, type TokenizerOptions } from '../src/parser/tokenizer.js';
import type { Token } from '../src/parser/tokens.js';

const lex = (source: string, options: TokenizerOptions = {}): Token[] =>
  new Tokenizer(source, options).tokenize();

/** Compact, readable rendering of the token stream for assertions. */
const summary = (source: string, options: TokenizerOptions = {}): string[] =>
  lex(source, options)
    .filter((token) => token.type !== 'eof')
    .map((token) => {
      switch (token.type) {
        case 'comparison':
          return `op(${token.operator})`;
        case 'field':
          return `field(${token.name})`;
        case 'literal':
          return token.quote === 'none'
            ? `lit(${token.value})`
            : `lit(${token.value}|${token.quote})`;
        case 'rangeClose':
          return `close(${token.delimiter})`;
        case 'rangeOpen':
          return `open(${token.delimiter})`;
        case 'regex':
          return `re(/${token.pattern}/${token.flags})`;
        default:
          return token.type;
      }
    });

describe('fields and values', () => {
  it('splits a simple field match', () => {
    expect(summary('name:foo')).toEqual(['field(name)', 'op(:)', 'lit(foo)']);
  });

  it('reads a bare keyword with no field', () => {
    expect(summary('foo')).toEqual(['lit(foo)']);
  });

  it('keeps quoting, which decides case sensitivity later', () => {
    expect(summary('"foo"')).toEqual(['lit(foo|double)']);
    expect(summary("'foo'")).toEqual(['lit(foo|single)']);
  });

  it('reads a quoted field name containing spaces', () => {
    expect(summary("'full name':foo")).toEqual([
      'field(full name)',
      'op(:)',
      'lit(foo)',
    ]);
  });

  it('splits a dotted path but never a quoted one', () => {
    const [bare] = lex('name.first:foo');
    const [quoted] = lex("'name.first':foo");

    expect(bare?.type === 'field' && bare.path).toEqual(['name', 'first']);
    // A quoted name addresses a literal key that contains a dot.
    expect(quoted?.type === 'field' && quoted.path).toEqual(['name.first']);
  });

  it('allows hyphens inside a field name', () => {
    expect(summary('first-name:foo')).toEqual([
      'field(first-name)',
      'op(:)',
      'lit(foo)',
    ]);
  });

  it('allows values that begin with a digit', () => {
    expect(summary('name:123abc')).toEqual([
      'field(name)',
      'op(:)',
      'lit(123abc)',
    ]);
  });

  it('handles non-ASCII field names and values', () => {
    expect(summary('имя:Ω')).toEqual(['field(имя)', 'op(:)', 'lit(Ω)']);
  });
});

describe('the colon problem', () => {
  it('does not split the colons inside an unquoted ISO date-time', () => {
    expect(summary('date:>=2020-06-01T00:00:00Z')).toEqual([
      'field(date)',
      'op(:>=)',
      'lit(2020-06-01T00:00:00Z)',
    ]);
  });

  it('keeps an offset date-time in one piece', () => {
    expect(summary('date:<2020-06-01T12:00:00+02:00')).toEqual([
      'field(date)',
      'op(:<)',
      'lit(2020-06-01T12:00:00+02:00)',
    ]);
  });

  it('only the first colon separates', () => {
    expect(summary('a:b:c')).toEqual(['field(a)', 'op(:)', 'lit(b:c)']);
  });

  it('reads a bare time as a value', () => {
    expect(summary('start:14:30')).toEqual([
      'field(start)',
      'op(:)',
      'lit(14:30)',
    ]);
  });

  it('keeps slashes, so YYYY/MM/DD stays one token', () => {
    expect(summary('date:2020/06/01')).toEqual([
      'field(date)',
      'op(:)',
      'lit(2020/06/01)',
    ]);
  });
});

describe('comparison operators', () => {
  it('reads every form, longest match first', () => {
    expect(summary('h:=1')).toEqual(['field(h)', 'op(:=)', 'lit(1)']);
    expect(summary('h:>1')).toEqual(['field(h)', 'op(:>)', 'lit(1)']);
    expect(summary('h:>=1')).toEqual(['field(h)', 'op(:>=)', 'lit(1)']);
    expect(summary('h:<1')).toEqual(['field(h)', 'op(:<)', 'lit(1)']);
    expect(summary('h:<=1')).toEqual(['field(h)', 'op(:<=)', 'lit(1)']);
  });

  it('reports the operator span separately from the field span', () => {
    const [field, operator] = lex('name:>=1');

    expect(field).toMatchObject({ end: 4, start: 0, type: 'field' });
    expect(operator).toMatchObject({ end: 7, start: 4, type: 'comparison' });
  });
});

describe('ranges', () => {
  it('reads inclusive, exclusive, and mixed delimiters', () => {
    expect(summary('h:[1 TO 2]')).toEqual([
      'field(h)',
      'op(:)',
      'open([)',
      'lit(1)',
      'to',
      'lit(2)',
      'close(])',
    ]);
    expect(summary('h:{1 TO 2}')).toEqual([
      'field(h)',
      'op(:)',
      'open({)',
      'lit(1)',
      'to',
      'lit(2)',
      'close(})',
    ]);
    expect(summary('h:[1 TO 2}')).toEqual([
      'field(h)',
      'op(:)',
      'open([)',
      'lit(1)',
      'to',
      'lit(2)',
      'close(})',
    ]);
  });

  it('reads half-open bounds', () => {
    expect(summary('h:[* TO 2]')).toEqual([
      'field(h)',
      'op(:)',
      'open([)',
      'lit(*)',
      'to',
      'lit(2)',
      'close(])',
    ]);
    expect(summary('h:[1 TO *]')).toEqual([
      'field(h)',
      'op(:)',
      'open([)',
      'lit(1)',
      'to',
      'lit(*)',
      'close(])',
    ]);
  });

  it('accepts unquoted date-times inside a range', () => {
    // Inside a range there is no field-separator ambiguity, so the colons in a
    // date-time need no quoting here either.
    expect(summary('d:[2020-01-01T00:00:00Z TO 2020-12-31T23:59:59Z]')).toEqual(
      [
        'field(d)',
        'op(:)',
        'open([)',
        'lit(2020-01-01T00:00:00Z)',
        'to',
        'lit(2020-12-31T23:59:59Z)',
        'close(])',
      ],
    );
  });

  it('treats a quoted TO as a value, not the separator', () => {
    expect(summary('d:["TO" TO b]')).toEqual([
      'field(d)',
      'op(:)',
      'open([)',
      'lit(TO|double)',
      'to',
      'lit(b)',
      'close(])',
    ]);
  });
});

describe('operators and grouping', () => {
  it('recognises boolean keywords only when bare and uppercase', () => {
    expect(summary('a AND b')).toEqual(['lit(a)', 'and', 'lit(b)']);
    expect(summary('a OR b')).toEqual(['lit(a)', 'or', 'lit(b)']);
    expect(summary('NOT a')).toEqual(['not', 'lit(a)']);
    // Lowercase is an ordinary term.
    expect(summary('a and b')).toEqual(['lit(a)', 'lit(and)', 'lit(b)']);
    expect(summary('"AND"')).toEqual(['lit(AND|double)']);
  });

  it('reads prohibit and require prefixes', () => {
    expect(summary('-foo')).toEqual(['prohibit', 'lit(foo)']);
    expect(summary('+foo')).toEqual(['require', 'lit(foo)']);
    expect(summary('-foo:bar')).toEqual([
      'prohibit',
      'field(foo)',
      'op(:)',
      'lit(bar)',
    ]);
  });

  it('reads parenthesised groups', () => {
    expect(summary('a AND (b OR c)')).toEqual([
      'lit(a)',
      'and',
      'lparen',
      'lit(b)',
      'or',
      'lit(c)',
      'rparen',
    ]);
  });

  it('reads a field group', () => {
    expect(summary('status:(a OR b)')).toEqual([
      'field(status)',
      'op(:)',
      'lparen',
      'lit(a)',
      'or',
      'lit(b)',
      'rparen',
    ]);
  });

  it('reads implicit conjunction as adjacent terms', () => {
    expect(summary('name:foo height:=100')).toEqual([
      'field(name)',
      'op(:)',
      'lit(foo)',
      'field(height)',
      'op(:=)',
      'lit(100)',
    ]);
  });
});

describe('regular expressions', () => {
  it('reads a pattern and its flags', () => {
    expect(summary('name:/foo/')).toEqual([
      'field(name)',
      'op(:)',
      're(/foo/)',
    ]);
    expect(summary('name:/foo/i')).toEqual([
      'field(name)',
      'op(:)',
      're(/foo/i)',
    ]);
  });

  it('keeps an escaped slash inside the pattern', () => {
    expect(summary(String.raw`name:/a\/b/`)).toEqual([
      'field(name)',
      'op(:)',
      String.raw`re(/a\/b/)`,
    ]);
  });

  it('keeps an escaped backslash', () => {
    expect(summary(String.raw`name:/a\\/`)).toEqual([
      'field(name)',
      'op(:)',
      String.raw`re(/a\\/)`,
    ]);
  });

  it('does not end the literal at a slash inside a character class', () => {
    expect(summary('name:/[/]/')).toEqual([
      'field(name)',
      'op(:)',
      're(/[/]/)',
    ]);
  });
});

describe('wildcards', () => {
  it('keeps wildcards attached to the term in every position', () => {
    expect(summary('name:foo*bar')).toEqual([
      'field(name)',
      'op(:)',
      'lit(foo*bar)',
    ]);
    expect(summary('name:*bar')).toEqual(['field(name)', 'op(:)', 'lit(*bar)']);
    expect(summary('name:foo*')).toEqual(['field(name)', 'op(:)', 'lit(foo*)']);
    expect(summary('name:foo?bar')).toEqual([
      'field(name)',
      'op(:)',
      'lit(foo?bar)',
    ]);
  });
});

describe('errors', () => {
  it('reports an unterminated quoted string with a location', () => {
    expect(() => lex('name:"bar')).toThrow(SiftQLSyntaxError);

    try {
      lex('name:"bar');
    } catch (error) {
      expect(error).toBeInstanceOf(SiftQLSyntaxError);
      expect((error as SiftQLSyntaxError).location.start).toBe(5);
    }
  });

  it('reports an unterminated regular expression', () => {
    expect(() => lex('name:/bar')).toThrow(SiftQLSyntaxError);
  });

  it('reports a reserved character that is not yet meaningful', () => {
    // ^ and ~ are reserved for boost and fuzzy, so they are errors rather than
    // ordinary characters -- adding those operators later stays additive.
    expect(() => lex('foo^2')).toThrow(SiftQLSyntaxError);
    expect(() => lex('foo~2')).toThrow(SiftQLSyntaxError);
  });

  it('is not a plain SyntaxError, so it cannot be caught by accident', () => {
    try {
      lex('name:"bar');
    } catch (error) {
      expect(error).toBeInstanceOf(SiftQLSyntaxError);
      expect(Object.getPrototypeOf(error).constructor.name).toBe(
        'SiftQLSyntaxError',
      );
    }
  });
});

describe('tolerant mode', () => {
  it('accepts an unclosed quote as a usable prefix', () => {
    expect(summary('name:"bar', { tolerant: true })).toEqual([
      'field(name)',
      'op(:)',
      'lit(bar|double)',
    ]);
  });

  it('accepts an unclosed regular expression', () => {
    expect(summary('name:/bar', { tolerant: true })).toEqual([
      'field(name)',
      'op(:)',
      're(/bar/)',
    ]);
  });

  it('accepts a trailing operator', () => {
    expect(summary('name:', { tolerant: true })).toEqual([
      'field(name)',
      'op(:)',
    ]);
  });
});

describe('spans', () => {
  it('records locations that index back into the source', () => {
    const source = 'name:foo';
    const tokens = lex(source);

    for (const token of tokens) {
      expect(token.start).toBeLessThanOrEqual(token.end);
      expect(token.end).toBeLessThanOrEqual(source.length);
    }

    const [, , value] = tokens;

    expect(source.slice(value?.start, value?.end)).toBe('foo');
  });

  it('always terminates with a single eof token', () => {
    const tokens = lex('a AND b');

    expect(tokens.at(-1)?.type).toBe('eof');
    expect(tokens.filter((token) => token.type === 'eof')).toHaveLength(1);
  });
});
