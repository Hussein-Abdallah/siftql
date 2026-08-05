import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import { resolveTemporal } from '../src/temporal/index.js';

/**
 * Integration coverage for the `parseDate` escape hatch, exercised against a
 * real third-party date library rather than a stand-in. Luxon is a
 * devDependency only; siftql itself ships with no runtime dependencies.
 */

const JUNE_1_2020 = Date.UTC(2020, 5, 1);

describe('parseDate with Luxon', () => {
  it('accepts a layout via a user hook', () => {
    const resolved = resolveTemporal('01-06-2020', {
      parseDate: (value) => {
        const parsed = DateTime.fromFormat(String(value), 'dd-MM-yyyy', {
          zone: 'utc',
        });

        return parsed.isValid ? parsed.toMillis() : null;
      },
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
  });

  it('accepts formats the built-in parser deliberately does not cover', () => {
    // "June 1, 2020" is not ISO and is not expressible as a dateFormat layout;
    // this is precisely what the hook is for.
    const resolved = resolveTemporal('June 1, 2020', {
      parseDate: (value) => {
        const parsed = DateTime.fromFormat(String(value), 'LLLL d, yyyy', {
          zone: 'utc',
        });

        return parsed.isValid ? parsed.toMillis() : null;
      },
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
  });

  it('defers to dateFormat when the hook returns null', () => {
    const resolved = resolveTemporal('01-06-2020', {
      dateFormat: 'DD-MM-YYYY',
      parseDate: (value) => {
        // This layout does not match, so the hook declines by returning null.
        const parsed = DateTime.fromFormat(String(value), 'LLLL d, yyyy', {
          zone: 'utc',
        });

        return parsed.isValid ? parsed.toMillis() : null;
      },
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
  });

  it('accepts a DateTime converted to a JS Date', () => {
    const resolved = resolveTemporal('01-06-2020', {
      parseDate: (value) => {
        const parsed = DateTime.fromFormat(String(value), 'dd-MM-yyyy', {
          zone: 'utc',
        });

        return parsed.isValid ? parsed.toJSDate() : null;
      },
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
  });

  it('leaves canonical ISO to the built-in parser, so the hook is not consulted', () => {
    let calls = 0;

    const resolved = resolveTemporal('2020-06-01', {
      parseDate: () => {
        calls += 1;

        return null;
      },
    });

    expect(resolved?.value).toBe(JUNE_1_2020);
    expect(calls).toBe(0);
  });
});

describe('parseDate zone handling', () => {
  it('honours whatever zone the hook resolves in, including a wrong one', () => {
    // Luxon's fromFormat uses the *local* zone unless told otherwise. A hook
    // written without { zone: 'utc' } therefore yields local midnight, which is
    // a different instant. siftql cannot detect this: the hook returns a number
    // of milliseconds and that number is taken at face value. Documented here
    // because it is the most likely mistake when writing a hook.
    const utc = resolveTemporal('01-06-2020', {
      parseDate: (value) =>
        DateTime.fromFormat(String(value), 'dd-MM-yyyy', {
          zone: 'utc',
        }).toMillis(),
    });

    const toronto = resolveTemporal('01-06-2020', {
      parseDate: (value) =>
        DateTime.fromFormat(String(value), 'dd-MM-yyyy', {
          zone: 'America/Toronto',
        }).toMillis(),
    });

    expect(utc?.value).toBe(JUNE_1_2020);
    // Four hours later in June (EDT), not the same instant.
    expect(toronto?.value).toBe(JUNE_1_2020 + 4 * 3_600_000);
  });
});

describe('built-in dateFormat covers the common case without a hook', () => {
  it('matches what the Luxon hook produces, with no dependency', () => {
    const viaHook = resolveTemporal('01-06-2020', {
      parseDate: (value) =>
        DateTime.fromFormat(String(value), 'dd-MM-yyyy', {
          zone: 'utc',
        }).toMillis(),
    });

    const viaBuiltIn = resolveTemporal('01-06-2020', {
      dateFormat: 'DD-MM-YYYY',
    });

    expect(viaBuiltIn?.value).toBe(viaHook?.value);
  });
});
