/**
 * The structural limits, in one place because they have to agree.
 *
 * Two of these bound what `parse()` will accept. The third bounds what
 * `serialize()` and the evaluator will accept, and it is DERIVED from the other
 * two rather than chosen independently — that derivation is the point. An AST
 * limit set below what the parser can emit would make `serialize(parse(q))`
 * throw for a query siftql had just accepted, breaking the round-trip law; set
 * above, and a hand-built tree could still exhaust the call stack, which is what
 * these exist to prevent.
 *
 * WHY A DECLARED NUMBER RATHER THAN A MEASURED ONE. The obvious alternative is
 * to find the depth at which the stack actually overflows and stop just short.
 * That was tried and abandoned: on one Node 24 run, a 3,000-deep tree threw
 * `RangeError` while a 3,500-deep tree serialized fine. The available stack is a
 * property of the runtime, the thread, JIT state, and how deep the CALLER
 * already is — not of this code — so there is no measurable boundary to sit
 * below. A declared limit, documented and identical everywhere, is a contract;
 * a measured one is a coincidence.
 */

/** Deepest nesting of parentheses and field groups `parse()` will accept. */
export const MAX_DEPTH = 200;

/**
 * Most clauses one query may contain.
 *
 * Not a nesting limit: `a OR a OR a…` is flat to read and 2,000 levels deep as a
 * left-leaning tree, so this bounds tree depth just as directly as MAX_DEPTH
 * does.
 */
export const MAX_CLAUSES = 2000;

/**
 * Deepest AST `serialize()` and the evaluator will walk.
 *
 * Exactly what the parser can emit — a fully parenthesised maximal query is
 * MAX_DEPTH levels of nesting wrapped around a MAX_CLAUSES-long chain — so
 * every tree siftql produces round-trips, and anything deeper was hand-built or
 * arrived as JSON. Those are refused with a located `SiftQLArgumentError`
 * instead of a raw `RangeError` that names none of the offending structure.
 */
export const MAX_AST_DEPTH = MAX_CLAUSES + MAX_DEPTH;
