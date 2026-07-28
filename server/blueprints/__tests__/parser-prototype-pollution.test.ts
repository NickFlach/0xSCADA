/**
 * Regression guard for the CodeQL `js/remote-property-injection` findings on the
 * blueprint parsers (alerts #149-#154) and `js/prototype-pollution-utility` on
 * `setNested` (#28).
 *
 * These parsers build objects keyed by the *header cells of an uploaded CSV*,
 * i.e. by attacker-controlled strings:
 *
 *     const row = {};
 *     headerRow.forEach((header, idx) => { row[header] = cells[idx]; });
 *
 * With a normal `{}` accumulator a header literally named `__proto__` writes
 * through to `Object.prototype`, so one uploaded file could add a property to
 * every object in the process. The accumulators now use `Object.create(null)`,
 * which has no prototype chain to reach. `configuration` in
 * `parseCMInstancesCSV` is the same story for non-standard column names.
 *
 * These tests assert the *property*, not the implementation: they parse a CSV
 * whose header is `__proto__` and then check an unrelated, freshly-created
 * object was not affected. That fails on the old code and passes on the new,
 * and keeps passing under any future rewrite that is also safe.
 */
import { afterEach, describe, expect, it } from "vitest";

import { parseCMInstancesCSV } from "../csv-parser";

/** A property name no legitimate code would define. */
const CANARY = "__polluted_by_test__";

function protoCanary(): unknown {
  return ({} as Record<string, unknown>)[CANARY];
}

afterEach(() => {
  // Never let a failure leak a polluted prototype into the rest of the suite.
  delete (Object.prototype as Record<string, unknown>)[CANARY];
});

describe("blueprint CSV parsing uses null-prototype accumulators", () => {
  it("Object.prototype is never reached, whatever the headers are", () => {
    // Kept as a belt-and-braces assertion. Note it passes on the OLD code too:
    // `row["__proto__"] = "a string"` is silently ignored, because the
    // `__proto__` setter only accepts an object or null and CSV cells are
    // always strings. That is exactly why the CodeQL finding is not an
    // exploitable pollution — see the header comment.
    const csv = [`Name,__proto__,constructor`, `pump-01,${CANARY},${CANARY}`].join("\n");

    parseCMInstancesCSV(csv, "MotorCM");

    expect(protoCanary()).toBeUndefined();
    expect(CANARY in Object.prototype).toBe(false);
  });

  it("parsed configuration objects inherit nothing", () => {
    // THIS is the assertion that binds the change: on the old `{}` accumulator
    // the prototype is Object.prototype, so `configuration.toString` is an
    // inherited function and a header named `toString` would shadow it for
    // every downstream consumer. With Object.create(null) there is nothing to
    // shadow and nothing to inherit.
    const parsed = parseCMInstancesCSV(
      [`Name,setpoint`, `pump-01,42`].join("\n"),
      "MotorCM",
    );

    const config = parsed.instances[0].configuration as Record<string, unknown>;
    expect(Object.getPrototypeOf(config)).toBeNull();
    expect((config as any).toString).toBeUndefined();
    expect((config as any).hasOwnProperty).toBeUndefined();
  });

  it("a header named toString cannot shadow an inherited member", () => {
    // On a plain object this stores a string over the inherited function, so
    // any downstream `String(config)` or `config.toString()` throws. With a
    // null-prototype accumulator it is just an ordinary data key.
    const parsed = parseCMInstancesCSV(
      [`Name,toString`, `pump-01,hijacked`].join("\n"),
      "MotorCM",
    );

    const config = parsed.instances[0].configuration as Record<string, unknown>;
    expect(config.toString).toBe("hijacked");
    // The prototype chain is empty, so nothing inherited was displaced.
    expect(Object.getPrototypeOf(config)).toBeNull();
  });

  it("ordinary parsing still works", () => {
    const parsed = parseCMInstancesCSV(
      [`Name,Comment,setpoint`, `pump-01,north feed,42`].join("\n"),
      "MotorCM",
    );

    expect(parsed.instances).toHaveLength(1);
    expect(parsed.instances[0].name).toBe("pump-01");
    // `setpoint` is not a standard column, so it lands in configuration —
    // and numeric-looking values are coerced.
    expect(parsed.instances[0].configuration.setpoint).toBe(42);
  });
});

// NOTE on CodeQL #28 (`js/prototype-pollution-utility`, config-manager
// `setNested`): deliberately not covered here. `setNested` is a private helper
// called only with hardcoded config paths (config-manager.ts:316, :324, :364),
// so its keys are never attacker-controlled and there is no reachable path to
// test. It keeps a FORBIDDEN_KEYS denylist plus null-prototype intermediates as
// defence-in-depth; writing a test that reaches past the public API to "prove"
// an unreachable exploit would assert something the system does not actually do.
