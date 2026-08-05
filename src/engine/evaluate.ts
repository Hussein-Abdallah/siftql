import { SiftQLOperandError, signalValueFailure } from '../errors.js';
import type {
  AnyValueType,
  OperandSite,
  OperandToken,
  ResolvedEngineOptions,
  ValueContext,
  ValueTypeRegistry,
} from '../registry.js';
import type {
  Expression,
  Field,
  RangeBoundary,
  SiftQLAst,
  TextLiteral,
} from '../types.js';
import { fieldPath } from '../types.js';
import { allLeafValues, valuesAtPath, type Candidate } from './access.js';

/**
 * Evaluation.
 *
 * The load-bearing property: there is NO per-type logic here. Matching,
 * ordering and range evaluation all go through the registry, so `datetime` is
 * reached by exactly the same code path as a consumer's `semver`. Grep this file
 * for "date" and you will find nothing.
 *
 * Range evaluation in particular is implemented ONCE, on top of `compare` plus
 * per-boundary inclusivity, so no value type ever writes range code.
 */

/** A query operand, resolved to the type that claimed it. */
interface BoundOperand {
  readonly type: AnyValueType;
  readonly operand: unknown;
}

export interface EvaluationContext {
  readonly options: ResolvedEngineOptions;
  readonly registry: ValueTypeRegistry;
}

/** Normalised view of an AST leaf, so a type never destructures AST internals. */
const toOperandToken = (node: Expression): OperandToken | null => {
  switch (node.type) {
    case 'LiteralExpression':
      switch (node.literal) {
        case 'boolean':
          return { kind: 'boolean', node, value: node.value };
        case 'null':
          return { kind: 'null', node };
        default:
          return {
            kind: 'text',
            node,
            quoted: node.quoted,
            text: node.value,
          };
      }
    case 'RegexExpression':
      return {
        flags: node.flags,
        kind: 'regex',
        node,
        source: node.pattern,
      };
    case 'WildcardExpression':
      return { kind: 'wildcard', node, pattern: node.pattern };
    default:
      return null;
  }
};

/**
 * Walk the registry in order; the first type that does not decline wins.
 *
 * An `invalid` result STOPS resolution rather than continuing, which is what
 * turns `date:>=2021-02-29` into "not a real date" instead of the useless
 * "nothing claimed this" you would get by letting it fall through to `string`.
 */
const resolveOperand = (
  token: OperandToken,
  site: OperandSite,
  caseSensitive: boolean,
  context: EvaluationContext,
  location: { readonly start: number; readonly end: number },
  raw: string,
): BoundOperand => {
  const candidates: string[] = [];

  for (const type of context.registry.types) {
    const result = type.parseOperand(token, {
      caseSensitive,
      lookup: (name) => context.registry.get(name),
      options: context.options,
      site,
    });

    candidates.push(type.name);

    if (result.ok) {
      // An ordered site needs an ordered type. `string` has no `ordering`, which
      // is exactly why `name:>="m"` throws instead of inventing an answer.
      if (
        (site.kind === 'ordered' || site.kind === 'range') &&
        type.ordering === undefined
      ) {
        throw new SiftQLOperandError(
          `Type "${type.name}" has no ordering, so it cannot be compared with ${
            site.kind === 'ordered' ? site.operator : 'a range'
          }`,
          {
            candidates,
            code: 'UNORDERED_TYPE',
            hint: 'Only ordered types (number, datetime, and custom types with an `ordering`) support > >= < <= and ranges',
            location,
            raw,
            site,
          },
        );
      }

      return { operand: result.operand, type };
    }

    if (result.kind === 'invalid') {
      throw new SiftQLOperandError(`${type.name}: ${result.reason}`, {
        candidates,
        hint: result.hint,
        location,
        raw,
        site,
      });
    }
  }

  throw new SiftQLOperandError('No value type claimed this operand', {
    candidates,
    location,
    raw,
    site,
  });
};

const valueContext = (
  site: OperandSite,
  caseSensitive: boolean,
  path: readonly (string | number)[],
  isKey: boolean,
  context: EvaluationContext,
): ValueContext => ({
  caseSensitive,
  isKey,
  lookup: (name) => context.registry.get(name),
  options: context.options,
  path,
  site,
});

/** Read one candidate through the bound type, applying the failure policy. */
const readValue = (
  bound: BoundOperand,
  candidate: Candidate,
  site: OperandSite,
  caseSensitive: boolean,
  isKey: boolean,
  location: { readonly start: number; readonly end: number },
  context: EvaluationContext,
): { ok: true; value: unknown } | { ok: false } => {
  const [path, raw] = candidate;
  const result = bound.type.coerceValue(
    raw,
    valueContext(site, caseSensitive, path, isKey, context),
  );

  if (result.ok) {
    return { ok: true, value: result.value };
  }

  const survived = signalValueFailure({
    kind: result.kind,
    location,
    onValueError: context.options.onValueError,
    path,
    reason: result.kind === 'invalid' ? result.reason : null,
    site: site.kind,
    typeName: bound.type.name,
    value: raw,
  });

  // signalValueFailure returns false or throws; it never returns true.
  return { ok: survived };
};

const matchOne = (
  bound: BoundOperand,
  value: unknown,
  site: OperandSite,
  caseSensitive: boolean,
  path: readonly (string | number)[],
  isKey: boolean,
  context: EvaluationContext,
): boolean => {
  // `matches` is `:`; when a type omits it, `:` and `:=` agree. That single
  // choice is the whole match-versus-equality semantics, expressed once.
  // Called as a method so a type may legitimately use `this`.
  return bound.type.matches === undefined
    ? bound.type.equals(value, bound.operand)
    : bound.type.matches(
        value,
        bound.operand,
        valueContext(site, caseSensitive, path, isKey, context),
      );
};

const compareOne = (bound: BoundOperand, value: unknown): number | null =>
  bound.type.ordering?.compare(value, bound.operand) ?? null;

/** Range evaluation, written once for every type that has an ordering. */
const withinBoundary = (
  bound: BoundOperand | null,
  boundary: RangeBoundary,
  value: unknown,
  side: 'lower' | 'upper',
): boolean | null => {
  if (!boundary.bounded || bound === null) {
    // Unbounded: nothing to fail against.
    return true;
  }

  const ordering = compareOne(bound, value);

  if (ordering === null) {
    return null;
  }

  const satisfied =
    side === 'lower'
      ? boundary.inclusive
        ? ordering >= 0
        : ordering > 0
      : boundary.inclusive
        ? ordering <= 0
        : ordering < 0;

  return satisfied;
};

const literalOf = (boundary: RangeBoundary): TextLiteral | null =>
  boundary.bounded ? boundary.value : null;

/**
 * Compile an AST into a predicate.
 *
 * Operands are resolved ONCE here, not per record, so a filter over 10,000 rows
 * parses `2020-06-01` a single time. It also means a bad query throws
 * immediately rather than on the first row that happens to reach it.
 */
export const compileExpression = (
  node: SiftQLAst,
  context: EvaluationContext,
  defaultField: Field | null = null,
): ((item: unknown) => boolean) => {
  switch (node.type) {
    case 'EmptyExpression':
      // The empty query matches everything.
      return () => true;

    case 'LogicalExpression': {
      const left = compileExpression(node.left, context, defaultField);
      const right = compileExpression(node.right, context, defaultField);

      return node.operator.operator === 'AND'
        ? (item) => left(item) && right(item)
        : (item) => left(item) || right(item);
    }

    case 'MissingExpression':
      // Pruned before evaluation; a hole that survives matches nothing.
      return () => false;

    case 'ParenthesizedExpression':
      return compileExpression(node.expression, context, defaultField);

    case 'UnaryOperator': {
      const operand = compileExpression(node.operand, context, defaultField);

      return (item) => !operand(item);
    }

    case 'Tag': {
      // A field group re-enters with the field pushed as the default, exactly
      // as the grammar reads -- no desugaring, no duplicated subtrees.
      if (
        node.kind === 'match' &&
        node.expression.type === 'ParenthesizedExpression'
      ) {
        return compileExpression(
          node.expression.expression,
          context,
          node.field,
        );
      }

      return compileClause(node, context, node.field);
    }

    default:
      return compileClause(node, context, defaultField);
  }
};

const compileClause = (
  node: Expression,
  context: EvaluationContext,
  field: Field | null,
): ((item: unknown) => boolean) => {
  const path = field ? fieldPath(field) : null;

  const candidatesFor = (item: unknown): Candidate[] =>
    path === null
      ? allLeafValues(item, context.options.matchKeys)
      : valuesAtPath(item, path);

  // ---- Tag: a fielded clause ------------------------------------------------
  if (node.type === 'Tag') {
    const caseSensitive = node.caseSensitive;

    if (node.kind === 'relational') {
      if (node.expression.type === 'MissingExpression') {
        return () => false;
      }

      const isEquality = node.operator.operator === ':=';
      const site: OperandSite = isEquality
        ? { field: node.field, kind: 'equality' }
        : {
            field: node.field,
            kind: 'ordered',
            operator: node.operator.operator,
          };
      const token = toOperandToken(node.expression);

      if (token === null) {
        return () => false;
      }

      const bound = resolveOperand(
        token,
        site,
        caseSensitive,
        context,
        node.expression.location,
        node.expression.value,
      );
      const operator = node.operator.operator;

      return (item) =>
        candidatesFor(item).some((candidate) => {
          const read = readValue(
            bound,
            candidate,
            site,
            caseSensitive,
            false,
            node.expression.location,
            context,
          );

          if (!read.ok) {
            return false;
          }

          if (isEquality) {
            return bound.type.equals(read.value, bound.operand);
          }

          const ordering = compareOne(bound, read.value);

          if (ordering === null) {
            return signalValueFailure({
              kind: 'incomparable',
              location: node.expression.location,
              onValueError: context.options.onValueError,
              path: candidate[0],
              reason: null,
              site: 'ordered',
              typeName: bound.type.name,
              value: candidate[1],
            });
          }

          switch (operator) {
            case ':>':
              return ordering > 0;
            case ':>=':
              return ordering >= 0;
            case ':<':
              return ordering < 0;
            default:
              return ordering <= 0;
          }
        });
    }

    // Match tag: a range, or a single operand.
    if (node.expression.type === 'RangeExpression') {
      return compileRange(node, context, candidatesFor);
    }

    const site: OperandSite = { field: node.field, kind: 'match' };
    const token = toOperandToken(node.expression);

    if (token === null) {
      return () => false;
    }

    const bound = resolveOperand(
      token,
      site,
      caseSensitive,
      context,
      node.expression.location,
      sourceOf(node.expression),
    );

    return (item) =>
      candidatesFor(item).some((candidate) => {
        const read = readValue(
          bound,
          candidate,
          site,
          caseSensitive,
          false,
          node.expression.location,
          context,
        );

        return (
          read.ok &&
          matchOne(
            bound,
            read.value,
            site,
            caseSensitive,
            candidate[0],
            false,
            context,
          )
        );
      });
  }

  // ---- Unfielded term: sweep every leaf -------------------------------------
  const site: OperandSite = field ? { field, kind: 'match' } : { kind: 'scan' };
  const token = toOperandToken(node);

  if (token === null) {
    return () => false;
  }

  const bound = resolveOperand(
    token,
    site,
    false,
    context,
    node.location,
    sourceOf(node),
  );

  return (item) =>
    candidatesFor(item).some((candidate) => {
      const read = readValue(
        bound,
        candidate,
        site,
        false,
        false,
        node.location,
        context,
      );

      return (
        read.ok &&
        matchOne(bound, read.value, site, false, candidate[0], false, context)
      );
    });
};

const compileRange = (
  node: Extract<Expression, { type: 'Tag' }>,
  context: EvaluationContext,
  candidatesFor: (item: unknown) => Candidate[],
): ((item: unknown) => boolean) => {
  if (node.expression.type !== 'RangeExpression') {
    return () => false;
  }

  const range = node.expression;
  const caseSensitive = node.caseSensitive;

  const bindBoundary = (
    boundary: RangeBoundary,
    side: 'lower' | 'upper',
  ): BoundOperand | null => {
    const literal = literalOf(boundary);

    if (literal === null) {
      return null;
    }

    const token = toOperandToken(literal);

    if (token === null) {
      return null;
    }

    return resolveOperand(
      token,
      {
        field: node.field,
        inclusive: boundary.bounded ? boundary.inclusive : true,
        kind: 'range',
        side,
      },
      caseSensitive,
      context,
      literal.location,
      literal.value,
    );
  };

  const lower = bindBoundary(range.lower, 'lower');
  const upper = bindBoundary(range.upper, 'upper');
  const reference = lower ?? upper;

  if (reference === null) {
    // [* TO *] -- every value its type can read is in range.
    return () => true;
  }

  if (lower && upper && lower.type.name !== upper.type.name) {
    throw new SiftQLOperandError(
      `Range boundaries resolved to different types: "${lower.type.name}" and "${upper.type.name}"`,
      {
        code: 'MIXED_RANGE_TYPES',
        location: range.location,
        raw: '',
        site: {
          field: node.field,
          inclusive: true,
          kind: 'range',
          side: 'upper',
        },
      },
    );
  }

  const site: OperandSite = {
    field: node.field,
    inclusive: true,
    kind: 'range',
    side: 'lower',
  };

  return (item) =>
    candidatesFor(item).some((candidate) => {
      const read = readValue(
        reference,
        candidate,
        site,
        caseSensitive,
        false,
        range.location,
        context,
      );

      if (!read.ok) {
        return false;
      }

      const low = withinBoundary(lower, range.lower, read.value, 'lower');
      const high = withinBoundary(upper, range.upper, read.value, 'upper');

      if (low === null || high === null) {
        return signalValueFailure({
          kind: 'incomparable',
          location: range.location,
          onValueError: context.options.onValueError,
          path: candidate[0],
          reason: null,
          site: 'range',
          typeName: reference.type.name,
          value: candidate[1],
        });
      }

      return low && high;
    });
};

const sourceOf = (node: Expression): string => {
  switch (node.type) {
    case 'LiteralExpression':
      return String(node.value);
    case 'RegexExpression':
      return `/${node.pattern}/`;
    case 'WildcardExpression':
      return node.pattern
        .map((segment) =>
          segment.type === 'WildcardAny'
            ? '*'
            : segment.type === 'WildcardSingle'
              ? '?'
              : segment.value,
        )
        .join('');
    default:
      return '';
  }
};
