import type { Highlight } from '../registry.js';

/**
 * Highlight collection with commit/rollback.
 *
 * The hard part of `highlight()` is not finding matches — the evaluator already
 * does that — it is DISCARDING the ones that did not survive. Two cases, and
 * both are wrong in the obvious implementation:
 *
 *   `a OR b`   when only `a` matched, anything `b` lit up must be thrown away.
 *   `NOT a`    when the whole clause matched, `a` did NOT match. Everything it
 *              lit up is exactly the wrong answer.
 *
 * A collector that simply appends as it walks reports both. This sink instead
 * lets the evaluator take a mark before a branch and roll back to it when that
 * branch turns out not to have contributed, so a highlight survives only if the
 * clause that produced it is part of the reason the record matched.
 *
 * That decision is core's alone. A value type says WHAT to light up inside a
 * value it matched; it is never asked whether the highlight should survive,
 * because no type can see the tree above it.
 */
export class HighlightSink {
  private readonly collected: Highlight[] = [];

  /** A checkpoint to roll back to. */
  public mark(): number {
    return this.collected.length;
  }

  /** Discard everything collected since `checkpoint`. */
  public rollback(checkpoint: number): void {
    this.collected.length = checkpoint;
  }

  public add(highlight: Highlight): void {
    this.collected.push(highlight);
  }

  /**
   * The surviving highlights, de-duplicated.
   *
   * The same path can be lit twice — `name:ada AND name:*ada*` matches the same
   * field two ways — and a caller wants one entry per distinct path/pattern
   * pair, not one per clause.
   */
  public drain(): Highlight[] {
    const seen = new Set<string>();
    const unique: Highlight[] = [];

    for (const highlight of this.collected) {
      /*
       * The key has to include the SPANS, not only the `query`. It did not, and
       * `regexType` reports through `ranges` and publishes no `query`, so every
       * regex hit at one path produced an identical key and all but the first
       * were silently dropped: `v:/Lorem/ AND v:/dolor/` underlined only
       * "Lorem", while `v:/dolor/ AND v:/Lorem/` underlined only "dolor". Both
       * conjuncts had contributed, and `highlight()` was not commutative over
       * AND, which no contract here permits.
       *
       * `\0` separates the parts because it is the one character a field name,
       * a pattern source and a flag string cannot contain, so no combination of
       * them can forge another entry's key.
       */
      const spans = (highlight.ranges ?? [])
        .map((range) => `${String(range.start)}-${String(range.end)}`)
        .join(',');
      const key = [
        JSON.stringify(highlight.segments),
        highlight.query?.source ?? '',
        highlight.query?.flags ?? '',
        spans,
      ].join('\0');

      if (!seen.has(key)) {
        seen.add(key);
        unique.push(highlight);
      }
    }

    /*
     * A BARE hit — no query, no ranges — says only "this field matched", which
     * a hit at the same path carrying spans already says AND locates. Reporting
     * both would make `n:[1 TO 9] AND n:/5/` name the field twice, once
     * uselessly, purely because a range clause cannot point inside a value.
     */
    const located = new Set(
      unique
        .filter((highlight) => highlight.query ?? highlight.ranges)
        .map((highlight) => JSON.stringify(highlight.segments)),
    );

    return unique.filter(
      (highlight) =>
        Boolean(highlight.query ?? highlight.ranges) ||
        !located.has(JSON.stringify(highlight.segments)),
    );
  }
}
