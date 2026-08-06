import { SiftQLSyntaxError } from '../errors.js';
import { isSafeUnquotedExpression } from '../types.js';
import { decodeEscapes } from './pattern.js';
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

/**
 * Characters that end a bare word inside a FIELD GROUP body.
 *
 * Colon is absent, exactly as in a value: a group body is a list of values for
 * the field already named, and the grammar has no `Tag` inside a group — so no
 * colon in there can be starting a field name. Reading the body in default mode
 * meant the first colon did start one, and `d:(14:30)` was refused as "a field
 * group may not contain another field" while `d:14:30` and `d:[14:30 TO 15:00]`
 * both worked. The tokenizer's whole reason for having modes is that a date-time
 * needs no quoting, and this was the one position where that silently failed.
 *
 * SO A COLON IN A BODY IS ALWAYS PART OF A VALUE, with no exception. An earlier
 * attempt kept a heuristic in the parser to catch `name:(first:ada)` — a nested
 * field, which the grammar cannot express — by testing whether the text before
 * the colon looked like a field name. It could not work: `14:30` and `a:b` are
 * the same shape, so any rule that refuses one refuses the other. What shipped
 * refused `note:json` and accepted `content-type:json`, making the diagnostic
 * depend on whether the name happened to contain a hyphen, and refusing
 * `http://example.com` outright.
 *
 * `name:(first:ada)` is therefore a search for the literal text `first:ada`.
 * That is what the grammar says, it is what `name:"first:ada"` already meant,
 * and it is the same answer for every value — which a heuristic could never be.
 *
 * `[` and `{` ARE terminators here, unlike in a plain value, so a range still
 * works inside a group: `n:([1 TO 9] OR 20)`.
 */
const GROUP_TERMINATORS = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '"',
  "'",
  '^',
  '~',
]);

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
   * Open parentheses that are inside a field group, the group's own paren
   * included. Tracked here rather than in the parser because the decision it
   * drives — whether a colon separates a field — is made while LEXING.
   */
  private groupDepth = 0;

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

        // Only counted when already inside a field group, so the matching `)`
        // brings the depth back down in step.
        if (this.groupDepth > 0) {
          this.groupDepth += 1;
        }

        return { end: this.index, start, type: 'lparen' };
      case ')':
        this.index += 1;

        if (this.groupDepth > 0) {
          this.groupDepth -= 1;
        }

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
      case '^':
      case '~':
        return this.readModifier(start, character);
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
        // This paren OPENS a field group; everything until its match is a value
        // list for the field just named.
        this.groupDepth += 1;

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

        // `null` means "this is not a value at all"; re-dispatch in default mode,
        // where the offending character is read as whatever it really is.
        return this.readBareLiteral(start) ?? this.readDefaultToken(start);
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

    // Inside a RANGE, a position that cannot start a value is read in default
    // mode, where `]` and `}` close the range and anything else is refused by the
    // parser as a missing boundary.
    if (literal === null) {
      return this.readDefaultToken(start);
    }

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
  private readBareTerm(start: number, prefix = ''): Token {
    // Inside a field group a colon is an ordinary character; see
    // GROUP_TERMINATORS.
    const inGroup = this.groupDepth > 0;

    let word =
      prefix + this.readWord(inGroup ? GROUP_TERMINATORS : DEFAULT_TERMINATORS);
    // A folded segment may itself have been recovered — an unclosed quote. The
    // flag has to survive to the field token, or `onRecovered` cannot see that
    // anything was invented and `name.'first:ada` silently becomes a full-text
    // scan for the literal `name.first:ada`.
    let recovered: string | undefined;

    while (word.endsWith('.') && (this.peek() === '"' || this.peek() === "'")) {
      const segment = this.readQuoted(this.index, this.peek());

      recovered ??= segment.recovered === true ? RECOVERED_QUOTE : undefined;

      /*
       * DECODE, then re-escape. `segment.value` is raw source text with its
       * escapes intact, so escaping only its dots ran over the top of them:
       * `a.'b\.c'` became `a.b\\.c`, whose `\\` splitFieldPath consumed as an
       * escaped backslash — leaving the `.` unprotected and yielding three
       * segments, one of them a literal backslash. Decoding first means the
       * segment is plain text, and escaping both metacharacters keeps it one
       * path step whatever it contains.
       */
      word += decodeEscapes(segment.value).replace(
        /[\\.]/gu,
        (character) => `\\${character}`,
      );
      word += this.readWord(inGroup ? GROUP_TERMINATORS : DEFAULT_TERMINATORS);
    }

    if (word.length === 0) {
      this.index += 1;

      return this.fail(
        `Unexpected character ${JSON.stringify(this.peek(-1))}`,
        start,
        this.index,
      );
    }

    // Never a field inside a group: the colon was already read as part of `word`.
    if (!inGroup && this.peek() === ':') {
      return this.finishField(start, word, 'none', recovered);
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
          // A quote invented while folding a path segment. The colon that would
          // have made this a FIELD was swallowed by the unterminated quote, so
          // `name.'first:ada` arrives here as a bare term — and unmarked, it
          // looked like a deliberate full-text search rather than a half-typed
          // field, which `onRecovered: 'throw'` then accepted.
          ...(recovered === undefined ? {} : { recovered }),
        };
    }
  }

  /** A quoted word is either a quoted field name or a case-sensitive term. */
  private readQuotedTerm(start: number, quoteCharacter: string): Token {
    const { quote, recovered, value } = this.readQuoted(start, quoteCharacter);

    if (this.peek() === ':') {
      return this.finishField(start, value, quote);
    }

    /*
     * A quoted FIRST segment of a dotted path: `'full name'.first:x`.
     *
     * `types.ts` documents this spelling, and it did not work — the scan stopped
     * at the closing quote, so it became two clauses (`"full name"` AND
     * `.first:x`) joined by an implicit AND, which matched nothing and reported
     * nothing wrong. `a.'b c':x` worked, because the bare-term reader folds a
     * quoted segment that FOLLOWS a dot; only a leading one was unreachable.
     *
     * The quoted text is escaped rather than passed through, so a key that
     * contains a dot stays one segment — the same treatment `readBareTerm` gives a
     * folded segment, for the same reason.
     */
    if (this.peek() === '.') {
      /*
       * MAYBE a dotted path — `'full name'.first:x` — and maybe not.
       *
       * The delegation below was unconditional, which was wrong: it fired on
       * `"foo bar".baz`, where no colon ever arrives, and turned two clauses
       * into a single BARE literal whose value contained a space. The `quoted`
       * flag was destroyed with them, and no other code path can produce that
       * node.
       *
       * So it is attempted and BACKTRACKED. Nothing is committed until the
       * bare-term reader comes back with a `field`, which it only does when it
       * ends at a colon; `finishField` is the sole place that queues the pending
       * comparison token or switches mode, so a rejected attempt leaves no trace
       * to undo beyond the index.
       */
      const resume = this.index;
      const attempt = this.readBareTerm(
        start,
        value.replace(/[\\.]/gu, (character) => `\\${character}`),
      );

      if (attempt.type === 'field') {
        return attempt;
      }

      this.index = resume;
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

  private finishField(
    start: number,
    name: string,
    quote: QuoteKind,
    recovered?: string,
  ): Token {
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

    return {
      end: fieldEnd,
      name,
      path,
      quote,
      start,
      type: 'field',
      ...(recovered === undefined ? {} : { recovered }),
    };
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

  private readBareLiteral(
    start: number,
  ): Extract<Token, { type: 'literal' }> | null {
    const word = this.readWord(VALUE_TERMINATORS);

    if (word.length === 0) {
      /*
       * A value position holding something that cannot start a value: `a:)`,
       * `a:^`, `(a:)`.
       *
       * Strict mode refuses. TOLERANT mode returns `null` WITHOUT consuming the
       * character, so the caller re-reads it in default mode — the `)` becomes an
       * rparen, the parser records a missing value, and the stray closer is
       * ignored as trailing input. Consuming it and failing meant `(a:)`, which is
       * one deleted character away from `(a:b)`, threw in the mode whose entire
       * purpose is to survive half-typed input.
       */
      if (this.tolerant) {
        return null;
      }

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

  /**
   * `^2`, `~`, `~0.8` — the sigil plus any numeric argument, as one token.
   *
   * The argument is consumed even though nothing reads it, so tolerant mode can
   * drop the whole modifier in one step instead of leaving `2` behind to be
   * parsed as a separate term — which would silently turn `foo^2` into `foo AND
   * 2`.
   */
  private readModifier(start: number, sigil: '^' | '~'): Token {
    this.index += 1;

    let raw = sigil;

    while (this.index < this.source.length && /[\d.]/u.test(this.peek())) {
      raw += this.peek();
      this.index += 1;
    }

    return { end: this.index, raw, sigil, start, type: 'modifier' };
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
        //
        // A TRAILING lone backslash has nothing to protect, and consuming two
        // characters for it walked the index past the end: `/a\\` reported a span
        // of four over a three-character source, so a caret excerpt printed four
        // markers and any consumer slicing the source got a range that did not
        // exist. `readQuoted` guards this the same way.
        if (this.index + 1 >= this.source.length) {
          pattern += character;
          this.index += 1;
          break;
        }

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
