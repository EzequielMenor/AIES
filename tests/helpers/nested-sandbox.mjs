/**
 * Nested sandbox-runtime detection (EZE-493).
 *
 * Verify executes checks inside an OS sandbox stamped by
 * `@anthropic-ai/sandbox-runtime` with `SANDBOX_RUNTIME=1` (see
 * `generateProxyEnvVars` in the runtime). A suite started there must not spin
 * up a second sandbox-runtime: the mux socket cannot `listen` inside the outer
 * sandbox (`listen EPERM`), which fails tests for a cause unrelated to any
 * regression, and `sandbox-exec` nesting is denied outright.
 *
 * `nestedSandboxSkip()` returns a skip reason ONLY when a nesting marker is
 * present, so:
 *
 *   - a plain run keeps full OS-enforcement coverage: a real incapacity on the
 *     host fails the suite instead of turning into a pass;
 *   - a run under an outer sandbox reports the enforcement tests as skipped
 *     (visible in TAP as `# skipped`), never as silently passing;
 *   - `AIES_TEST_NESTED_SANDBOX=1|0` forces the decision explicitly in either
 *     direction. `0` re-enables the enforcement tests even under an outer
 *     sandbox, where they fail loudly rather than hide a problem.
 */

/** True when the test run must not start a second sandbox-runtime. */
export function isNestedSandboxActive(env = process.env) {
  const explicit = env.AIES_TEST_NESTED_SANDBOX;
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  return env.SANDBOX_RUNTIME === "1";
}

/**
 * Skip reason for tests that execute OS sandbox enforcement, or `false` when
 * the test must run. Pass to `it(name, { skip: nestedSandboxSkip() }, fn)`.
 */
export function nestedSandboxSkip(env = process.env) {
  if (!isNestedSandboxActive(env)) return false;
  return (
    "nested sandbox-runtime: an outer OS sandbox is active " +
    "(SANDBOX_RUNTIME=1 or AIES_TEST_NESTED_SANDBOX=1) and cannot host a second " +
    "sandbox-runtime listen; this test runs in the top-level suite (EZE-493)"
  );
}
