import { describe, expect, it } from 'vitest';

import { createRegistry } from '../src/engine/registry.js';
import {
  claimed,
  DECLINED,
  defineValueType,
  MISS,
  resolved,
  SiftQLConfigError,
  type ResolvedEngineOptions,
  type ValueType,
} from '../src/index.js';

const OPTIONS: ResolvedEngineOptions = {
  id: 'test',
  matchKeys: false,
  maxPatternLength: 1000,
  onRecovered: 'prune',
  onValueError: 'skip',
  regexGuard: true,
  temporal: {},
  tolerant: false,
};

const stub = (name: string): ValueType<string, string> =>
  defineValueType<string, string>({
    coerceValue: (value) =>
      typeof value === 'string' ? resolved(value) : MISS,
    equals: (value, operand) => value === operand,
    name,
    parseOperand: (operand) =>
      operand.kind === 'text' ? claimed(operand.text) : DECLINED,
  });

const names = (registry: { describe: () => readonly { name: string }[] }) =>
  registry.describe().map((type) => type.name);

describe('createRegistry', () => {
  it('ships the built-ins in the documented order', () => {
    expect(names(createRegistry(OPTIONS))).toEqual([
      'regex',
      'null',
      'boolean',
      'wildcard',
      'datetime',
      'number',
      'string',
    ]);
  });

  it('prepends consumer types by default, so they outrank the built-ins', () => {
    // A consumer's semver must claim `1.2.3` before `number` ever sees it.
    expect(names(createRegistry(OPTIONS, [stub('semver')]))[0]).toBe('semver');
  });

  it('appends when asked', () => {
    const registry = createRegistry(OPTIONS, [stub('fallback')], 'append');

    expect(names(registry).at(-1)).toBe('fallback');
    // Note the consequence: `string` still claims everything before it, so an
    // appended type is only reachable for tokens string declines.
    expect(names(registry)).toContain('string');
  });

  it('replaces the built-ins entirely when asked', () => {
    expect(names(createRegistry(OPTIONS, [stub('only')], 'replace'))).toEqual([
      'only',
    ]);
  });

  it('reports which types are built in and which are ordered', () => {
    const registry = createRegistry(OPTIONS, [stub('custom')]);
    const described = Object.fromEntries(
      registry.describe().map((type) => [type.name, type]),
    );

    expect(described.custom).toMatchObject({
      builtin: false,
      ordered: false,
    });
    expect(described.number).toMatchObject({ builtin: true, ordered: true });
    expect(described.string).toMatchObject({
      builtin: true,
      ordered: false,
    });
  });

  it('looks a type up by name', () => {
    const registry = createRegistry(OPTIONS);

    expect(registry.get('datetime')?.name).toBe('datetime');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('freezes its type list', () => {
    expect(Object.isFrozen(createRegistry(OPTIONS).types)).toBe(true);
  });
});

describe('rejects a broken configuration', () => {
  it('refuses a duplicate name', () => {
    expect(() => createRegistry(OPTIONS, [stub('dup'), stub('dup')])).toThrow(
      SiftQLConfigError,
    );
  });

  it('refuses a name that collides with a built-in', () => {
    expect(() => createRegistry(OPTIONS, [stub('number')])).toThrow(
      SiftQLConfigError,
    );
  });

  it('refuses a type with no name', () => {
    expect(() => createRegistry(OPTIONS, [stub('')])).toThrow(
      SiftQLConfigError,
    );
  });

  it('names the offender, and says how to substitute a built-in', () => {
    try {
      createRegistry(OPTIONS, [stub('string')]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('string');
      expect((error as Error).message).toContain('replace');
    }
  });
});

describe('with() returns a NEW registry', () => {
  it('never mutates the receiver', () => {
    const base = createRegistry(OPTIONS);
    const extended = base.with([stub('extra')]);

    expect(names(extended)).toContain('extra');
    // There is no mutation API at any level.
    expect(names(base)).not.toContain('extra');
    expect(base.types).not.toBe(extended.types);
  });

  it('honours each strategy', () => {
    const base = createRegistry(OPTIONS);

    expect(names(base.with([stub('a')]))[0]).toBe('a');
    expect(names(base.with([stub('a')], 'append')).at(-1)).toBe('a');
    expect(names(base.with([stub('a')], 'replace'))).toEqual(['a']);
  });

  it('chains', () => {
    const chained = createRegistry(OPTIONS)
      .with([stub('first')])
      .with([stub('second')]);

    expect(names(chained).slice(0, 2)).toEqual(['second', 'first']);
  });

  it('still refuses a duplicate introduced by the extension', () => {
    expect(() => createRegistry(OPTIONS).with([stub('number')])).toThrow(
      SiftQLConfigError,
    );
  });
});

describe('factories', () => {
  it('resolves a factory against the engine environment', () => {
    let sawTemporal: unknown;

    const registry = createRegistry(
      { ...OPTIONS, temporal: { dateFormat: 'DD-MM-YYYY' } },
      [
        (env) => {
          sawTemporal = env.temporal;

          return stub('made');
        },
      ],
    );

    expect(registry.get('made')).toBeDefined();
    // A factory closes over THIS engine's temporal options, which is what makes
    // two engines able to disagree about the same data.
    expect(sawTemporal).toEqual({ dateFormat: 'DD-MM-YYYY' });
  });

  it('gives a factory a lazy peer lookup, resolvable after construction', () => {
    let lookup: ((name: string) => unknown) | undefined;

    const registry = createRegistry(OPTIONS, [
      (env) => {
        // The registry does not exist yet at this moment.
        lookup = env.lookup;

        return stub('late');
      },
    ]);

    expect(registry.get('late')).toBeDefined();
    // ...but the closure resolves once it does.
    expect(lookup?.('number')).toBeDefined();
    expect(lookup?.('missing')).toBeUndefined();
  });
});
