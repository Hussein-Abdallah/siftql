import type {
  Expression,
  Field,
  RangeBoundary,
  SiftQLAst,
  TextLiteral,
  WildcardExpression,
} from './types.js';
import {
  OPERATOR_PRECEDENCE,
  RESERVED_CHARACTERS,
  rangeBracket,
} from './types.js';

/**
 * AST → query string.
 *
 * THE ROUND-TRIP LAW (I4): for every query the parser accepts,
 *
 *   parse(serialize(parse(q)))  deep-equals  parse(q)     ignoring `location`
 *
 * Note the law is about the AST, not the text. `serialize` is a CANONICALISER,
 * not an echo: it normalises exactly four things, each of which provably
 * carries no AST-visible information.
 *
 *   1. Whitespace runs between tokens.
 *   2. Redundant escapes — `\a` inside quotes means `a`, and prints as `a`.
 *   3. Quote style — `'x'` and `"x"` build identical nodes, and `"` is emitted.
 *   4. The bracket on an UNBOUNDED range end, since `{* TO 2]` and `[* TO 2]`
 *      are deep-equal (an unbounded boundary has no inclusivity at all).
 *
 * Everything else survives, including bare-vs-quoted, which is deliberately NOT
 * normalised because `quoted` is load-bearing: it decides fuzzy-vs-proximity
 * eligibility and whether `true` is a keyword or a four-character string.
 *
 * Parentheses are emitted for every explicit `ParenthesizedExpression` node AND
 * wherever precedence would otherwise reshape the tree — so an AST built by hand,
 * with no parenthesis nodes at all, still serializes to something that re-parses
 * to the same shape.
 */

/** Leaves and non-operator nodes bind tighter than any operator. */
const ATOM_PRECEDENCE = Number.POSITIVE_INFINITY;

const precedenceOf = (node: Expression): number => {
  if (node.type === 'LogicalExpression') {
    return OPERATOR_PRECEDENCE[node.operator.operator] ?? 0;
  }

  if (node.type === 'UnaryOperator') {
    return OPERATOR_PRECEDENCE[node.operator] ?? 0;
  }

  return ATOM_PRECEDENCE;
};

/**
 * Escape a bare term. Every reserved character gets a backslash, and a LEADING
 * `-` or `+` does too, since those are structural only in first position — which
 * is exactly what lets `2020-06-01` stay unquoted.
 */
const escapeBareTerm = (value: string): string => {
  let escaped = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const leadingMarker =
      index === 0 && (character === '-' || character === '+');

    if (RESERVED_CHARACTERS.has(character) || leadingMarker) {
      escaped += '\\';
    }

    escaped += character;
  }

  return escaped;
};

/**
 * Escape the inside of a quoted term. Quotes hold spaces and reserved characters
 * without ceremony, so only four characters need protecting: the delimiter, the
 * escape character itself, and the two wildcard metacharacters — which stay live
 * inside quotes and must therefore be escaped when they are meant literally.
 */
const escapeQuotedTerm = (value: string): string => {
  let escaped = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);

    if (
      character === '"' ||
      character === '\\' ||
      character === '*' ||
      character === '?'
    ) {
      escaped += '\\';
    }

    escaped += character;
  }

  return escaped;
};

const serializeTextLiteral = (node: TextLiteral): string =>
  node.quoted
    ? `"${escapeQuotedTerm(node.value)}"`
    : // A bare empty term has no spelling, so it is the one case where the
      // bare/quoted flag cannot survive; every other value round-trips.
      node.value.length === 0
      ? '""'
      : escapeBareTerm(node.value);

const serializeWildcard = (node: WildcardExpression): string => {
  const body = node.pattern
    .map((segment) => {
      switch (segment.type) {
        case 'WildcardAny':
          return '*';
        case 'WildcardSingle':
          return '?';
        default:
          return node.quoted
            ? escapeQuotedTerm(segment.value)
            : escapeBareTerm(segment.value);
      }
    })
    .join('');

  return node.quoted ? `"${body}"` : body;
};

/**
 * Escape an unquoted field segment.
 *
 * Identical to a bare term except that `.` is escaped too. A dot is NOT a
 * reserved character in a value — `height:1.50` must stay exactly that — but it
 * IS structural in a field name, so a key that literally contains one has to be
 * written `a\.b` or it comes back as the nested path `a` → `b`.
 */
const escapeFieldSegment = (name: string): string => {
  let escaped = '';

  for (let index = 0; index < name.length; index += 1) {
    const character = name.charAt(index);
    const leadingMarker =
      index === 0 && (character === '-' || character === '+');

    if (
      character === '.' ||
      RESERVED_CHARACTERS.has(character) ||
      leadingMarker
    ) {
      escaped += '\\';
    }

    escaped += character;
  }

  return escaped;
};

const serializeField = (field: Field): string =>
  field.segments
    .map((segment) =>
      segment.quoted
        ? `"${escapeQuotedTerm(segment.name)}"`
        : escapeFieldSegment(segment.name),
    )
    .join('.');

const serializeBoundary = (
  boundary: RangeBoundary,
  side: 'lower' | 'upper',
): string => {
  const bracket = rangeBracket(side, boundary);
  const value = boundary.bounded ? serializeTextLiteral(boundary.value) : '*';

  return side === 'lower' ? `${bracket}${value}` : `${value}${bracket}`;
};

const serializeNode = (node: SiftQLAst): string => {
  switch (node.type) {
    case 'EmptyExpression':
      return '';

    case 'LiteralExpression':
      return node.literal === 'text'
        ? serializeTextLiteral(node)
        : String(node.value);

    case 'LogicalExpression': {
      const precedence = precedenceOf(node);
      // Left-associative, so an equal-precedence RIGHT operand needs brackets
      // to keep its shape while an equal-precedence left operand does not.
      const left = wrap(node.left, precedenceOf(node.left) < precedence);
      const right = wrap(node.right, precedenceOf(node.right) <= precedence);

      return node.operator.notation === 'implicit'
        ? `${left} ${right}`
        : `${left} ${node.operator.operator} ${right}`;
    }

    case 'MissingExpression':
      // A hole has no text. Serializing a tolerant-mode AST therefore yields the
      // incomplete query the user was typing, which only re-parses in tolerant
      // mode -- the round-trip law is stated over queries the STRICT parser
      // accepts, and those never contain holes.
      return '';

    case 'ParenthesizedExpression':
      return `(${serializeNode(node.expression)})`;

    case 'RangeExpression':
      return `${serializeBoundary(node.lower, 'lower')} TO ${serializeBoundary(
        node.upper,
        'upper',
      )}`;

    case 'RegexExpression':
      return `/${node.pattern}/${node.flags.join('')}`;

    case 'Tag': {
      const colon = node.caseSensitive ? '::' : ':';
      // `:` is the match operator; the relational symbols already start with a
      // colon, so only their suffix is appended.
      const operator =
        node.operator.operator === ':' ? '' : node.operator.operator.slice(1);

      return `${serializeField(node.field)}${colon}${operator}${serializeNode(
        node.expression,
      )}`;
    }

    case 'UnaryOperator': {
      const operand = wrap(
        node.operand,
        precedenceOf(node.operand) < precedenceOf(node),
      );

      // `NOT` is a word and needs a space; `-` is a sigil and must not have one.
      return node.operator === 'NOT' ? `NOT ${operand}` : `-${operand}`;
    }

    case 'WildcardExpression':
      return serializeWildcard(node);

    default:
      return '';
  }
};

const wrap = (node: Expression, needsBrackets: boolean): string => {
  const text = serializeNode(node);

  return needsBrackets ? `(${text})` : text;
};

/**
 * Serialize an AST back to a query string.
 *
 * The result always re-parses to a deep-equal AST (locations aside). It is not
 * guaranteed to be byte-identical to the text originally parsed — see the
 * normalisation list above.
 */
export const serialize = (ast: SiftQLAst): string => serializeNode(ast);
