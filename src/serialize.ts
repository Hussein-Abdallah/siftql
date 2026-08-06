import { SiftQLArgumentError } from './errors.js';
import { MAX_AST_DEPTH } from './limits.js';
import { assertNode } from './validate.js';
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
  RESERVED_WORDS,
  rangeBracket,
} from './types.js';

/**
 * Bare words the parser turns into typed literals rather than text. A
 * TextLiteral carrying one of these must be escaped or it changes type on the
 * way back in.
 */
const KEYWORD_LITERALS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
]);

/**
 * AST → query string.
 *
 * THE ROUND-TRIP LAW (I4): for every query the parser accepts,
 *
 *   parse(serialize(parse(q)))  deep-equals  parse(q)     ignoring `location`
 *
 * Note the law is about the AST, not the text. `serialize` is a CANONICALISER,
 * not an echo: it normalises exactly five things — the same five `types.ts`
 * lists, which this said were four — each of which provably
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

type LogicalNode = Extract<Expression, { type: 'LogicalExpression' }>;

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
 * Which characters a bare term must escape, and it depends on WHERE the term
 * sits — because the tokenizer reads the two positions in different modes.
 *
 *   TERM position   (`foo`, unfielded)      a colon would start a field name
 *   VALUE position  (after `status:`)       a colon is an ordinary character
 *
 * That asymmetry is the whole reason `createdAt:>=2020-06-01T12:00:00+02:00`
 * needs no quoting: escaping its colons would be not just noisy but a claim
 * about the grammar that is false in that position.
 *
 * Some characters are structural only in FIRST position — a leading `-` is
 * negation, a leading `/` opens a regex — which is exactly what lets an
 * interior hyphen stay bare and keeps `2020-06-01` readable.
 */
type TermPosition = 'term' | 'value';

// Every character below is ASCII punctuation or whitespace, so there is no
// grapheme cluster or surrogate pair for the spread to split.
// eslint-disable-next-line @typescript-eslint/no-misused-spread
const ALWAYS_ESCAPED = new Set([...' \t\n\r\f\v()]}"\'\\^~*?']);

/** Structural only at the operator level, ordinary once inside a value. */
const TERM_ONLY_ESCAPED = new Set([':', '[', '{', '<', '>', '=']);

/**
 * Structural only in FIRST position, and the set differs by context.
 *
 * In value position the tokenizer decides what a term IS from its first
 * character: `/` opens a regex, `[`/`{` open a range, and `:`/`=`/`<`/`>`
 * would have been consumed as part of the operator. Leaving any of them
 * unescaped turns a match clause into a different clause entirely, or into
 * something that no longer parses.
 */
const LEADING_ONLY = {
  term: new Set(['-', '+', '/']),
  value: new Set(['/', '[', '{', ':', '=', '<', '>']),
};

const escapeBareTerm = (
  value: string,
  position: TermPosition = 'value',
): string => {
  // A term whose whole text is a grammar keyword or a typed literal cannot be
  // written bare: `AND` would restructure the query, `true` would come back as
  // the boolean rather than the four-character string. Escaping the first
  // character is enough to make the tokenizer read it as an ordinary word,
  // and it survives the round trip because the parser strips the backslash.
  if (RESERVED_WORDS.has(value) || KEYWORD_LITERALS.has(value)) {
    return `\\${value}`;
  }

  let escaped = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);

    const needsEscape =
      ALWAYS_ESCAPED.has(character) ||
      (position === 'term' && TERM_ONLY_ESCAPED.has(character)) ||
      (index === 0 && LEADING_ONLY[position].has(character));

    if (needsEscape) {
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

const serializeTextLiteral = (
  node: TextLiteral,
  position: TermPosition = 'value',
): string =>
  node.quoted
    ? `"${escapeQuotedTerm(node.value)}"`
    : // A bare empty term has no spelling, so it is the one case where the
      // bare/quoted flag cannot survive; every other value round-trips.
      node.value.length === 0
      ? '""'
      : escapeBareTerm(node.value, position);

const serializeWildcard = (
  node: WildcardExpression,
  position: TermPosition = 'value',
): string => {
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
            : escapeBareTerm(segment.value, position);
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

/**
 * An EMPTY segment name is printed as `""`.
 *
 * Unquoted it printed nothing at all, so a Field whose only segment was empty
 * serialized to `:value` — which is not a query and does not re-parse, breaking
 * the round-trip law for a tree the AST contract permits. `a..b` keeps working
 * either way, since a quoted empty segment re-parses to the same empty step.
 */
const serializeField = (field: Field): string =>
  field.segments
    .map((segment) =>
      segment.quoted || segment.name.length === 0
        ? `"${escapeQuotedTerm(segment.name)}"`
        : escapeFieldSegment(segment.name),
    )
    .join('.');

const serializeBoundary = (
  boundary: RangeBoundary,
  side: 'lower' | 'upper',
): string => {
  const bracket = rangeBracket(side, boundary);
  const value = boundary.bounded
    ? serializeTextLiteral(boundary.value, 'value')
    : '*';

  return side === 'lower' ? `${bracket}${value}` : `${value}${bracket}`;
};

/**
 * Print the v0.2 modifiers a node carries.
 *
 * The v0.1 parser never produces these — it rejects the syntax with
 * UNSUPPORTED_SYNTAX — but `types.ts` states that the serializer prints them so
 * a hand-built forward-compatible query round-trips. It did not, and silently
 * dropping them meant `serialize()` lost information from an AST a consumer had
 * deliberately constructed.
 *
 * Order is fixed so output is canonical: required, then boost, then the
 * fuzzy/proximity slot (which are mutually exclusive by construction — fuzzy
 * attaches only to bare terms and proximity only to quoted ones).
 */
const modifiers = (node: SiftQLAst): string => {
  const carrier = node as {
    readonly boost?: { readonly factor: string };
    readonly fuzzy?: { readonly distance: string | null };
    readonly proximity?: { readonly slop: string };
    readonly required?: unknown;
  };

  let text = '';

  if (carrier.boost) {
    text += `^${carrier.boost.factor}`;
  }

  if (carrier.fuzzy) {
    text += `~${carrier.fuzzy.distance ?? ''}`;
  }

  if (carrier.proximity) {
    text += `~${carrier.proximity.slop}`;
  }

  return text;
};

/** `+term` binds before the term itself. */
const requiredPrefix = (node: SiftQLAst): string =>
  (node as { readonly required?: unknown }).required === undefined ? '' : '+';

const serializeNode = (
  node: SiftQLAst,
  /**
   * `'term'` at the top level and inside groups, where a colon would start a
   * field name; `'value'` after a comparison operator and inside a range, where
   * the tokenizer is in value mode and a colon is ordinary.
   */
  position: TermPosition = 'term',
  /**
   * Frames spent so far. Counted rather than measured up front: a pre-pass would
   * walk the whole tree a second time to answer a question the walk itself
   * answers for free.
   */
  depth = 0,
): string => {
  if (depth > MAX_AST_DEPTH) {
    throw new SiftQLArgumentError(
      `This AST nests more than ${String(MAX_AST_DEPTH)} levels deep, which is deeper than parse() can produce and deep enough to exhaust the call stack. It was built by hand or arrived as JSON; check for a cycle.`,
      { argument: 'node', received: node.type },
    );
  }

  return `${requiredPrefix(node)}${serializeBody(node, position, depth)}${modifiers(node)}`;
};

const serializeBody = (
  node: SiftQLAst,
  position: TermPosition,
  depth: number,
): string => {
  switch (node.type) {
    case 'EmptyExpression':
      return '';

    case 'LiteralExpression':
      return node.literal === 'text'
        ? serializeTextLiteral(node, position)
        : String(node.value);

    case 'LogicalExpression': {
      // Operators are left-associative, so `a AND b AND c ...` is a LEFT SPINE
      // one node deep per term. parse() builds it with a loop and accepts
      // MAX_CLAUSES terms — 2,000, not the 50,000 this used to say;
      // recursing to print it costs one frame per term and
      // overflowed the stack at around 5,000 — a query the parser had just
      // accepted could not be serialized. The spine is walked iteratively so
      // the two agree on what is representable.
      const spine: LogicalNode[] = [];

      let deepest = node;

      while (
        deepest.left.type === 'LogicalExpression' &&
        precedenceOf(deepest.left) >= precedenceOf(deepest)
      ) {
        spine.push(deepest);
        deepest = deepest.left;
      }

      // Only the innermost left operand needs the general treatment; every
      // node above it has a left that is already printed.
      let text = wrap(
        deepest.left,
        precedenceOf(deepest.left) < precedenceOf(deepest),
        depth,
      );

      const appendRight = (frame: LogicalNode): void => {
        // An equal-precedence RIGHT operand needs brackets to keep its shape;
        // an equal-precedence left operand does not.
        const right = wrap(
          frame.right,
          precedenceOf(frame.right) <= precedenceOf(frame),
          depth,
        );

        text =
          frame.operator.notation === 'implicit'
            ? `${text} ${right}`
            : `${text} ${frame.operator.operator} ${right}`;
      };

      appendRight(deepest);

      for (let index = spine.length - 1; index >= 0; index -= 1) {
        const frame = spine[index];

        if (frame) {
          appendRight(frame);
        }
      }

      return text;
    }

    case 'MissingExpression':
      /*
       * A hole has no text, so serializing a tolerant AST yields the incomplete
       * query the user was typing. That output is a BEST-EFFORT RENDERING and is
       * not guaranteed to re-parse in either mode.
       *
       * This used to claim it "only re-parses in tolerant mode", which was
       * simply untrue: a Tag with a hole prints as `field:` with nothing after
       * it, so when the next sibling is parenthesized the two run together and
       * `!:}""O:` serializes to `!: ("" O:)`, which strict rejects as a field
       * group containing a field and tolerant rejects for the same reason.
       * Fixing that in the serializer would mean inventing text the user never
       * typed, which is worse than saying what this does.
       *
       * The round-trip law (I4) is unaffected: it is stated over queries the
       * STRICT parser accepts, and those never contain holes. To evaluate a
       * tolerant tree, pass the tree itself — `engine.test`/`filter`/`highlight`
       * all take an AST, and apply the recovery policy to it directly. Round-
       * tripping it through text is the thing that has no defined answer.
       */
      return '';

    case 'ParenthesizedExpression':
      return `(${serializeNode(node.expression, 'term', depth + 1)})`;

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
        'value',
        depth + 1,
      )}`;
    }

    case 'UnaryOperator': {
      const operand = wrap(
        node.operand,
        precedenceOf(node.operand) < precedenceOf(node),
        depth,
      );

      if (node.operator === 'NOT') {
        // A word, so it needs a space.
        return `NOT ${operand}`;
      }

      /*
       * A sigil, so normally no space — EXCEPT before a digit.
       *
       * Inside a field group `-3` is the NUMBER minus three, not the negation of
       * three, because a group body is a list of values. So printing
       * `UnaryOperator{-, 3}` as `-3` silently changed what it meant:
       * `n:(- 3)` came back as `n:(-3)` and re-parsed as a literal, which is a
       * round-trip violation and, worse, a different query.
       *
       * The space is emitted at EVERY position rather than only inside a group.
       * `- 3` and `-3` parse identically at the top level, so one unconditional
       * rule is correct in both places, and a canonicaliser choosing the spelling
       * that cannot be misread is exactly its job. The alternative — threading
       * "am I inside a field group" through the whole serializer to save one
       * character — is more code in exchange for a worse guarantee.
       */
      return /^\d/u.test(operand) ? `- ${operand}` : `-${operand}`;
    }

    case 'WildcardExpression':
      return serializeWildcard(node, position);

    default:
      return '';
  }
};

const wrap = (
  node: Expression,
  needsBrackets: boolean,
  depth: number,
): string => {
  const text = serializeNode(node, 'term', depth + 1);

  return needsBrackets ? `(${text})` : text;
};

/**
 * Serialize an AST back to a query string.
 *
 * The result re-parses to a deep-equal AST (locations aside) for every tree
 * `parse()` produces. It is NOT guaranteed to for a hand-built tree using the
 * forward-compatibility nodes: `BoostModifier` and `RequiredModifier` are
 * printed as `a^2` and `+a`, which the v0.1 parser is required to reject. See
 * the note on `MissingExpression` above, which states the same limit honestly.
 * It is not
 * guaranteed to be byte-identical to the text originally parsed — see the
 * normalisation list above.
 */
export const serialize = (ast: SiftQLAst): string => {
  const checked = assertNode(ast, 'serialize');

  try {
    return serializeNode(checked);
  } catch (error) {
    /*
     * A RangeError HERE means the stack ran out inside the declared depth
     * budget, and it must not leave as one — `errors.ts` says catching
     * `SiftQLError` catches them all, and a hand-built or JSON-deserialized
     * tree is the supported transport, so this is reachable without a bug.
     *
     * MAX_AST_DEPTH was chosen so the failure would be a located error rather
     * than a raw overflow, and at the boundary it was not: a NOT-chain one
     * level under the cap threw RangeError on a cold stack and serialized fine
     * once the JIT had warmed up. Non-determinism is exactly why the limit is
     * declared, and exactly why the last few frames cannot be relied on.
     */
    if (error instanceof RangeError) {
      throw new SiftQLArgumentError(
        `serialize() ran out of stack on a tree ${String(MAX_AST_DEPTH)} levels deep or close to it. The declared depth limit is the most this can print reliably; the exact point varies with the JavaScript engine's state.`,
        { argument: 'node', received: checked.type },
      );
    }

    throw error;
  }
};
