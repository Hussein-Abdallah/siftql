import {
  MAX_AST_NODES,
  MAX_CLAUSES,
  MAX_DEPTH,
  MAX_FIELD_SEGMENTS,
  MAX_WILDCARD_SEGMENTS,
} from '../limits.js';
import { assertOptions, assertQuery, expansionOf } from '../validate.js';
import { SiftQLSyntaxError } from '../errors.js';
import type {
  BooleanOperator,
  ComparisonOperator,
  Expression,
  Field,
  FieldGroupBody,
  FieldSegment,
  LiteralExpression,
  MatchTagExpression,
  NonEmptyArray,
  RangeBoundary,
  RangeExpression,
  RegexExpression,
  RegexFlag,
  SiftQLAst,
  SourceLocation,
  Tag,
  WildcardExpression,
} from '../types.js';
import { RECOVERY_REASONS } from '../types.js';
import { scanPattern } from './pattern.js';
import { Tokenizer, type TokenizerOptions } from './tokenizer.js';
import type { Token } from './tokens.js';

/**
 * Recursive-descent parser with Pratt-style precedence. Hand-written; no parser
 * generator is involved anywhere in this package.
 *
 * Precedence, loosest to tightest:
 *
 *   OR  <  AND (explicit and implicit are the SAME level)  <  NOT / -  <  primary
 *
 * All binary operators are left-associative, so `a OR b OR c` is `(a OR b) OR c`
 * and the tree shape is stable under re-parsing — which is what the round-trip
 * law depends on.
 *
 * Two structural rules are worth stating because they are the reason several
 * whole classes of bug cannot occur here:
 *
 * - A BARE TERM IS NOT A TAG. `foo` parses to a naked literal, so `Tag.field`
 *   is never fabricated and never nullable.
 * - A FIELD GROUP IS NOT DESUGARED. `name:(a OR b)` keeps its group instead of
 *   becoming `(name:a OR name:b)`, so locations stay honest for highlight() and
 *   error carets, and nesting does not multiply subtrees.
 */

export interface ParseOptions extends TokenizerOptions {
  /**
   * Best-effort parsing for incomplete input. Instead of throwing, holes become
   * `MissingExpression` nodes stamped with `recovered`, which `compile()` then
   * prunes or refuses. Stray structural characters are skipped and a half-typed
   * modifier or regex flag is dropped, both marked. For search-as-you-type.
   *
   * STRUCTURAL LIMITS STILL THROW — nesting depth, clause count, node budget.
   * Those guard resources rather than describing something half-typed, and a
   * search box does not reach them by accident.
   */
  readonly tolerant?: boolean | undefined;
}

const REGEX_FLAGS = new Set<string>(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

/** Tokens that can begin a primary expression, hence an implicit conjunction. */
const STARTS_PRIMARY = new Set<Token['type']>([
  'field',
  'literal',
  'lparen',
  'not',
  'prohibit',
  'rangeOpen',
  'regex',
  'require',
]);

const span = (start: number, end: number): SourceLocation => ({ end, start });

/**
 * How many clauses one query may contain.
 *
 * The parser builds a left spine with a loop and would happily accept far more
 * terms, but `prune()` and `compileExpression()` walk that spine recursively
 * and a `serialize()` of a long unary chain does too — so a query the parser
 * accepted could blow the stack later with a raw RangeError escaping the
 * documented error contract. The stages now agree on what is representable,
 * and exceeding it is a located SiftQLSyntaxError rather than a crash.
 *
 * 2,000 is far beyond any human-written query while leaving a wide margin
 * under the ~5,000 where the first stage actually fails.
 */

/** Guards against a deeply NESTED query exhausting the descent itself. */

class Parser {
  private readonly source: string;

  private readonly tokens: readonly Token[];

  private readonly tolerant: boolean;

  private index = 0;

  /**
   * Depth of enclosing FIELD groups. Non-zero means a `field:` clause here would
   * produce a Tag inside a FieldGroupBody, which the contract makes
   * unconstructible, so it is refused at parse time instead.
   */
  private fieldGroupDepth = 0;

  /** Counts every clause produced, so a generated query cannot crash later. */
  private clauses = 0;

  /** Current recursive-descent depth. */
  private depth = 0;

  public constructor(
    source: string,
    tokens: readonly Token[],
    tolerant: boolean,
  ) {
    this.source = source;
    this.tokens = tokens;
    this.tolerant = tolerant;
  }

  public parse(): SiftQLAst {
    if (this.peek().type === 'eof') {
      const { end, start } = this.peek();

      return { location: span(start, end), type: 'EmptyExpression' };
    }

    const expression = this.parseOr();
    const trailing = this.peek();

    if (trailing.type === 'eof') {
      return expression;
    }

    if (!this.tolerant) {
      this.fail(`Unexpected ${this.describe(trailing)}`, trailing, [
        'an operator',
        'end of query',
      ]);
    }

    /*
     * Tolerant mode SKIPS the offending token and keeps going.
     *
     * A stray closer is what you have half way through an edit: `(a:b))` is one
     * keystroke away from `(a:b)`. Discarding everything after it, which is what
     * this used to do, made the answer a SUPERSET — `a:b } zzz` silently dropped
     * the `zzz` conjunct and matched rows it should not have, which is worse
     * than the throw it replaced. The clauses either side are both things the
     * user typed, so both are kept and joined implicitly.
     */
    let result = expression;

    while (this.peek().type !== 'eof') {
      const stray = this.advance();

      if (this.peek().type === 'eof') {
        break;
      }

      const right = this.parseAnd();

      result = {
        left: result,
        location: span(result.location.start, right.location.end),
        operator: {
          location: span(stray.start, stray.end),
          notation: 'implicit',
          operator: 'AND',
          type: 'BooleanOperator',
        },
        right,
        type: 'LogicalExpression',
      };
    }

    // Only if nothing deeper already explained itself: a dropped `^2` is a more
    // useful reason than "there was trailing input", and the spread used to
    // overwrite it.
    return result.recovered
      ? result
      : {
          ...result,
          recovered: {
            reason: RECOVERY_REASONS.trailingInput,
            synthetic: false,
          },
        };
  }

  /* ----------------------------------------------------------------------- *
   * Token helpers
   * ----------------------------------------------------------------------- */

  private peek(offset = 0): Token {
    const token = this.tokens[this.index + offset];

    // The stream always ends with eof, so this only fires past the end.
    return (
      token ?? {
        end: this.source.length,
        start: this.source.length,
        type: 'eof',
      }
    );
  }

  private advance(): Token {
    const token = this.peek();

    if (token.type !== 'eof') {
      this.index += 1;
    }

    return token;
  }

  private describe(token: Token): string {
    switch (token.type) {
      case 'and':
      case 'or':
      case 'not':
        return `"${token.type.toUpperCase()}"`;
      case 'comparison':
        return `operator "${token.operator}"`;
      case 'eof':
        return 'end of query';
      case 'field':
        return `field "${token.name}"`;
      case 'literal':
        return `value "${token.value}"`;
      case 'lparen':
        return '"("';
      case 'modifier':
        return `modifier "${token.raw}"`;
      case 'rangeClose':
        return `"${token.delimiter}"`;
      case 'rangeOpen':
        return `"${token.delimiter}"`;
      case 'regex':
        return 'a regular expression';
      case 'rparen':
        return '")"';
      case 'to':
        return '"TO"';
      default:
        return `"${this.source.slice(token.start, token.end)}"`;
    }
  }

  private fail(
    message: string,
    token: Token,
    expected: readonly string[] = [],
  ): never {
    throw new SiftQLSyntaxError(
      message,
      span(token.start, token.end),
      this.source,
      { expected },
    );
  }

  /** A hole for tolerant mode; always carries `recovered`, per the contract. */
  private missing(at: number, reason: string): Expression {
    return {
      location: span(at, at),
      recovered: { reason, synthetic: true },
      type: 'MissingExpression',
    };
  }

  /* ----------------------------------------------------------------------- *
   * Precedence climb
   * ----------------------------------------------------------------------- */

  /**
   * Enter one level of nesting, refusing to go past MAX_DEPTH.
   *
   * ONE implementation, because there were two and they disagreed. `depth`
   * counts frames, and the outermost frame is the query itself rather than a
   * level of nesting — so nesting depth is one less. `parseOr` was corrected to
   * subtract it and `parseUnary` was not, which left the exported constant
   * meaning 200 for parentheses and 199 for `NOT`, with the message saying
   * "more than 200" in both cases.
   */
  private enterDepth(at: Token): void {
    this.depth += 1;

    if (this.depth - 1 > MAX_DEPTH) {
      this.fail(
        `Query is nested too deeply: more than ${String(MAX_DEPTH)} levels`,
        at,
        ['a flatter query'],
      );
    }
  }

  private parseOr(): Expression {
    this.enterDepth(this.peek());

    try {
      return this.parseOrInner();
    } finally {
      this.depth -= 1;
    }
  }

  private parseOrInner(): Expression {
    let left = this.parseAnd();

    while (this.peek().type === 'or') {
      const keyword = this.advance();
      const operator: BooleanOperator = {
        location: span(keyword.start, keyword.end),
        notation: 'explicit',
        operator: 'OR',
        type: 'BooleanOperator',
      };
      const right = this.parseAnd();

      left = {
        left,
        location: span(left.location.start, right.location.end),
        operator,
        right,
        type: 'LogicalExpression',
      };
    }

    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseUnary();

    for (;;) {
      const next = this.peek();
      let operator: BooleanOperator;

      if (next.type === 'and') {
        this.advance();
        operator = {
          location: span(next.start, next.end),
          notation: 'explicit',
          operator: 'AND',
          type: 'BooleanOperator',
        };
      } else if (STARTS_PRIMARY.has(next.type)) {
        // Juxtaposition. The operator node is zero-width at the start of the
        // right operand, because there is no text to point at.
        operator = {
          location: span(next.start, next.start),
          notation: 'implicit',
          operator: 'AND',
          type: 'BooleanOperator',
        };
      } else {
        return left;
      }

      const right = this.parseUnary();

      left = {
        left,
        location: span(left.location.start, right.location.end),
        operator,
        right,
        type: 'LogicalExpression',
      };
    }
  }

  private parseUnary(): Expression {
    const next = this.peek();

    /*
     * Inside a field group, `-3` is the number minus three, not "NOT 3".
     *
     * A group body is a list of VALUES for the enclosing field, and the
     * tokenizer reads it in default mode where a leading `-` is prohibition.
     * `n:(-3 OR -5)` therefore became `n:(NOT 3 OR NOT 5)` and matched a row
     * whose n was 7. Only an ADJACENT sign is folded — `n:(- 3)` keeps its
     * negation — and only inside a group, so top-level `-foo` is untouched.
     *
     * The sign is MERGED INTO THE TOKEN and the result goes through the ordinary
     * literal path, rather than being assembled into a node here. Building it by
     * hand meant skipping everything that path does, and three defects followed
     * from that one shortcut:
     *
     *  - `scanPattern` never ran, so `n:(-3*)` produced the plain text `-3*`
     *    while `n:-3*` produced a wildcard. Two spellings of one clause
     *    disagreed, silently, and only the unparenthesised one matched `-3xyz`.
     *  - escapes were never decoded, so `n:(-3\ 4)` kept its backslash and did
     *    not match `-3 4`, which `n:-3\ 4` did.
     *  - no clause was counted, so `n:(-1 OR -1 OR …)` sailed past MAX_CLAUSES
     *    and emitted a tree deeper than the rest of the package accepts — the
     *    parser and the serializer disagreed about what was representable.
     */
    if (
      this.fieldGroupDepth > 0 &&
      next.type === 'prohibit' &&
      this.isAdjacentNumber(next)
    ) {
      const sign = this.advance();
      const digits = this.advance() as Extract<Token, { type: 'literal' }>;

      this.countClause(digits);

      // Through parseModifiers, like every other primary. Returning directly
      // left a `^2`/`~2` token in the stream, which the group reader then met
      // where it expected `)` — so `n:(-3^2)` reported "unclosed field group"
      // for a group that was closed, instead of the UNSUPPORTED_SYNTAX that
      // `n:(3^2)` correctly reports.
      return this.parseModifiers(
        this.parseLiteralOrWildcard({
          ...digits,
          start: sign.start,
          // Raw source text, sign included: the literal path decodes it.
          value: `-${digits.value}`,
        }),
      );
    }

    if (next.type === 'not' || next.type === 'prohibit') {
      this.advance();
      this.enterDepth(next);

      const operand = this.parseUnary();

      this.depth -= 1;

      return {
        location: span(next.start, operand.location.end),
        operand,
        operator: next.type === 'not' ? 'NOT' : '-',
        type: 'UnaryOperator',
      };
    }

    if (next.type === 'require') {
      /*
       * Reserved for v0.2. Refused rather than silently ignored, because
       * dropping it would make `+a b` and `a b` the same query.
       *
       * In TOLERANT mode it is dropped and MARKED instead, exactly as `^boost`
       * and `~fuzzy` already were. `+` had no tolerant branch at all, so a
       * search box blanked out the moment someone typed it — the one thing
       * tolerant mode exists to prevent, and the same gap the comment below
       * describes closing for the other two markers.
       */
      if (!this.tolerant) {
        throw new SiftQLSyntaxError(
          'The required marker "+" is reserved and not supported in this version',
          span(next.start, next.end),
          this.source,
          { code: 'UNSUPPORTED_SYNTAX' },
        );
      }

      this.advance();

      const required = this.parseUnary();

      return required.recovered
        ? required
        : {
            ...required,
            recovered: {
              reason: RECOVERY_REASONS.unsupportedModifier,
              synthetic: false,
            },
          };
    }

    return this.parseModifiers(this.parsePrimary());
  }

  /**
   * `^boost`, `~fuzzy`, `~proximity` — reserved for v0.2.
   *
   * Refused rather than ignored, because dropping a boost silently would make
   * `a^5 b` and `a b` the same query. `types.ts` and `errors.ts` both promise the
   * code is `UNSUPPORTED_SYNTAX`, and only `+required` was delivering it: `^` and
   * `~` reached the bare-term reader and came back as a generic
   * `Unexpected character`, so a consumer branching on the code to say "not
   * supported until v0.2" got that right for one of the three documented forms.
   *
   * In TOLERANT mode the modifier is dropped and the clause is MARKED, because a
   * search box hands us `foo^` the moment someone starts typing a boost and must
   * not blank out — but `onRecovered` still has to be able to see that something
   * was thrown away.
   */
  private parseModifiers(expression: Expression): Expression {
    let result = expression;

    while (this.peek().type === 'modifier') {
      const token = this.advance() as Extract<Token, { type: 'modifier' }>;

      if (!this.tolerant) {
        throw new SiftQLSyntaxError(
          `The ${token.sigil === '^' ? 'boost' : 'fuzzy/proximity'} modifier "${token.raw}" is reserved and not supported in this version`,
          span(token.start, token.end),
          this.source,
          { code: 'UNSUPPORTED_SYNTAX' },
        );
      }

      result = {
        ...result,
        recovered: {
          reason: RECOVERY_REASONS.unsupportedModifier,
          synthetic: false,
        },
      };
    }

    return result;
  }

  /** True when a numeric literal begins exactly where `sign` ends. */
  private isAdjacentNumber(sign: Token): boolean {
    const after = this.peek(1);

    return (
      after.type === 'literal' &&
      after.quote === 'none' &&
      after.start === sign.end &&
      /^\d/u.test(after.value)
    );
  }

  /**
   * Count one clause against the budget.
   *
   * Extracted because `parsePrimary` is no longer the only place a clause is
   * produced: the negative fold makes one too, and when it did its own accounting
   * by not doing any, `MAX_CLAUSES` stopped bounding the tree.
   */
  private countClause(at: Token): void {
    this.clauses += 1;

    if (this.clauses > MAX_CLAUSES) {
      this.fail(
        `Query is too large: more than ${String(MAX_CLAUSES)} clauses`,
        at,
        ['a shorter query'],
      );
    }
  }

  private parsePrimary(): Expression {
    const next = this.peek();

    this.countClause(next);

    switch (next.type) {
      case 'field':
        return this.parseTag();
      case 'literal':
        return this.parseLiteralOrWildcard(
          this.advance() as Extract<Token, { type: 'literal' }>,
        );
      case 'lparen':
        return this.parseGroup();
      case 'rangeOpen':
        return this.parseRange();
      case 'regex':
        return this.parseRegex(
          this.advance() as Extract<Token, { type: 'regex' }>,
        );
      default:
        if (this.tolerant) {
          return this.missing(next.start, RECOVERY_REASONS.missingOperand);
        }

        return this.fail(
          `Expected a search term but found ${this.describe(next)}`,
          next,
          ['a value', 'a field', '"("'],
        );
    }
  }

  private parseGroup(): Expression {
    const open = this.advance();
    const inner = this.parseOr();
    const close = this.peek();

    if (close.type !== 'rparen') {
      if (!this.tolerant) {
        this.fail('Unclosed group: expected ")"', close, ['")"']);
      }

      return {
        expression: inner,
        location: span(open.start, inner.location.end),
        recovered: { reason: RECOVERY_REASONS.unclosedGroup, synthetic: false },
        type: 'ParenthesizedExpression',
      };
    }

    this.advance();

    return {
      expression: inner,
      location: span(open.start, close.end),
      type: 'ParenthesizedExpression',
    };
  }

  /* ----------------------------------------------------------------------- *
   * Tags
   * ----------------------------------------------------------------------- */

  private parseTag(): Tag {
    const fieldToken = this.advance() as Extract<Token, { type: 'field' }>;

    if (this.fieldGroupDepth > 0) {
      this.fail(
        `A field group may not contain another field: "${fieldToken.name}:" is not allowed inside ( )`,
        fieldToken,
        ['a value'],
      );
    }

    const operatorToken = this.peek();

    if (operatorToken.type !== 'comparison') {
      return this.fail('Expected a comparison operator', operatorToken, [':']);
    }

    this.advance();

    const field = this.buildField(fieldToken);
    // A quote invented inside the field PATH is a recovery like any other, and it
    // has to reach the node: without it `name.'first:ada` parsed in tolerant mode
    // looked like a deliberate clause, and `onRecovered: 'throw'` accepted it.
    const pathRecovered =
      fieldToken.recovered === undefined
        ? {}
        : {
            recovered: { reason: fieldToken.recovered, synthetic: false },
          };
    const operator: ComparisonOperator = {
      location: span(operatorToken.start, operatorToken.end),
      operator: operatorToken.operator,
      type: 'ComparisonOperator',
    };

    if (operatorToken.operator === ':') {
      const expression = this.parseMatchValue(operatorToken);

      return {
        ...pathRecovered,
        caseSensitive: operatorToken.caseSensitive,
        expression,
        field,
        kind: 'match',
        location: span(fieldToken.start, expression.location.end),
        operator: operator as Extract<ComparisonOperator, { operator: ':' }>,
        type: 'Tag',
      };
    }

    const expression = this.parseRelationalValue(operatorToken);

    return {
      ...pathRecovered,
      caseSensitive: operatorToken.caseSensitive,
      expression,
      field,
      kind: 'relational',
      location: span(fieldToken.start, expression.location.end),
      operator: operator as Exclude<ComparisonOperator, { operator: ':' }>,
      type: 'Tag',
    };
  }

  private buildField(token: Extract<Token, { type: 'field' }>): Field {
    /*
     * The tokenizer already decided where each step begins and ends, and whether
     * it was quoted. Reading that is the whole job.
     *
     * This used to walk a cursor forward by `name.length + 1` per segment, which
     * assumes a decoded name occupies exactly its own length in the source. That
     * is false for anything quoted or escaped: `'full name'.first` reported its
     * first segment as `'full nam` and its second as `'.fir`, so every caret and
     * highlight built on those spans pointed at the wrong characters. It also
     * had one `quoted` flag for the whole token, so per-segment quoting — which
     * `types.ts` calls load-bearing — was always reported as false.
     */
    if (token.segments.length > MAX_FIELD_SEGMENTS) {
      this.fail(
        `A field path may have at most ${String(MAX_FIELD_SEGMENTS)} segments; this one has ${String(token.segments.length)}`,
        token,
      );
    }

    const segments = token.segments.map((segment): FieldSegment => ({
      location: span(segment.start, segment.end),
      name: segment.name,
      /*
       * An EMPTY segment is always reported as quoted, because `""` is the only
       * way to write one. `serializeField` already prints it that way, but the
       * parser reported `quoted: false`, so `a.:1` serialized to `a."":1` and
       * re-parsed to a tree that was not deep-equal to the first — breaking the
       * round-trip law over `a.:1`, `.a:1`, `a..b:1` and `.:1`.
       *
       * `builders.term('')` normalises for exactly this reason; this is the same
       * rule, applied to the other place a name can be empty.
       */
      quoted: segment.quoted || segment.name.length === 0,
      type: 'FieldSegment',
    })) as unknown as NonEmptyArray<FieldSegment>;

    return {
      location: span(token.start, token.end),
      segments,
      type: 'Field',
    };
  }

  private parseMatchValue(operator: Token): MatchTagExpression {
    const next = this.peek();

    switch (next.type) {
      case 'literal':
        return this.parseLiteralOrWildcard(
          this.advance() as Extract<Token, { type: 'literal' }>,
        );
      case 'lparen':
        return this.parseFieldGroup();
      case 'rangeOpen':
        return this.parseRange();
      case 'regex':
        return this.parseRegex(
          this.advance() as Extract<Token, { type: 'regex' }>,
        );
      default:
        if (this.tolerant) {
          return this.missing(
            operator.end,
            RECOVERY_REASONS.missingValue,
          ) as MatchTagExpression;
        }

        return this.fail(
          `Expected a value after "${'operator' in operator ? operator.operator : ':'}"`,
          next,
          ['a value', 'a range', 'a regular expression', '"("'],
        );
    }
  }

  /** The hole a half-typed relational value leaves behind. */
  private missingValue(
    operator: Extract<Token, { type: 'comparison' }>,
  ): Extract<Expression, { type: 'MissingExpression' }> {
    return this.missing(operator.end, RECOVERY_REASONS.missingValue) as Extract<
      Expression,
      { type: 'MissingExpression' }
    >;
  }

  private parseRelationalValue(
    operator: Extract<Token, { type: 'comparison' }>,
  ): LiteralExpression | Extract<Expression, { type: 'MissingExpression' }> {
    const next = this.peek();

    if (next.type !== 'literal') {
      if (this.tolerant) {
        return this.missing(
          operator.end,
          RECOVERY_REASONS.missingValue,
        ) as Extract<Expression, { type: 'MissingExpression' }>;
      }

      return this.fail(
        `"${operator.operator}" compares against a single value, but found ${this.describe(next)}`,
        next,
        ['a value'],
      );
    }

    const parsed = this.parseLiteralOrWildcard(
      this.advance() as Extract<Token, { type: 'literal' }>,
    );

    if (parsed.type !== 'LiteralExpression') {
      // name:>foo*bar and the like: a wildcard is a set, not a point.
      //
      // Half-typed in tolerant mode this is `n:>a` on its way to `n:>abc`, so it
      // becomes a hole rather than a throw — the generator found five spellings
      // of this one branch (`n:<?`, `n:=a*`, `n:>=a*`, …) that an enumerated
      // list of cases had missed.
      return this.tolerant
        ? this.missingValue(operator)
        : this.fail(
            `"${operator.operator}" compares against a single value`,
            next,
            ['a value'],
          );
    }

    /*
     * `:=` accepts a boolean or null; the ORDERED operators do not.
     *
     * `:=` is strict equality, and `b:true` already worked, so refusing
     * `b:=true` left the operator whose entire job is equality unable to state
     * it against the two values that have nothing else. `height:>true` stays a
     * syntax error, because there is no ordering to appeal to.
     */
    if (parsed.literal !== 'text' && operator.operator !== ':=') {
      return this.tolerant
        ? this.missingValue(operator)
        : this.fail(
            `"${operator.operator}" compares against a single text or numeric value`,
            next,
            ['a value'],
          );
    }

    return parsed;
  }

  /**
   * `name:(a OR b)`. The body may not contain a Tag, which the contract enforces
   * in the type system; the depth counter is what upholds it at parse time.
   */
  private parseFieldGroup(): MatchTagExpression {
    const open = this.advance();

    this.fieldGroupDepth += 1;

    let inner: Expression;

    try {
      inner = this.parseOr();
    } finally {
      this.fieldGroupDepth -= 1;
    }

    const close = this.peek();

    if (close.type !== 'rparen') {
      if (!this.tolerant) {
        this.fail('Unclosed field group: expected ")"', close, ['")"']);
      }

      return {
        // Sound: parseTag refuses a field inside a group, so no Tag can occur.
        expression: inner as FieldGroupBody,
        location: span(open.start, inner.location.end),
        recovered: { reason: RECOVERY_REASONS.unclosedGroup, synthetic: false },
        type: 'ParenthesizedExpression',
      };
    }

    this.advance();

    return {
      expression: inner as FieldGroupBody,
      location: span(open.start, close.end),
      type: 'ParenthesizedExpression',
    };
  }

  /* ----------------------------------------------------------------------- *
   * Leaves
   * ----------------------------------------------------------------------- */

  private parseLiteralOrWildcard(
    token: Extract<Token, { type: 'literal' }>,
  ): LiteralExpression | WildcardExpression {
    const quoted = token.quote !== 'none';
    const location = span(token.start, token.end);
    // token.value is raw source text, so the content begins one character in
    // when quoted. That keeps every wildcard segment's location exact.
    const contentStart = quoted ? token.start + 1 : token.start;

    if (!quoted) {
      switch (token.value) {
        case 'true':
          return {
            literal: 'boolean',
            location,
            quoted: false,
            type: 'LiteralExpression',
            value: true,
          };
        case 'false':
          return {
            literal: 'boolean',
            location,
            quoted: false,
            type: 'LiteralExpression',
            value: false,
          };
        case 'null':
          return {
            literal: 'null',
            location,
            quoted: false,
            type: 'LiteralExpression',
            value: null,
          };
        default:
          break;
      }
    }

    const scanned = scanPattern(token.value, contentStart);
    // Tolerant mode invented the closing quote; the node must say so or
    // `onRecovered` cannot see that anything was guessed at.
    const recovered =
      token.recovered === undefined
        ? {}
        : { recovered: { reason: token.recovered, synthetic: false } };

    if (scanned.kind === 'wildcard') {
      if (scanned.segments.length > MAX_WILDCARD_SEGMENTS) {
        this.fail(
          `A wildcard pattern may have at most ${String(MAX_WILDCARD_SEGMENTS)} segments; this one has ${String(scanned.segments.length)}`,
          token,
        );
      }

      return {
        ...recovered,
        location,
        pattern: scanned.segments,
        quoted,
        type: 'WildcardExpression',
      };
    }

    return quoted
      ? {
          ...recovered,
          literal: 'text',
          location,
          quoted: true,
          type: 'LiteralExpression',
          value: scanned.value,
        }
      : {
          ...recovered,
          literal: 'text',
          location,
          quoted: false,
          type: 'LiteralExpression',
          value: scanned.value,
        };
  }

  private parseRegex(
    token: Extract<Token, { type: 'regex' }>,
  ): RegexExpression {
    const seen = new Set<string>();
    const flags: RegexFlag[] = [];
    /*
     * A BAD FLAG IS DROPPED IN TOLERANT MODE, not thrown.
     *
     * `/a/ii` and `//=` are what a search box holds mid-keystroke, and both
     * threw — so tolerant mode blanked out on the way to a valid pattern. The
     * clause is marked instead, so `onRecovered: 'throw'` can still refuse to
     * act on it and a UI can still grey it out.
     */
    let dropped = false;

    for (const flag of token.flags) {
      if (!REGEX_FLAGS.has(flag)) {
        if (!this.tolerant) {
          this.fail(`Unknown regular expression flag "${flag}"`, token, [
            'a valid flag',
          ]);
        }

        dropped = true;
        continue;
      }

      if (seen.has(flag)) {
        if (!this.tolerant) {
          this.fail(`Duplicate regular expression flag "${flag}"`, token);
        }

        dropped = true;
        continue;
      }

      seen.add(flag);
      flags.push(flag as RegexFlag);
    }

    const recovered =
      token.recovered ?? (dropped ? 'unsupported-modifier' : undefined);

    return {
      flags,
      location: span(token.start, token.end),
      // Preserved exactly as written: RegExp#source is lossy.
      pattern: token.pattern,
      ...(recovered === undefined
        ? {}
        : { recovered: { reason: recovered, synthetic: false } }),
      type: 'RegexExpression',
    };
  }

  /* ----------------------------------------------------------------------- *
   * Ranges
   * ----------------------------------------------------------------------- */

  private parseRange(): RangeExpression {
    const open = this.advance() as Extract<Token, { type: 'rangeOpen' }>;
    const lowerInclusive = open.delimiter === '[';

    const lower = this.parseRangeBoundary(lowerInclusive, 'lower');
    const to = this.peek();

    if (to.type !== 'to') {
      if (!this.tolerant) {
        this.fail('Expected "TO" between the range boundaries', to, ['"TO"']);
      }
    } else {
      this.advance();
    }

    const close = this.tokens[this.findRangeClose()];
    const upperInclusive =
      close?.type === 'rangeClose' ? close.delimiter === ']' : true;
    const upper = this.parseRangeBoundary(upperInclusive, 'upper');
    const closing = this.peek();

    if (closing.type !== 'rangeClose') {
      if (!this.tolerant) {
        this.fail('Unclosed range: expected "]" or "}"', closing, [
          '"]"',
          '"}"',
        ]);
      }

      return {
        location: span(open.start, upper.location.end),
        lower,
        recovered: { reason: RECOVERY_REASONS.unclosedRange, synthetic: false },
        type: 'RangeExpression',
        upper,
      };
    }

    this.advance();

    return {
      location: span(open.start, closing.end),
      lower,
      type: 'RangeExpression',
      upper,
    };
  }

  /** Look ahead for the closing bracket so the upper bound knows its inclusivity. */
  private findRangeClose(): number {
    for (let at = this.index; at < this.tokens.length; at += 1) {
      if (this.tokens[at]?.type === 'rangeClose') {
        return at;
      }
    }

    return -1;
  }

  private parseRangeBoundary(
    inclusive: boolean,
    side: 'lower' | 'upper',
  ): RangeBoundary {
    const token = this.peek();

    if (token.type !== 'literal') {
      if (this.tolerant) {
        // Search-as-you-type sees `a:[` on the way to a real range. Recovering
        // it as unbounded keeps the promise that a tolerant parse returns a
        // usable AST for incomplete input — always
        // returns a usable AST; the marker lets onRecovered refuse it.
        return {
          bounded: false,
          location: span(token.start, token.start),
          recovered: {
            reason: RECOVERY_REASONS.unclosedRange,
            synthetic: true,
          },
          type: 'RangeBoundary',
        };
      }

      return this.fail(`Expected the ${side} range boundary`, token, [
        'a value',
        '"*"',
      ]);
    }

    this.advance();

    const location = span(token.start, token.end);

    // A bare `*` is the unbounded marker. Quoted "*" is the one-character string,
    // which is why the quote check is not optional here.
    if (token.quote === 'none' && token.value === '*') {
      return { bounded: false, location, type: 'RangeBoundary' };
    }

    const quoted = token.quote !== 'none';
    const contentStart = quoted ? token.start + 1 : token.start;
    const scanned = scanPattern(token.value, contentStart);

    if (scanned.kind === 'wildcard') {
      /*
       * `a:[?` and `a:[x*` are what a range looks like part-way through being
       * typed, so tolerant mode takes the text LITERALLY and marks the boundary
       * rather than throwing. Strict mode still refuses: a wildcard has no
       * position on an ordered line, so a range built from one would be a guess
       * about ordering rather than about typing.
       */
      if (!this.tolerant) {
        return this.fail('A range boundary cannot contain wildcards', token, [
          'a value',
          '"*"',
        ]);
      }

      return {
        bounded: true,
        inclusive,
        location,
        recovered: {
          reason: RECOVERY_REASONS.missingValue,
          synthetic: false,
        },
        type: 'RangeBoundary',
        value: {
          literal: 'text',
          location,
          quoted,
          type: 'LiteralExpression',
          value: token.value,
        },
      };
    }

    return {
      bounded: true,
      inclusive,
      location,
      type: 'RangeBoundary',
      value: quoted
        ? {
            literal: 'text',
            location,
            quoted: true,
            type: 'LiteralExpression',
            value: scanned.value,
          }
        : {
            literal: 'text',
            location,
            quoted: false,
            type: 'LiteralExpression',
            value: scanned.value,
          },
    };
  }
}

/**
 * Parse a query string into an AST.
 *
 * Throws {@link SiftQLSyntaxError} on malformed input, carrying the offending
 * span and a caret excerpt — unless `tolerant` is set, in which case holes
 * become `MissingExpression` nodes and the result is usable for any input
 * that is merely incomplete or malformed. The structural limits above still
 * throw: they guard resources rather than describing a half-typed query.
 */
export const parse = (query: string, options: ParseOptions = {}): SiftQLAst => {
  const source = assertQuery(query, 'parse');
  // The SNAPSHOT, not `options`: reading the caller's object again after
  // validating it let a throwing accessor escape from here raw.
  const tolerant = assertOptions(options, 'parse').tolerant ?? false;
  const tokens = new Tokenizer(source, { tolerant }).tokenize();
  const ast = new Parser(source, tokens, tolerant).parse();

  /*
   * THE PARSER MUST NOT EMIT A TREE ITS OWN CONSUMERS WILL REFUSE.
   *
   * Per-clause caps cannot enforce that on their own: what expands is the
   * PRODUCT of clause count and segments per clause, so 2,000 clauses of
   * 512-segment wildcards is millions of visits whatever each individual cap
   * says. Checking the same budget here means a query is refused where it can
   * be pointed at, rather than accepted and then rejected by `serialize()`,
   * `filter()`, `test()` and `highlight()` alike — which is what happened, with
   * an error whose own text says "this is a defect in siftql".
   */
  if (expansionOf(ast, MAX_AST_NODES) > MAX_AST_NODES) {
    throw new SiftQLSyntaxError(
      `This query expands to more than ${String(MAX_AST_NODES)} AST nodes, which is more than serialize() and the evaluator will walk`,
      ast.location,
      source,
      { code: 'SYNTAX' },
    );
  }

  return ast;
};
