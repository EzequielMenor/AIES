# EZE-454 — Extension providers in isolated child agents

## Goal
Allow Explore, Worker, and Verify child sessions to use providers registered by parent extensions (initially CommandCode) without loading child extensions or skills. Explicitly configured but unresolvable child models must fail as a routing/protocol fault, never silently fall back to Parent execution.

## Constraints
- Work only on EZE-454; preserve existing `noExtensions: true` and `noSkills: true` child isolation.
- Use only public Pi APIs; no `dist/` internals and no provider-specific duplicate catalog/config if the parent registry exposes the registered provider config.
- Use an isolated `AIES_HOME` for real runs. Never modify the ambient Pi profile; access/copy a credential only after explicit user authorization for that credential and a disposable destination. Never display secrets.
- Keep unrelated pre-existing untracked `.codegraph/` and `.cursor/` untouched.
- No `COMMANDCODE_API_KEY` environment variable in credential-backed smoke.

## Tasks
1. **Implement child provider runtime and strict configured-model resolution.** Reuse the public registered-provider config to initialize the isolated child runtime while preserving its profile auth and resource isolation. If an env/profile model is explicitly configured but unresolved, return a clear failed delegation/protocol result rather than silently using Parent's model. Add focused regression tests for provider availability and hard failure; preserve the existing no-config Parent-model behavior.
2. **Exercise the actual delegation path.** With stored CommandCode credentials in a disposable isolated profile and no `COMMANDCODE_API_KEY`, run Explore, Worker, and Verify (including Explore → Worker → Verify on a disposable small fixture). Record the selected provider/model identity for all three and prove an invalid provider/model faults without inline fallback. Preserve noExtensions/noSkills.
3. **Document and verify EZE-454.** Update the relevant architecture/decision record with the provider handoff and failure contract; run `npm test`, `npm run check:isolation`, `bash -n bin/aies scripts/*.sh`, and `git diff --check`; record outcomes and remaining limitations here.

## Evidence
- Initial inspection: branch `feat/aies-010d-fullscreen-shell`, clean tracked worktree; unrelated untracked `.codegraph/` and `.cursor/` preserved.
- EZE-454 work branch: `feat/eze-454-child-provider-runtime`.
- Root cause from source inspection: `delegate.ts` passes the public registry facade, but `session.ts` only forwards runtime objects exposing `getAuth` and `streamSimple`; a facade is rejected. Child resource loading intentionally disables extensions and skills, so the child's fresh runtime lacks the parent's extension-registered provider.
- Pi public API check: `ModelRegistry.getRegisteredProviderConfig(provider)` and `ModelRuntime.registerProvider(provider, config)` are public in both repo-pinned 0.85.1 and local ambient 0.87.1 declarations; `ModelRuntime.create` supports explicit auth/models paths. Regression tests and the live host smoke confirmed the selected provider handoff.

## Progress
- [x] Task 1 — implementation, regression tests, and architecture/decision docs
  - New `createChildModelRuntime()` copies only the selected provider's registered config from Pi's public `ModelRegistry` into a child-local `ModelRuntime`, using the child's `agentDir/auth.json` and `models.json`; real runtimes are passed through. `noExtensions` and `noSkills` remain enabled.
  - Explicit but unresolvable `AIES_<ROLE>_MODEL` / `aies.json` settings now raise `AgentModelResolutionError`; Explore/Worker return failed handoffs and Verify returns `session_failure`. Parent fallback remains only when the role has no explicit model.
  - RED/GREEN: provider handoff regression (1 pass after fix); unresolved Explore regression (1 pass); Worker tests 21/21; Verify tests 53/53; focused 4-file run 118/118; extension/skill isolation test 1/1.
  - Public API signatures checked in the local Pi 0.87.1 type declarations; execution is against repository-pinned Pi 0.85.1.
- [x] Task 2 — real isolated profile/fixture smoke
  - Smoke profile: `/tmp/aies-eze454-smoke.NIhkKT`; disposable fixture: `/tmp/aies-eze454-fixture.xyOPuD`. Host CLI reported Pi 0.87.1. Only the stored `commandcode` auth record was copied into the isolated profile after the user confirmed it had been rotated; the key was never displayed. `COMMANDCODE_API_KEY` was unset for every run.
  - The isolated profile's `aies.json` selected `commandcode/inclusionai/ling-3.0-flash-sante:free` for Explore, Worker, and Verify; `pi --offline --list-models commandcode` showed the registered catalog with stored auth.
  - Real Explore delegation in the fixture returned `done`; the child observatory event identified `Ling 3.0 Flash Sante` / `Command Code`.
  - The chained real Parent run invoked Explore → Worker → Verify. Each launched child reported the same Command Code model/provider; Explore and Worker handoffs were `done`, final Verify was `pass`; the fixture's `node --test sum.test.mjs` passed 1/1 after Worker changed subtraction to addition. One malformed Verify request was rejected by schema before child creation, then the model retried with required facts and Verify passed. Parent was restricted to `aies_delegate` only, so it could not edit or verify inline.
  - Forced `AIES_EXPLORE_MODEL=commandcode/does-not-exist` returned a `failed` Explore handoff whose message named the unresolved model and said it refused to fall back. Parent was again restricted to `aies_delegate`; no inline read/write/bash tool call occurred.
- [x] Task 3 — full required verification
  - With a fresh disposable `HOME` containing only `$HOME/.pi/agent/auth.json`=`{}` (to stabilize Pi's ambient-profile fingerprint test) and fresh `AIES_HOME`: `npm test` passed (1001 pass, 0 fail, 2 optional MCP adapter skips); `npm run check:isolation` passed with the same totals; `bash -n bin/aies scripts/*.sh` passed; `git diff --check` passed; focused EZE-454 tests passed 118/118.
  - The 2 skips are the optional integration checks for an installed `pi-mcp-adapter`, absent from the isolated test home. In an actual HOME with isolated AIES_HOME, those MCP assertions fail against ambient adapter 3.1.0; no MCP source changed and no clean-base reproduction was made.
  - Host CLI smoke used Pi 0.87.1; extension/child SDK imports in the repo resolve to pinned 0.85.1. The Pi 0.87.1 public declarations were checked and the real 0.87 host-to-child smoke passed, but an all-0.87 dependency-tree test run was not performed.

## Git closure
- The user authorized one EZE-454-only commit with message `fix(agents): support extension providers in child runtimes (EZE-454)`; stage only the EZE-454 files and leave `.codegraph/` and `.cursor/` untracked.
