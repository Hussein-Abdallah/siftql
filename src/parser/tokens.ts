import type { SourceLocation } from '../errors.js';

/**
 * The token stream produced by the tokenizer.
 *
 * Tokens are a discriminated union on `type`, so the parser cannot read a field
 * that does not exist on the token it is holding. Quoting is modelled as an
 * explicit `quote` kind rather than an optional flag: `'none'` is a real state
 * that changes matching behaviour (bare terms are case-insensitive, quoted terms
 * are not), so it deserves to be named rather than inferred from absence.
 */

/** How a term was written. Bare terms match case-insensitively. */
/** One step of a field path, as the tokenizer saw it. */
export interface FieldSegmentToken {
  /** Decoded: escapes resolved, quotes removed. */
  readonly name: string;
  readonly quoted: boolean;
  /** Half-open span in the original query, quotes included when present. */
  readonly start: number;
  readonly end: number;
}

export type QuoteKind = 'double' | 'none' | 'single';

/** The comparison operators that may follow a field name. */
export type ComparisonOperator = ':' | ':<' | ':<=' | ':=' | ':>' | ':>=';

/** Boundary characters for ranges. `[`/`]` are inclusive, `{`/`}` exclusive. */
export type RangeDelimiter = '[' | '{' | '}' | ']';

export type Token = SourceLocation &
  (
    | {
        readonly type: 'field';
        /** The field as written, without quotes. */
        readonly name: string;
        /**
         * Dot-separated segments of `name`, for nested lookup. A quoted field is
         * never split, so `'user.name'` addresses a literal key containing a dot
         * while `user.name` addresses a nested one.
         */
        readonly path: readonly string[];
        /**
         * One entry per path step, DECODED, with its true span in the source and
         * its own `quoted` flag.
         *
         * `path` carries the names and nothing else, so the parser had to
         * reconstruct spans by walking a cursor forward by `name.length + 1` —
         * which assumes the decoded name occupies exactly its own length in the
         * source. That is false the moment a segment is quoted or contains an
         * escape: `'full name'.first` reported its first segment as `'full nam`
         * and its second as `'.fir`, so every caret and highlight built from
         * those spans pointed at the wrong characters. It also had one `quoted`
         * flag for the whole token, so the per-segment quoting `types.ts` calls
         * load-bearing was always reported as `false`.
         */
        readonly segments: readonly FieldSegmentToken[];
        readonly quote: QuoteKind;
        /**
         * Set when tolerant mode invented a closing quote inside the field PATH —
         * `name.'first:ada`. Without it the recovery was invisible and the clause
         * looked like a deliberate full-text search for `name.first:ada`.
         */
        readonly recovered?: string;
      }
    | {
        readonly type: 'comparison';
        readonly operator: ComparisonOperator;
        /**
         * True when the operator was written with a doubled colon (`::`,
         * `::>=`, …), which makes the whole clause respect capitalisation.
         * Quoting does NOT affect case; it only holds a value together.
         */
        readonly caseSensitive: boolean;
      }
    | {
        readonly type: 'literal';
        /** The term as written, without surrounding quotes. */
        readonly value: string;
        readonly quote: QuoteKind;
        /** Set when tolerant mode invented the closing quote. */
        readonly recovered?: string;
      }
    | {
        readonly type: 'regex';
        /** The pattern body, without the delimiting slashes. */
        readonly pattern: string;
        /** Regex flags such as `i`, or an empty string. */
        readonly flags: string;
        /** Set when tolerant mode invented the closing slash. */
        readonly recovered?: string;
      }
    | { readonly type: 'rangeOpen'; readonly delimiter: '[' | '{' }
    | { readonly type: 'rangeClose'; readonly delimiter: '}' | ']' }
    | {
        /**
         * `^boost` or `~fuzzy`/`~proximity`. Reserved for v0.2, so no node exists
         * for them — but they get a TOKEN rather than an "unexpected character",
         * because `types.ts` and `errors.ts` both promise the parser reports them
         * as `UNSUPPORTED_SYNTAX`, and a consumer branching on that code to say
         * "not supported yet" was getting a generic `SYNTAX` instead.
         */
        readonly type: 'modifier';
        readonly sigil: '^' | '~';
        /** The modifier as written, including any numeric argument: `^2`, `~0.8`. */
        readonly raw: string;
      }
    | { readonly type: 'and' }
    | { readonly type: 'eof' }
    | { readonly type: 'lparen' }
    | { readonly type: 'not' }
    | { readonly type: 'or' }
    | { readonly type: 'prohibit' }
    | { readonly type: 'require' }
    | { readonly type: 'rparen' }
    | { readonly type: 'to' }
  );
