import { SiftQLRecoveredQueryError } from '../errors.js';
import type { OnRecovered } from '../registry.js';
import type { Expression, RangeBoundary, SiftQLAst } from '../types.js';

/**
 * Eliminate tolerant-mode holes before evaluation.
 *
 * `MissingExpression` is defined by ELIMINATION, not by a truth value. Letting
 * it reach the evaluator as constant-false is the wrong answer in the exact
 * situation tolerant mode exists for: a search box compiling on every
 * keystroke sees `name:ada AND ` the moment the user types a space after AND,
 * and the result list must not blank out.
 *
 * Three rules, from the published contract:
 *
 *   - a Tag whose expression is missing is DROPPED
 *   - a logical node with a missing operand COLLAPSES to the other operand
 *   - a root that prunes to nothing becomes an EmptyExpression, which matches
 *     everything
 *
 * Under `onRecovered: 'throw'` nothing is pruned; the query is refused, because
 * some callers must never act on a guess.
 */

/** `null` means "this subtree pruned away entirely". */
const prune = (node: Expression): Expression | null => {
  switch (node.type) {
    case 'MissingExpression':
      return null;

    case 'LogicalExpression': {
      const left = prune(node.left);
      const right = prune(node.right);

      if (left === null) {
        return right;
      }

      if (right === null) {
        return left;
      }

      return left === node.left && right === node.right
        ? node
        : { ...node, left, right };
    }

    case 'UnaryOperator': {
      const operand = prune(node.operand);

      // `NOT <hole>` has no defensible meaning: negating "everything matches"
      // would exclude every row, which is a stronger claim than the user made.
      // The clause is dropped instead.
      if (operand === null) {
        return null;
      }

      return operand === node.operand ? node : { ...node, operand };
    }

    case 'ParenthesizedExpression': {
      const inner = prune(node.expression);

      if (inner === null) {
        return null;
      }

      return inner === node.expression ? node : { ...node, expression: inner };
    }

    case 'Tag': {
      // A tag whose value is still being typed is dropped whole -- `name:` says
      // nothing about which records the user wants.
      if (node.expression.type === 'MissingExpression') {
        return null;
      }

      // A FIELD GROUP is a tree, and a hole can be anywhere inside it. Failing
      // to recurse here left the hole to compile as constant-false, which is
      // wrong twice over: under AND it blanked the clause, and under NOT it
      // negated to constant-TRUE and turned a restrictive fielded predicate
      // fully permissive -- `a:(NOT` matched every record, including records
      // with no `a` key at all. A false-positive leak, not just a blank list.
      // Only a match tag can hold a group; a relational one compares against a
      // single scalar, which the type system already guarantees.
      if (
        node.kind === 'match' &&
        node.expression.type === 'ParenthesizedExpression'
      ) {
        const group = node.expression;
        const body = prune(group.expression);

        if (body === null) {
          return null;
        }

        return body === group.expression
          ? node
          : {
              ...node,
              expression: {
                ...group,
                expression: body as typeof group.expression,
              },
            };
      }

      return node;
    }

    default:
      return node;
  }
};

/** Find the first recovered node, for the `throw` policy's error message. */
const findRecovered = (
  node: SiftQLAst,
): { location: { start: number; end: number }; reason: string } | null => {
  if (node.recovered) {
    return { location: node.location, reason: node.recovered.reason };
  }

  switch (node.type) {
    case 'LogicalExpression':
      return findRecovered(node.left) ?? findRecovered(node.right);
    case 'ParenthesizedExpression':
      return findRecovered(node.expression);
    case 'RangeExpression':
      /*
       * BOUNDARIES CARRY RECOVERIES TOO, and missing them made the safety switch
       * fail OPEN — the one direction it must never fail.
       *
       * `a:[1}`, `a:{}`, `a:[ TO 9]` and `a:[1 TO }` all mark the BOUNDARY rather
       * than the range node, because that is where the invention happened. With
       * no case here the walk stopped at the RangeExpression, `onRecovered:
       * 'throw'` saw nothing to refuse, and the engine went on to evaluate an
       * unbounded end that the user never typed. `a:[` and `a:` were refused
       * correctly the whole time, which is what made this look fixed.
       */
      return (
        findRecoveredBoundary(node.lower) ?? findRecoveredBoundary(node.upper)
      );
    case 'Tag':
      return findRecovered(node.expression);
    case 'UnaryOperator':
      return findRecovered(node.operand);
    default:
      return null;
  }
};

/** A boundary is not an Expression, so it needs its own two-line walk. */
const findRecoveredBoundary = (
  boundary: RangeBoundary,
): { location: { start: number; end: number }; reason: string } | null => {
  if (boundary.recovered) {
    return { location: boundary.location, reason: boundary.recovered.reason };
  }

  return boundary.bounded && boundary.value.recovered
    ? {
        location: boundary.value.location,
        reason: boundary.value.recovered.reason,
      }
    : null;
};

/**
 * Apply the recovery policy to a parsed AST.
 *
 * Returns the tree the evaluator should actually run. Untouched — the same
 * object — when the query contains no holes at all, which is every query the
 * strict parser accepted.
 */
export const applyRecoveryPolicy = (
  ast: SiftQLAst,
  policy: OnRecovered,
): SiftQLAst => {
  if (policy === 'throw') {
    const recovered = findRecovered(ast);

    if (recovered) {
      throw new SiftQLRecoveredQueryError(
        'This query is incomplete and onRecovered is set to "throw", so it will not be guessed at',
        recovered,
      );
    }

    return ast;
  }

  if (ast.type === 'EmptyExpression') {
    return ast;
  }

  const pruned = prune(ast);

  // Everything pruned away: the user has typed nothing that constrains the
  // result, so the query matches everything.
  return pruned ?? { location: ast.location, type: 'EmptyExpression' };
};
