import { describe, expect, it } from 'vitest';

import { createEngine, highlight } from '../src/index.js';

const ROW = {
  bio: 'this is just a test',
  name: 'Ada Lovelace',
  owner: { email: 'ada@example.com' },
  priority: 3,
  status: 'active',
  tags: ['red', 'blue'],
};

/** Just the paths, for assertions that do not care about the pattern. */
const paths = (query: string): string[] =>
  highlight(query, ROW).map((entry) => entry.path);

describe('what matched', () => {
  it('names the field and supplies a pattern to light up', () => {
    const [entry] = highlight('status:active', ROW);

    expect(entry?.path).toBe('status');
    expect(entry?.segments).toEqual(['status']);
    expect(entry?.query?.test('active')).toBe(true);
  });

  it('reports the array element that matched, not the array', () => {
    expect(paths('tags:blue')).toEqual(['tags.1']);
    expect(highlight('tags:blue', ROW)[0]?.segments).toEqual(['tags', 1]);
  });

  it('reports a nested path', () => {
    expect(paths('owner.email:*@example.com')).toEqual(['owner.email']);
  });

  it('reports an unfielded hit against the field it actually hit', () => {
    expect(paths('lovelace')).toEqual(['name']);
    expect(paths('just')).toEqual(['bio']);
  });

  it('omits the pattern when the whole value is the match', () => {
    // A comparison or a range has no textual footprint to underline.
    const [entry] = highlight('priority:>=3', ROW);

    expect(entry?.path).toBe('priority');
    expect(entry?.query).toBeUndefined();
  });

  it('anchors a fielded pattern but not a scan', () => {
    // A fielded match is whole-value, so its pattern is anchored; an unfielded
    // one is containment, so the pattern finds the substring inside the value.
    expect(highlight('status:active', ROW)[0]?.query?.source).toContain('^');
    expect(highlight('lovelace', ROW)[0]?.query?.source).not.toContain('^');
  });
});

describe('nothing is reported for a non-match', () => {
  it('returns empty when the item does not match', () => {
    expect(highlight('status:done', ROW)).toEqual([]);
    expect(highlight('name:nobody', ROW)).toEqual([]);
  });

  it('rolls back BOTH halves when a conjunction fails', () => {
    // name:*ada* matches, but the conjunction does not, so the record did not
    // match and nothing about it should be lit up.
    expect(highlight('status:done AND name:*ada*', ROW)).toEqual([]);
    expect(highlight('name:*ada* AND status:done', ROW)).toEqual([]);
  });
});

describe('the losing branch of an OR contributes nothing', () => {
  it('reports only the branch that matched, in either order', () => {
    expect(paths('status:active OR status:done')).toEqual(['status']);
    expect(paths('status:done OR status:active')).toEqual(['status']);
  });

  it('does not report a field touched only by the failing branch', () => {
    expect(paths('name:*ada* OR bio:*nothere*')).toEqual(['name']);
    expect(paths('bio:*nothere* OR name:*ada*')).toEqual(['name']);
  });

  it('reports both branches when both match', () => {
    expect(paths('name:*ada* OR bio:*just*')).toEqual(['name', 'bio']);
  });

  it('survives nesting', () => {
    expect(paths('(status:done OR name:*ada*) AND priority:>=3')).toEqual([
      'name',
      'priority',
    ]);
  });
});

describe('everything under a satisfied NOT contributes nothing', () => {
  it('reports nothing for a negation that matched', () => {
    // The clause matched BECAUSE status:done did not. Lighting up `status`
    // would be precisely the wrong answer.
    expect(highlight('NOT status:done', ROW)).toEqual([]);
    expect(highlight('-status:done', ROW)).toEqual([]);
  });

  it('reports nothing from inside a negated group', () => {
    expect(highlight('NOT (status:done OR name:nobody)', ROW)).toEqual([]);
  });

  it('keeps only the positive half of a conjunction with a negation', () => {
    expect(paths('name:*ada* AND NOT status:done')).toEqual(['name']);
    expect(paths('NOT status:done AND name:*ada*')).toEqual(['name']);
  });

  it('does not report a doubly negated field either', () => {
    // NOT NOT status:active matches, and the inner clause did match -- but the
    // rollback at each negation is unconditional, so nothing survives.
    expect(highlight('NOT (NOT status:active)', ROW)).toEqual([]);
  });
});

describe('collection details', () => {
  it('reports every field that matched, not just the first', () => {
    expect(paths('name:*ada* AND bio:*just* AND priority:>=3')).toEqual([
      'name',
      'bio',
      'priority',
    ]);
  });

  it('reports every array element that matched', () => {
    expect(paths('tags:*e*')).toEqual(['tags.0', 'tags.1']);
  });

  it('de-duplicates identical path/pattern pairs', () => {
    expect(paths('status:active AND status:active')).toEqual(['status']);
  });

  it('keeps two different patterns on the same field', () => {
    const entries = highlight('name:*ada* AND name:*lovelace*', ROW);

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.path === 'name')).toBe(true);
  });

  it('is available on an engine as well as at the top level', () => {
    const engine = createEngine();

    expect(engine.highlight('status:active', ROW)).toHaveLength(1);
  });
});

describe('a value type supplies the pattern, never the survival decision', () => {
  it('lets a type opt out of a pattern entirely', () => {
    // boolean and datetime return null: there is no substring to underline.
    const [entry] = highlight('priority:[1 TO 5]', ROW);

    expect(entry?.path).toBe('priority');
    expect(entry?.query).toBeUndefined();
  });

  it('still suppresses that type under a satisfied NOT', () => {
    // Survival is core's decision, so a type that returns null is suppressed
    // by exactly the same rollback as one that returns a pattern.
    expect(highlight('NOT priority:[10 TO 20]', ROW)).toEqual([]);
  });
});

describe('a highlight points at what was searched for, not the whole value', () => {
  const person = { notes: 'seen at smith street', surname: 'Smithers' };

  const underlined = (query: string, field: 'notes' | 'surname'): string[] => {
    const entry = highlight(query, person).find((h) => h.path === field);

    if (!entry?.query) {
      return [];
    }

    return [...person[field].matchAll(entry.query)].map((match) => match[0]);
  };

  it('underlines only the literal part of a wildcard pattern', () => {
    // The whole-value matcher would light up the entire cell, telling a reader
    // nothing about WHY the row matched.
    expect(underlined('surname:*smith*', 'surname')).toEqual(['Smith']);
    expect(underlined('surname:smith*', 'surname')).toEqual(['Smith']);
    expect(underlined('notes:*smith*', 'notes')).toEqual(['smith']);
  });

  it('underlines every occurrence, not just the first', () => {
    expect(underlined('notes:*s*', 'notes')).toEqual(['s', 's', 's']);
  });

  it('underlines each literal of a multi-part pattern', () => {
    expect(underlined('notes:*seen*street*', 'notes')).toEqual([
      'seen',
      'street',
    ]);
  });

  it('underlines the whole value for an exact match, which IS the match', () => {
    expect(underlined('surname:Smithers', 'surname')).toEqual(['Smithers']);
  });

  it('offers nothing to underline when the pattern has no literal at all', () => {
    // `*` matched everything; no particular part is the reason.
    const [entry] = highlight('surname:*', person);

    expect(entry?.path).toBe('surname');
    expect(entry?.query).toBeUndefined();
  });

  it('respects case sensitivity in the pattern it hands back', () => {
    expect(underlined('surname::*Smith*', 'surname')).toEqual(['Smith']);
    expect(highlight('surname::*smith*', person)).toEqual([]);
  });
});
