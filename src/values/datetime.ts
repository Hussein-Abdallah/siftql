import { isDateLike } from '../internal.js';
import {
  claimed,
  DECLINED,
  defineValueType,
  malformedOperand,
  malformedValue,
  MISS,
  resolved,
  type TemporalValueType,
  type TypeEnvironment,
} from '../registry.js';
import {
  compareTemporal,
  detectTemporalFormat,
  equalsTemporal,
  readWithFormats,
  resolveTemporal,
  SUPPORTED_TEMPORAL_MESSAGE,
  type ResolvedTemporal,
} from '../temporal/index.js';

/**
 * The flagship built-in — and deliberately just a registration.
 *
 * There is no temporal branch anywhere in the evaluator; ranges and ordering
 * reach dates through the same `ordering.compare` every other type uses. If this
 * file were deleted, dates would stop working and nothing else would change,
 * which is the test of whether the extensibility model is real.
 *
 * It is a FACTORY rather than a singleton because it must close over THIS
 * engine's `dateFormat`/`parseDate`. Two engines in one process can therefore
 * disagree about what `01-02-2020` means without either knowing the other
 * exists — the thing a global registry could never offer.
 */
export const createDatetimeType = (env: TypeEnvironment): TemporalValueType =>
  defineValueType<ResolvedTemporal, ResolvedTemporal>({
    /**
     * Field values may be ISO strings, epoch numbers, or `Date` objects, and all
     * three resolve. The MISS/INVALID split is what makes dirty data a policy
     * decision: a boolean in a date column is the wrong SHAPE and simply does
     * not match, while the string `'n/a'` is the right shape with impossible
     * content and is governed by `onValueError`.
     */
    coerceValue: (value) => {
      if (
        typeof value === 'boolean' ||
        (typeof value === 'object' && value !== null && !isDateLike(value))
      ) {
        return MISS;
      }

      if (value === null || value === undefined) {
        return MISS;
      }

      const parsed = resolveTemporal(value, env.temporal);

      return parsed === null
        ? malformedValue(SUPPORTED_TEMPORAL_MESSAGE)
        : resolved(parsed);
    },

    equals: (value, operand) => equalsTemporal(value, operand),

    // A date match has no textual footprint to light up -- the value may be an
    // epoch number or a Date, which share no substring with the query.
    highlight: () => null,

    name: 'datetime',

    ordering: {
      // Returns null across domains, and the engine dispositions that as
      // `incomparable`. A wall-clock 14:30 and a calendar date sit on different
      // lines, so the only correct answers are "not comparable" or an error.
      compare: (value, operand) => compareTemporal(value, operand),
    },

    /**
     * Claiming is gated on SHAPE, not on resolvability, and the two-step matters:
     *
     * - Not shaped like a date at all (`foo`, `1000`) → DECLINED, so `string` and
     *   `number` still get their turn and `height:>1000` never becomes a date
     *   comparison.
     * - Shaped like a date but not a real one (`2021-02-29`) → INVALID, which
     *   stops resolution and reports it. That is the fail-loud guarantee: an
     *   operand the user clearly MEANT as a date must never quietly degrade into
     *   a string comparison that returns nothing.
     */
    parseOperand: (operand, ctx) => {
      if (operand.kind !== 'text') {
        return DECLINED;
      }

      /*
       * "Shaped like a date" must include the DECLARED layout, not just ISO.
       *
       * `detectTemporalFormat` knows ISO shapes only, so under
       * `dateFormat: 'DD-MM-YYYY'` the operand `31-02-2020` was not recognised
       * as temporal at all: this type declined, `string` claimed it, and
       * `d:31-02-2020` matched a field holding the same text — an impossible
       * date matching itself. The ordered form was worse, reporting
       * `Type "string" has no ordering` and blaming the wrong thing entirely.
       *
       * `readWithFormats` reports `impossible` for exactly this — a value that
       * FITS the layout but names no real instant — so it is the right signal to
       * claim on.
       */
      const fitsDeclaredLayout =
        env.temporal.dateFormat !== undefined &&
        readWithFormats(operand.text, env.temporal.dateFormat).outcome ===
          'impossible';

      const looksTemporal =
        detectTemporalFormat(operand.text) !== null || fitsDeclaredLayout;
      const parsed = resolveTemporal(operand.text, env.temporal);

      if (parsed !== null) {
        return claimed(parsed);
      }

      if (!looksTemporal) {
        return DECLINED;
      }

      // Shaped like a date, but not one that exists.
      return malformedOperand(
        `${JSON.stringify(operand.text)} is not a real date`,
        ctx.site.kind === 'ordered' || ctx.site.kind === 'range'
          ? SUPPORTED_TEMPORAL_MESSAGE
          : null,
      );
    },
  });
