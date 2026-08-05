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
        readonly quote: QuoteKind;
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
      }
    | {
        readonly type: 'regex';
        /** The pattern body, without the delimiting slashes. */
        readonly pattern: string;
        /** Regex flags such as `i`, or an empty string. */
        readonly flags: string;
      }
    | { readonly type: 'rangeOpen'; readonly delimiter: '[' | '{' }
    | { readonly type: 'rangeClose'; readonly delimiter: '}' | ']' }
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

/** Narrowing helper for the parser. */
export const isTokenType = <TType extends Token['type']>(
  token: Token,
  type: TType,
): token is Extract<Token, { type: TType }> => token.type === type;
