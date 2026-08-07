import { describe, expect, it } from 'vitest';

import { version as packageVersion } from '../package.json' with { type: 'json' };
import { VERSION } from '../src/index.js';

describe('toolchain smoke test', () => {
  it('exports from the entry point', () => {
    expect(typeof VERSION).toBe('string');
  });

  it('exports the version package.json declares', () => {
    // `npm version` rewrites package.json and nothing else, so the exported
    // constant silently keeps the previous release's number. Asserting a
    // literal here would have to be edited every release too, and would pass
    // for whichever number someone typed rather than for the right one.
    expect(VERSION).toBe(packageVersion);
  });
});
