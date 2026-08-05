/**
 * Error hierarchy.
 *
 * Note that the syntax error class is deliberately *not* called `SyntaxError`.
 * Exporting that name shadows the global inside consumer modules, so a caller
 * writing `catch (e) { if (e instanceof SyntaxError) ... }` silently stops
 * catching genuine JS syntax errors. Every siftql error name is prefixed.
 */

/** A half-open character range into the original query string. */
export type SourceLocation = {
  /** Index of the first character, inclusive. */
  readonly start: number;
  /** Index one past the last character, exclusive. */
  readonly end: number;
};

/** Base class for every error siftql throws. Catch this to catch them all. */
export class SiftQLError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SiftQLError';
  }
}

/**
 * Render a one-line excerpt with a caret under the offending span, e.g.
 *
 * ```
 * name:foo AND (bio:bar
 *              ^
 * ```
 */
const renderExcerpt = (source: string, location: SourceLocation): string => {
  // Collapse newlines so the caret column stays aligned with what we print.
  const flattened = source.replace(/[\n\r]/gu, ' ');
  const width = Math.max(1, location.end - location.start);

  return `\n${flattened}\n${' '.repeat(location.start)}${'^'.repeat(width)}`;
};

/** Raised when a query cannot be parsed. */
export class SiftQLSyntaxError extends SiftQLError {
  /** Where in the query the problem is. */
  public readonly location: SourceLocation;

  /** The query that failed to parse, for reporting. */
  public readonly source: string;

  public constructor(
    message: string,
    location: SourceLocation,
    source: string,
  ) {
    super(`${message} (at ${String(location.start)})${renderExcerpt(source, location)}`);
    this.name = 'SiftQLSyntaxError';
    this.location = location;
    this.source = source;
  }
}
