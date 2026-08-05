import type { NonEmptyArray, WildcardSegment } from '../types.js';

/**
 * Decode a raw operand and, if it contains wildcard metacharacters, segment it.
 *
 * Token text arrives verbatim from the tokenizer, backslashes and all, because
 * only here can an escaped `\*` be told from a wildcard `*`. Decoding and
 * segmenting therefore happen in the same pass: the moment a backslash is
 * consumed, the character it protects is known to be literal.
 *
 * The result is either plain text (no metacharacters survived) or a segment
 * list. Adjacent literal segments are merged, so a given pattern has exactly one
 * representation and two spellings of the same pattern compare equal.
 */
export type ScannedPattern =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'wildcard';
      readonly segments: NonEmptyArray<WildcardSegment>;
    };

/**
 * @param raw    Operand text exactly as it appears in the source.
 * @param offset Source index of `raw[0]`, so every segment gets a true location.
 */
export const scanPattern = (raw: string, offset: number): ScannedPattern => {
  const segments: WildcardSegment[] = [];

  let literal = '';
  let literalStart = offset;
  let index = 0;

  const flushLiteral = (end: number): void => {
    if (literal.length > 0) {
      segments.push({
        location: { end, start: literalStart },
        type: 'WildcardLiteral',
        value: literal,
      });
      literal = '';
    }
  };

  const appendLiteral = (character: string, at: number): void => {
    if (literal.length === 0) {
      literalStart = at;
    }

    literal += character;
  };

  while (index < raw.length) {
    const character = raw.charAt(index);

    // A backslash protects the next character, whatever it is. The backslash
    // itself is dropped; the protected character becomes literal text and can
    // never be read as a metacharacter.
    if (character === '\\' && index + 1 < raw.length) {
      appendLiteral(raw.charAt(index + 1), offset + index);
      index += 2;
      continue;
    }

    if (character === '*' || character === '?') {
      flushLiteral(offset + index);
      segments.push({
        location: { end: offset + index + 1, start: offset + index },
        type: character === '*' ? 'WildcardAny' : 'WildcardSingle',
      });
      index += 1;
      continue;
    }

    appendLiteral(character, offset + index);
    index += 1;
  }

  flushLiteral(offset + raw.length);

  const hasMetacharacter = segments.some(
    (segment) => segment.type !== 'WildcardLiteral',
  );

  if (!hasMetacharacter) {
    return {
      kind: 'text',
      value: segments
        .map((segment) =>
          segment.type === 'WildcardLiteral' ? segment.value : '',
        )
        .join(''),
    };
  }

  return {
    kind: 'wildcard',
    // Safe: hasMetacharacter implies at least one segment.
    segments: segments as unknown as NonEmptyArray<WildcardSegment>,
  };
};

/** Decode escapes without segmenting — for field names, which have no wildcards. */
export const decodeEscapes = (raw: string): string => {
  let decoded = '';
  let index = 0;

  while (index < raw.length) {
    const character = raw.charAt(index);

    if (character === '\\' && index + 1 < raw.length) {
      decoded += raw.charAt(index + 1);
      index += 2;
      continue;
    }

    decoded += character;
    index += 1;
  }

  return decoded;
};
