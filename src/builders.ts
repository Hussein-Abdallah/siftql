/**
 * Building an AST without writing a query.
 *
 * Two reasons this exists, and neither is convenience.
 *
 * A query assembled from user input by string concatenation is an injection
 * bug waiting to happen: a value containing `) OR (` rewrites the query around
 * it. Building the tree and calling `serialize()` cannot do that, because
 * escaping happens after the structure is fixed rather than being the thing the
 * caller must remember. `builders.term('a) OR (b')` is one term whose value
 * contains parentheses, and there is no spelling of the input that makes it two.
 *
 * The second reason is stability. If a future version has to add a required
 * field to a node, every caller who wrote an object literal breaks and every
 * caller who used a builder does not. That is only true if the builders are the
 * documented way in, which is why they are part of {@link AstBuilders} rather
 * than a test helper.
 *
 * WHAT THEY DELIBERATELY DO NOT DO. They do not validate that the tree is
 * *sensible* — `and(empty(), empty())` is constructible. The type signatures
 * already refuse the errors worth refusing at this level (a `Tag` cannot hold
 * another `Tag`, a relational operator cannot take a range), and a runtime check
 * for the rest would duplicate the evaluator's own refusals a step earlier while
 * being easier to get out of step with.
 *
 * LOCATIONS are {@link SYNTHETIC_LOCATION}, a zero-width span at index 0, since
 * there is no source text these nodes came from. That is a deliberate lie of
 * omission that the alternatives are worse than: inventing plausible offsets
 * would make an error message point into a string the caller never wrote, and
 * making `location` optional would put a `?.` in front of every use in a
 * consumer that only ever handles parsed trees.
 */

import { scanPattern } from './parser/pattern.js';
import {
  SYNTHETIC_LOCATION as at,
  type AstBuilders,
  type BooleanLiteral,
  type EmptyExpression,
  type Expression,
  type Field,
  type FieldGroupBody,
  type LogicalExpression,
  type MatchTag,
  type MatchTagExpression,
  type NonEmptyArray,
  type NullLiteral,
  type ParenthesizedExpression,
  type QuotedTextLiteral,
  type RangeBoundary,
  type RangeExpression,
  type RegexExpression,
  type RegexFlag,
  type RelationalOperatorSymbol,
  type RelationalTag,
  type TextLiteral,
  type UnaryOperator,
  type UnaryOperatorSymbol,
  type WildcardExpression,
} from './types.js';

/**
 * A bare term — except for the empty string, which has no bare spelling.
 *
 * `term('')` cannot produce a node that round-trips: an unquoted empty term is
 * not writable, so `serialize` must emit `""`, and that re-parses as a QUOTED
 * literal. Returning the quoted node directly means what the builder hands back
 * and what `parse(serialize(...))` returns are the same thing, which is the
 * property the builders exist to provide.
 */
const term = (value: string): TextLiteral =>
  value.length === 0
    ? quoted('')
    : {
        literal: 'text',
        location: at,
        quoted: false,
        type: 'LiteralExpression',
        value,
      };

const quoted = (value: string): QuotedTextLiteral => ({
  literal: 'text',
  location: at,
  quoted: true,
  type: 'LiteralExpression',
  value,
});

const boundary = (
  value: TextLiteral | null,
  inclusive: boolean,
): RangeBoundary =>
  value === null
    ? { bounded: false, location: at, type: 'RangeBoundary' }
    : { bounded: true, inclusive, location: at, type: 'RangeBoundary', value };

/**
 * The builders.
 *
 * A frozen object rather than 17 separate exports, so a consumer can pass the
 * whole set to a function that assembles queries, and so the set is named in one
 * place when a builder is added.
 */
export const builders: AstBuilders = Object.freeze({
  and: (
    left: Expression,
    right: Expression,
    implicit = false,
  ): LogicalExpression => ({
    left,
    location: at,
    operator: implicit
      ? {
          location: at,
          notation: 'implicit',
          operator: 'AND',
          type: 'BooleanOperator',
        }
      : {
          location: at,
          notation: 'explicit',
          operator: 'AND',
          type: 'BooleanOperator',
        },
    right,
    type: 'LogicalExpression',
  }),

  boolean: (value: boolean): BooleanLiteral => ({
    literal: 'boolean',
    location: at,
    quoted: false,
    type: 'LiteralExpression',
    value,
  }),

  compare: (
    field: Field,
    operator: RelationalOperatorSymbol,
    expression: TextLiteral,
    caseSensitive = false,
  ): RelationalTag => ({
    caseSensitive,
    expression,
    field,
    kind: 'relational',
    location: at,
    operator: { location: at, operator, type: 'ComparisonOperator' },
    type: 'Tag',
  }),

  empty: (): EmptyExpression => ({ location: at, type: 'EmptyExpression' }),

  /**
   * A dotted path, one argument per segment.
   *
   * Variadic rather than taking `'a.b'`, because a key may CONTAIN a dot and
   * splitting a string could not tell `field('a.b')` — one key with a dot in it —
   * from two segments. The parser has the same problem and solves it with
   * backslash escapes; here the argument list is the escape.
   */
  field: (...path: NonEmptyArray<string>): Field => ({
    location: at,
    segments: path.map((name) => ({
      location: at,
      name,
      quoted: false,
      type: 'FieldSegment' as const,
    })) as unknown as Field['segments'],
    type: 'Field',
  }),

  fieldGroup: (
    body: FieldGroupBody,
  ): ParenthesizedExpression<FieldGroupBody> => ({
    expression: body,
    location: at,
    type: 'ParenthesizedExpression',
  }),

  group: (expression: Expression): ParenthesizedExpression => ({
    expression,
    location: at,
    type: 'ParenthesizedExpression',
  }),

  not: (
    operand: Expression,
    operator: UnaryOperatorSymbol = 'NOT',
  ): UnaryOperator => ({
    location: at,
    operand,
    operator,
    type: 'UnaryOperator',
  }),

  null: (): NullLiteral => ({
    literal: 'null',
    location: at,
    quoted: false,
    type: 'LiteralExpression',
    value: null,
  }),

  or: (left: Expression, right: Expression): LogicalExpression => ({
    left,
    location: at,
    operator: {
      location: at,
      notation: 'explicit',
      operator: 'OR',
      type: 'BooleanOperator',
    },
    right,
    type: 'LogicalExpression',
  }),

  quoted,

  range: (
    lower: TextLiteral | null,
    lowerInclusive: boolean,
    upper: TextLiteral | null,
    upperInclusive: boolean,
  ): RangeExpression => ({
    location: at,
    lower: boundary(lower, lowerInclusive),
    type: 'RangeExpression',
    upper: boundary(upper, upperInclusive),
  }),

  /**
   * Flags are sorted and de-duplicated, because `/a/gi` and `/a/ig` are the same
   * regex and two ASTs that mean the same thing should compare equal. The parser
   * does the same, so a built node and a parsed one match.
   */
  regex: (
    pattern: string,
    flags: readonly RegexFlag[] = [],
  ): RegexExpression => ({
    flags: [...new Set(flags)].sort(),
    location: at,
    pattern,
    type: 'RegexExpression',
  }),

  tag: (
    field: Field,
    expression: MatchTagExpression,
    caseSensitive = false,
  ): MatchTag => ({
    caseSensitive,
    expression,
    field,
    kind: 'match',
    location: at,
    operator: { location: at, operator: ':', type: 'ComparisonOperator' },
    type: 'Tag',
  }),

  term,

  /**
   * Here — and ONLY here — `*` and `?` are metacharacters.
   *
   * Segmentation goes through the same {@link scanPattern} the parser uses, so a
   * built pattern is structurally identical to the parsed one and there is no
   * second implementation to drift. It also means a backslash escapes a
   * metacharacter exactly as it does in a query: `wildcard('a\\*b')` is the
   * literal `a*b`, and `scanPattern` reporting no metacharacters is what makes
   * this return a plain term rather than a one-segment wildcard — a node that
   * would serialize the same but not compare equal.
   */
  wildcard: (
    pattern: string,
    isQuoted = false,
  ): TextLiteral | WildcardExpression => {
    const scanned = scanPattern(pattern, 0);

    if (scanned.kind === 'text') {
      return isQuoted ? quoted(scanned.value) : term(scanned.value);
    }

    return {
      location: at,
      pattern: scanned.segments,
      quoted: isQuoted,
      type: 'WildcardExpression',
    };
  },
});
