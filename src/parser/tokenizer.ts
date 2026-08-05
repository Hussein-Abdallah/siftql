import { SiftQLSyntaxError } from '../errors.js';
import { isSafeUnquotedExpression } from '../types.js';
import type { ComparisonOperator, QuoteKind, Token } from './tokens.js';

/**
 * Hand-written, mode-switching tokenizer. No parser generator is involved.
 *
 * The interesting problem is the colon. In `name:foo` it separates a field from
 * a value; in `date:>=2020-06-01T00:00:00Z` the first colon separates and the
 * remaining two belong to the value. A context-free "split on colon" lexer
 * mangles every ISO date-time, which is why other implementations make users
 * quote them.
 *
 * The tokenizer therefore runs in one of three modes:
 *
 * - `default` — the operator/term level. A colon here ends a field name.
 * - `value`   — entered immediately after a comparison operator. A colon here is
 *               an ordinary character, so date-times need no quoting.
 * - `range`   — between `[`/`{` and `]`/`}`. Colons are ordinary here too, and
 *               the bare word `TO` is recognised as the range separator.
 *
 * Modes are driven purely by what has already been emitted, so the tokenizer
 * stays a single left-to-right pass with no backtracking.
 */

type Mode = 'default' | 'range' | 'value';

export interface TokenizerOptions {
  /**
   * Best-effort tokenizing for incomplete input, for search-as-you-type. An
   * unterminated quote or regex consumes to end of input instead of throwing.
   */
  readonly tolerant?: boolean | undefined;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/**
 * Characters that end a bare word at the operator level.
 *
 * `^` and `~` are reserved here even though boost and fuzzy are not implemented
 * yet. Reserving them now means adding those operators later is additive; if
 * they were legal word characters in 0.1, `foo^2` would change meaning in 0.2
 * and that would be a breaking change.
 */
const DEFAULT_TERMINATORS = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ':',
  '"',
  "'",
  '^',
  '~',
]);

/**
 * Characters that end a bare word inside a value or a range.
 *
 * Colon is absent by design — that is the whole point of the mode. Slash is
 * absent too, so `2020/06/01` stays one token; a regex is only recognised when
 * the slash is the *first* character of the term.
 */
const VALUE_TERMINATORS = new Set(['(', ')', ']', '}', '"', "'", '^', '~']);

const isWhitespace = (character: string): boolean => WHITESPACE.has(character);

const RECOVERED_QUOTE = 'unterminated-quote';
const RECOVERED_REGEX = 'unterminated-regex';

/**
 * Split an unquoted field name on its dots, honouring backslash escapes.
 *
 * A plain `name.split('.')` would tear `a\.b` into `['a\\', 'b']`, turning one
 * field whose key literally contains a dot into a nested path — and since
 * serialize() emits exactly that escape for such a key, the round trip would
 * not survive it. Escapes are left in place here; the parser decodes them.
 */
const splitFieldPath = (name: string): string[] => {
  const segments: string[] = [];

  let current = '';
  let index = 0;

  while (index < name.length) {
    const character = name.charAt(index);

    if (character === '\\' && index + 1 < name.length) {
      current += character + name.charAt(index + 1);
      index += 2;
      continue;
    }

    if (character === '.') {
      segments.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  segments.push(current);

  return segments;
};

export class Tokenizer {
  private readonly source: string;

  private readonly tolerant: boolean;

  private index = 0;

  private mode: Mode = 'default';

  /**
   * Tokens produced ahead of time. Reading a field name necessarily consumes the
   * comparison operator that follows it — that is how the tokenizer knows to
   * switch into value mode — so the operator is queued here and emitted on the
   * next call rather than being lost.
   */
  private readonly pending: Token[] = [];

  /**
   * The most recent `field:` prefix exactly as written, e.g. `status:` or
   * `'work status':>=`. Used only to phrase the suggestion in
   * {@link failMissingValue}; `null` until a field has been read.
   */
  private lastClausePrefix: string | null = null;

  public constructor(source: string, options: TokenizerOptions = {}) {
    this.source = source;
    this.tolerant = options.tolerant ?? false;
  }

  /** Consume the whole input. The final token is always `eof`. */
  public tokenize(): Token[] {
    const tokens: Token[] = [];

    for (;;) {
      const token = this.nextToken();

      tokens.push(token);

      if (token.type === 'eof') {
        return tokens;
      }
    }
  }

  private peek(offset = 0): string {
    return this.source.charAt(this.index + offset);
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && isWhitespace(this.peek())) {
      this.index += 1;
    }
  }

  private fail(message: string, start: number, end: number): never {
    throw new SiftQLSyntaxError(message, { end, start }, this.source);
  }

  /**
   * A space between a comparison operator and its value ends the clause, so
   * `status: in progress` would quietly become `status:in AND progress` and
   * match nothing. That is far more often a typo than an intent, so it is
   * refused — with the query the user probably meant.
   */
  private failMissingValue(): never {
    const start = this.index;
    const rest = this.source.slice(start).trimStart();
    // Suggest quoting up to the next boolean keyword, which is where the
    // intended value almost certainly ends.
    const clause = (rest.split(/\s+(?:AND|OR|NOT)\s+/u)[0] ?? '').trim();
    // Only quote the suggestion if the value actually needs it, so a stray
    // space before a number suggests `height:>=100`, not `height:>="100"`.
    const suggested = isSafeUnquotedExpression(clause)
      ? clause
      : JSON.stringify(clause);
    const hint =
      clause.length > 0 && this.lastClausePrefix !== null
        ? ` Did you mean ${this.lastClausePrefix}${suggested}?`
        : '';

    throw new SiftQLSyntaxError(
      `Expected a value immediately after the operator; a space here ends the clause.${hint}`,
      { end: start + 1, start },
      this.source,
      { expected: ['a value'] },
    );
  }

  private nextToken(): Token {
    const queued = this.pending.shift();

    if (queued) {
      return queued;
    }

    if (
      this.mode === 'value' &&
      this.index < this.source.length &&
      isWhitespace(this.peek())
    ) {
      if (this.tolerant) {
        // Search-as-you-type: recover rather than refuse, and let the parser
        // record a missing value.
        this.mode = 'default';
      } else {
        return this.failMissingValue();
      }
    }

    this.skipWhitespace();

    const start = this.index;

    if (this.index >= this.source.length) {
      return { end: start, start, type: 'eof' };
    }

    switch (this.mode) {
      case 'range':
        return this.readRangeToken(start);
      case 'value':
        return this.readValueToken(start);
      default:
        return this.readDefaultToken(start);
    }
  }

  private readDefaultToken(start: number): Token {
    const character = this.peek();

    switch (character) {
      case '(':
        this.index += 1;

        return { end: this.index, start, type: 'lparen' };
      case ')':
        this.index += 1;

        return { end: this.index, start, type: 'rparen' };
      case '[':
      case '{':
        this.index += 1;
        this.mode = 'range';

        return {
          delimiter: character,
          end: this.index,
          start,
          type: 'rangeOpen',
        };
      case ']':
      case '}':
        this.index += 1;

        return {
          delimiter: character,
          end: this.index,
          start,
          type: 'rangeClose',
        };
      case '-':
        this.index += 1;

        return { end: this.index, start, type: 'prohibit' };
      case '+':
        this.index += 1;

        return { end: this.index, start, type: 'require' };
      case '/':
        return this.readRegex(start);
      case '"':
      case "'":
        return this.readQuotedTerm(start, character);
      default:
        return this.readBareTerm(start);
    }
  }

  /**
   * A value position accepts a nested group, a range, a regex, a quoted term, or
   * a bare term in which colons are ordinary characters.
   */
  private readValueToken(start: number): Token {
    const character = this.peek();

    switch (character) {
      case '(':
        this.index += 1;
        this.mode = 'default';

        return { end: this.index, start, type: 'lparen' };
      case '[':
      case '{':
        this.index += 1;
        this.mode = 'range';

        return {
          delimiter: character,
          end: this.index,
          start,
          type: 'rangeOpen',
        };
      case '/':
        this.mode = 'default';

        return this.readRegex(start);
      case '"':
      case "'": {
        this.mode = 'default';

        return this.readQuotedLiteral(start, character);
      }
      default: {
        this.mode = 'default';

        return this.readBareLiteral(start);
      }
    }
  }

  private readRangeToken(start: number): Token {
    const character = this.peek();

    if (character === ']' || character === '}') {
      this.index += 1;
      this.mode = 'default';

      return {
        delimiter: character,
        end: this.index,
        start,
        type: 'rangeClose',
      };
    }

    if (character === '"' || character === "'") {
      return this.readQuotedLiteral(start, character);
    }

    const literal = this.readBareLiteral(start);

    // `TO` is only a keyword inside a range, and only when written bare and
    // uppercase, so a quoted value of "TO" remains a value.
    if (literal.value === 'TO') {
      return { end: literal.end, start: literal.start, type: 'to' };
    }

    return literal;
  }

  /**
   * Read a word, then decide what it is. A word followed immediately by `:` is a
   * field name; otherwise it is a bare term or a boolean keyword.
   *
   * A dot may be followed by a QUOTED segment — `a.'b':c` addresses the key `b`
   * nested under `a`. The quoted part is folded back into the bare form with its
   * dots escaped, so the existing splitter and the parser's decoder handle it
   * with no special case: `a.'b.c'` becomes `a.b\.c`, which splits into exactly
   * two segments. Without this the scan stopped at the quote and the whole thing
   * silently became two separate clauses.
   */
  private readBareTerm(start: number): Token {
    let word = this.readWord(DEFAULT_TERMINATORS);

    while (word.endsWith('.') && (this.peek() === '"' || this.peek() === "'")) {
      const segment = this.readQuoted(this.index, this.peek());

      // Escape the segment's own dots so it stays ONE path step.
      word += segment.value.replace(/\./gu, String.raw`\.`);
      word += this.readWord(DEFAULT_TERMINATORS);
    }

    if (word.length === 0) {
      this.index += 1;

      return this.fail(
        `Unexpected character ${JSON.stringify(this.peek(-1))}`,
        start,
        this.index,
      );
    }

    if (this.peek() === ':') {
      return this.finishField(start, word, 'none');
    }

    switch (word) {
      case 'AND':
        return { end: this.index, start, type: 'and' };
      case 'OR':
        return { end: this.index, start, type: 'or' };
      case 'NOT':
        return { end: this.index, start, type: 'not' };
      default:
        return {
          end: this.index,
          quote: 'none',
          start,
          type: 'literal',
          value: word,
        };
    }
  }

  /** A quoted word is either a quoted field name or a case-sensitive term. */
  private readQuotedTerm(start: number, quoteCharacter: string): Token {
    const { quote, recovered, value } = this.readQuoted(start, quoteCharacter);

    if (this.peek() === ':') {
      return this.finishField(start, value, quote);
    }

    return recovered === true
      ? {
          end: this.index,
          quote,
          recovered: RECOVERED_QUOTE,
          start,
          type: 'literal',
          value,
        }
      : { end: this.index, quote, start, type: 'literal', value };
  }

  private finishField(start: number, name: string, quote: QuoteKind): Token {
    const fieldEnd = this.index;
    const { caseSensitive, operator } = this.readComparisonOperator();

    this.mode = 'value';
    this.lastClausePrefix = this.source.slice(start, this.index);

    // A quoted name is never split, so a literal key containing a dot stays
    // addressable as 'user.name' while user.name walks into a nested object.
    const path = quote === 'none' ? splitFieldPath(name) : [name];

    this.pending.push({
      caseSensitive,
      end: this.index,
      operator,
      start: fieldEnd,
      type: 'comparison',
    });

    return { end: fieldEnd, name, path, quote, start, type: 'field' };
  }

  /**
   * Read the operator that follows a field name.
   *
   * A DOUBLED colon makes the whole clause case-sensitive: `status::Active`,
   * `name::>=M`, `version::[a TO z]`. Case is a property of the comparison, not
   * of the operand, so it rides here rather than on the value — which is what
   * keeps `height::[a TO z]` from being able to express two different
   * collations for its two boundaries.
   *
   * Longest match first throughout, so `::>=` beats `::>` beats `::`, and
   * `:>=` beats `:>` beats `:`.
   */
  private readComparisonOperator(): {
    caseSensitive: boolean;
    operator: ComparisonOperator;
  } {
    const caseSensitive = this.source.startsWith('::', this.index);

    // Skip the extra colon so the suffix table below is shared by both forms.
    if (caseSensitive) {
      this.index += 1;
    }

    for (const candidate of [':>=', ':<=', ':=', ':>', ':<'] as const) {
      if (this.source.startsWith(candidate, this.index)) {
        this.index += candidate.length;

        return { caseSensitive, operator: candidate };
      }
    }

    this.index += 1;

    return { caseSensitive, operator: ':' };
  }

  private readBareLiteral(start: number): Extract<Token, { type: 'literal' }> {
    const word = this.readWord(VALUE_TERMINATORS);

    if (word.length === 0) {
      this.index += 1;

      return this.fail(
        `Expected a value but found ${JSON.stringify(this.peek(-1))}`,
        start,
        this.index,
      );
    }

    return {
      end: this.index,
      quote: 'none',
      start,
      type: 'literal',
      value: word,
    };
  }

  private readQuotedLiteral(
    start: number,
    quoteCharacter: string,
  ): Extract<Token, { type: 'literal' }> {
    const { quote, recovered, value } = this.readQuoted(start, quoteCharacter);

    return recovered === true
      ? {
          end: this.index,
          quote,
          recovered: RECOVERED_QUOTE,
          start,
          type: 'literal',
          value,
        }
      : { end: this.index, quote, start, type: 'literal', value };
  }

  /**
   * Read a bare word, honouring backslash escapes.
   *
   * An escaped character is part of the word even when it would otherwise end
   * it, which is what makes `status:in\ progress` a single value and
   * `name:foo\*bar` a literal asterisk rather than a wildcard. The backslashes
   * are LEFT IN the returned text: only the parser can decode them, because it
   * is the parser that must tell an escaped `\*` from a wildcard `*` when it
   * segments the pattern. Decoding here would erase that distinction.
   */
  private readWord(terminators: ReadonlySet<string>): string {
    const start = this.index;

    while (this.index < this.source.length) {
      const character = this.peek();

      if (character === '\\') {
        // A trailing backslash protects nothing; stepping two would index past
        // the end of the source.
        this.index += this.index + 1 < this.source.length ? 2 : 1;
        continue;
      }

      if (isWhitespace(character) || terminators.has(character)) {
        break;
      }

      this.index += 1;
    }

    return this.source.slice(start, this.index);
  }

  private readQuoted(
    start: number,
    quoteCharacter: string,
  ): { quote: QuoteKind; recovered?: boolean; value: string } {
    // Skip the opening quote.
    this.index += 1;

    let value = '';

    while (this.index < this.source.length) {
      const character = this.peek();

      if (character === '\\') {
        // Escapes are preserved VERBATIM, backslash included, for the same
        // reason bare words preserve them: only the parser can tell an escaped
        // `\*` from a wildcard `*`. Decoding `\\` to a single backslash here
        // would make `"a\\*b"` ambiguous between "literal backslash then
        // wildcard" and "literal asterisk". The escape is still consumed as a
        // unit so an escaped quote does not end the string.
        //
        // A TRAILING lone backslash has nothing to protect, so consuming two
        // characters walked the index past the end and produced a span longer
        // than the source.
        if (this.index + 1 >= this.source.length) {
          value += character;
          this.index += 1;
          break;
        }

        value += character + this.peek(1);
        this.index += 2;
        continue;
      }

      if (character === quoteCharacter) {
        this.index += 1;

        return { quote: quoteCharacter === '"' ? 'double' : 'single', value };
      }

      value += character;
      this.index += 1;
    }

    if (this.tolerant) {
      // Search-as-you-type: `name:"bar` is a usable prefix, not a failure --
      // but it MUST be marked, or `onRecovered` cannot see that anything was
      // invented and a half-typed quote silently becomes a real clause.
      return {
        quote: quoteCharacter === '"' ? 'double' : 'single',
        recovered: true,
        value,
      };
    }

    return this.fail('Unterminated quoted string', start, this.index);
  }

  private readRegex(start: number): Token {
    // Skip the opening slash.
    this.index += 1;

    let pattern = '';
    let inCharacterClass = false;

    while (this.index < this.source.length) {
      const character = this.peek();

      if (character === '\\') {
        // A backslash escapes whatever follows, including a slash or a bracket,
        // and both characters are kept so the pattern is preserved verbatim.
        pattern += character + this.peek(1);
        this.index += 2;
        continue;
      }

      if (character === '[') {
        inCharacterClass = true;
      } else if (character === ']') {
        inCharacterClass = false;
      } else if (character === '/' && !inCharacterClass) {
        // An unescaped slash inside a character class is legal in ES2015+ and
        // does not close the literal, so the class state is tracked.
        this.index += 1;

        const flags = this.readWord(DEFAULT_TERMINATORS);

        return { end: this.index, flags, pattern, start, type: 'regex' };
      }

      pattern += character;
      this.index += 1;
    }

    if (this.tolerant) {
      return {
        end: this.index,
        flags: '',
        pattern,
        recovered: RECOVERED_REGEX,
        start,
        type: 'regex',
      };
    }

    return this.fail('Unterminated regular expression', start, this.index);
  }
}
