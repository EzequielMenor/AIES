# EZE-453 — CommandCode as a real AIES provider

Linear: [EZE-453](https://linear.app/eze33/issue/EZE-453) · parent EZE-431 · milestone v1
Branch: `feat/aies-010d-fullscreen-shell` (work already present, uncommitted)
Runtime: Pi 0.87.0 (`/Users/ezequielmenor/Library/pnpm/bin/pi`)

## Objective

Make the `commandcode` provider usable from ordinary AIES UX: persistent auth
without an ephemeral env var, models visible and selectable in `/aies-models`,
and no provider presented as functional when its credential is absent or
rejected.

## Root cause (confirmed, not assumed)

Evidence: throwaway probes against an isolated `AIES_HOME`, Pi 0.87.0 RPC mode.

| # | Symptom | Cause | Evidence |
|---|---|---|---|
| RC1 | `commandcode` registers but exposes 0 models | `apiKey: "$COMMANDCODE_API_KEY"` makes availability depend on env-var **presence**. `composeApiKeyAuth().check()` returns `undefined` when the referenced variable is `undefined`; `ModelRuntime.updateModelSnapshot` then filters `available = all.filter(m => configuredProviders.has(m.provider))`, dropping all 76 rows. | `pi-coding-agent/dist/core/provider-composer.js:236-244`; `dist/core/model-runtime.js:166-172`. Probe A: no auth, no env → `{"minimax":3}`, zero commandcode. |
| RC2 | `/login commandcode` is already the supported persistent path | A **stored credential owns the provider** and wins over the env expression. Pi fabricates `login: interaction.prompt({type:"secret"})` for extension providers, persisted to `<agentDir>/auth.json` as `{type:"api_key",key}`. | `pi-ai/dist/auth/resolve.js:22-24`; `provider-composer.js:215-226`. Probe C: `auth.json` entry, **no env var** → `{"commandcode":76,"minimax":3}`. Probe D (both) → 76. |
| RC3 | Anthropic shows as usable despite HTTP 401 | Availability is auth **presence only**. `ANTHROPIC_API_KEY` is set in the ambient environment, so `checkProviderAuth` returns configured without any network validation. The 401 only surfaces on the real request. | `pi-ai/dist/providers/anthropic.js:16-35`. Probe B: dummy key → `{"anthropic":14,"minimax":3}`. |
| RC4 | `/aies-models` cannot show a disconnected provider | It reads only `ctx.modelRegistry.getAvailable()`, which by construction excludes every unauthenticated model. There is no second section and no status source. | `extensions/aies-models/capabilities.ts:135-160`. |
| RC5 | `/aies-commandcode` misreports auth | It reads `process.env.COMMANDCODE_API_KEY` directly, so a stored credential reports "sin variable de entorno". | `extensions/aies-provider-commandcode/index.ts:249`. |

The only sound runtime signal that a credential is *rejected* (as opposed to
merely present) is the failed turn:

- `after_provider_response` does **not** fire on a 401 (the stream never starts).
- `error` does **not** fire.
- `turn_end` **does** fire, with `message.stopReason === "error"`,
  `message.errorMessage` = `401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}`,
  `message.provider` / `message.model` for exact attribution, and `outcome: "error"`.

## Design

Generic policy, no Anthropic special case:

```
connected + credential usable  → selectable
disconnected                   → not selectable, shown as "no conectado"
connected + credential rejected → not selectable, shown with the observed status
```

1. **`extensions/aies-providers/`** (new) owns provider credential health.
   - `health.ts` — pure classification of a failed turn into a credential
     rejection (401/403 + `authentication_error`, `invalid_api_key`,
     `permission_error`, `AccessDenied`, `Unpurchased`, `unauthorized`,
     `forbidden`). Never classifies 429, 5xx, network or abort failures.
   - `store.ts` — persists one record per provider under the `providerHealth`
     key of the isolated `$PI_CODING_AGENT_DIR/aies.json`, atomic and
     key-preserving. Stores a **truncated SHA-256 digest** of the credential so
     a re-login self-heals the record; the secret itself is never stored,
     logged or rendered.
   - `index.ts` — Pi wiring only: the `turn_end` observer. No startup network,
     no new command.
2. **`/aies-models`** projects the registry into provider sections using the
   public `getAll()`, `getAvailable()`, `getProviderAuthStatus()` and
   `getRegisteredProviderIds()`. Only usable models stay selectable; the rest
   render as a bounded, clearly marked non-selectable block.

   Measured universe (isolated probe, Pi 0.87.0): `getAll()` returns **41
   providers and ~1600 models**, while `getAvailable()` returns 2-3 providers.
   Enumerating every disconnected vendor would drown the signal, so the
   non-selectable block is deliberately scoped to:

   - providers with a recorded credential rejection (the Anthropic case);
   - extension-registered providers from `getRegisteredProviderIds()` that are
     not usable (the CommandCode-not-logged-in case);
   - one bounded summary line counting the remaining disconnected vendors and
     pointing at Pi's own `/login <provider>`.

   Because a usable catalog can now hold ~95 models (76 of them CommandCode),
   the picker gains a provider step: `role → provider → model → thinking`.
   A flat alphabetical list would bury Qwen behind 76 CommandCode rows.
3. **`/aies-commandcode`** reports auth from `getProviderAuthStatus` (source
   `stored` / `environment` / `runtime`) instead of `process.env`.
4. **Provider registration is unchanged.** `apiKey: "$COMMANDCODE_API_KEY"`
   stays: env for CI/headless, `auth.json` for ordinary use, stored wins.

## Tasks

- [x] **T1 — Provider credential health core.** `extensions/aies-providers/{health,store,index}.ts` + `tests/provider-health.test.mjs`. 38 tests, TDD red→green.
- [x] **T2 — `/aies-models` provider sections + provider step.** `providers.ts` projection; `role → provider → model → thinking`. Suite 915.
- [x] **T3 — `/aies-commandcode` real auth status + headless bounding.** Registry-driven `auth`/`disponibles` lines; the headless `No seleccionables:` block no longer truncates away. Suite 928.
- [x] **T4 — Isolation: stored-credential discovery.** 76 models resolve from `auth.json` with no env var, 0 when disconnected, catalog resolves from an unrelated `cwd`, still offline. Suite 933.
- [x] **T10 — `/aies-models` v2 UX (user-requested mid-ticket).** Live type-ahead search, Pi-style `all`/`scoped` Tab toggle, the role step shows each role's current model, and the overlay's non-selectable block collapses to one bounded summary line.
- [x] **T5 — Docs.** Minimal README provider section (`/login commandcode` as the ordinary path, env var as CI/headless) + a DECISIONS entry for the credential-health policy.
- [x] **T6 — Repository gates.** `npm test`, `npm run check:isolation`, `bash -n bin/aies scripts/*.sh`, `git diff --check`.
- [x] **T7 — Real smoke (EZE-453).** Isolated `AIES_HOME`: fresh profile → disconnected UX → `/login commandcode` → restart → auth persists → `/aies-models` → select a real model → minimal real request succeeds → Anthropic 401 not usable. No secret ever printed.
- [ ] **T8 (BLOQUEADO → EZE-454) — EZE-436 real-use gate.** One disposable small fixture driving Explore → Worker → Verify; check the active-agent card, live elapsed/tokens/cost, `/agents` child data, card teardown, single DONE output.
- [x] **T9 — Git discipline + Linear.** Stage only EZE-453 files, preserve concurrent changes byte-for-byte, work-unit Conventional Commits, EZE-453 → Done.

## User feedback round (mid-ticket)

The user reviewed the T2/T3 result and asked for four changes, choosing between
presented options:

| Ask | Decision |
|---|---|
| Search models while choosing | **Type-ahead always filters in the model step**; arrows navigate there. This is exactly Pi's own `/model` rule: every byte that matches no keybinding action goes to the search input. `j`/`k`/`q` therefore stop being navigation aliases *in the model step only*. |
| `all` / `scoped` like Pi's `/model` | **Tab toggles**, `Scope: [all] scoped` indicator, initial scope `scoped` when `ctx.scopedModels` is non-empty — Pi's rule verbatim. |
| The non-selectable block is not really needed | **Collapse to one bounded summary line in the overlay**: `2 providers no utilizables · anthropic (401), llama.cpp`. The headless report keeps the detailed block: it is the diagnostic surface and costs no screen rows. |
| See which model each role has | **The role step shows each role's current assignment** — Parent from the live session model, Explore/Worker/Verify from the persisted child preferences. |

Reference implementation read from Pi 0.87.0
`dist/modes/interactive/components/model-selector.js`:
`scope = scopedModels.length > 0 ? "scoped" : "all"`; Tab is `tui.input.tab` and
only toggles when scoped items exist; a non-empty query resets the selection to
the best match; an empty result renders `No matching models`; rows carry an
`(i/n)` scroll indicator. `@earendil-works/pi-tui` is **not** present in this
repository's `node_modules`, so `fuzzyFilter` cannot be imported and AIES
implements its own pure subsequence matcher. Pi's search haystack is
`` `${provider} ${provider}/${id} ${provider} ${id}${name ? " " + name : ""}` ``
(`getModelSelectorSearchText`), which AIES mirrors so ranking feels native.

## Boundaries

No release, no website, no AIES-011, no README rewrite beyond the provider
section, no change to the ambient Pi installation, no `git add .`, no
`git commit -a`.

## Evidence

| Task | Outcome | Commit |
|---|---|---|
| T1 | Credential-health core: pure classifier, isolated atomic store, one `turn_end` observer. 38 tests, TDD red→green. | `8fa21ce` |
| T2 | Provider projection + provider-first picker. Suite 915. | `cd9ff06` |
| T3 | `/aies-commandcode` reads `getProviderAuthStatus` instead of `process.env`; the headless `No seleccionables:` block no longer truncates away at 12 lines. Suite 928. | `cd9ff06` |
| T4 | Stored credential with **no** env var resolves 76 models; 0 when disconnected; catalog resolves from an unrelated `cwd`; still offline. Suite 933. | `d721304` |
| T10 | Type-ahead search, `all`/`scoped` Tab toggle, per-role current model, one-line non-usable summary. Suite 982. | `cd9ff06` |
| — | Measured `maxTokens` override: the provider API rejected 64000 for `poolside/laguna-s-2.1-free` with a real cap of 32768. Per-model override, not a global clamp change. Suite 995. | `d721304` |
| T5 | README auth ordering corrected, `aies-providers` documented, D26 consequence amended, D27/D28 added. | `8907e5f` |
| T6 | `npm test` 982/196 → 995/204 green; `npm run check:isolation` green with a temp `PI_CODING_AGENT_DIR`; `bash -n` silent; `git diff --check` clean; `~/.pi/agent/{settings,auth,models}.json` hashes identical before and after. | — |
| T7 | Real smoke passed. See below. | — |
| T8 | **Not conclusive.** Blocked by a pre-existing defect, filed as EZE-454. | — |
| T9 | Five work-unit commits, explicit paths only, zero overlap with the concurrent EZE-436 unit. | `d721304`…`b6bacbb` |

### T7 — real smoke, isolated `AIES_HOME`, tmux PTY, Pi 0.87.0

| # | Step | Result |
|---|---|---|
| 1-2 | Fresh profile, AIES opened with no CommandCode auth | `auth.json` empty (2 bytes); dock auto-selected `anthropic / Claude Opus 4.8` |
| 3 | Disconnected UX | `/aies-models` provider step: `2 providers no utilizables · commandcode, llama.cpp` |
| 4 | Authenticate through the supported flow | `/login commandcode` → Pi listed `commandcode  Command Code · API key` → secret prompt `Login to Command Code / Enter API key` → Pi confirmed `Saved API key for Command Code. Credentials saved to /tmp/aies-eze453-smoke/agent/auth.json` |
| 5-6 | Close and reopen | `C-d`, clean exit with a resume hint; relaunched |
| 7 | Auth persists with **no** env var | `ENVVAR_AUSENTE` asserted in the same shell, then `› Command Code (76)` usable |
| 8-9 | `/aies-models` | 76 CommandCode models selectable |
| 10 | Select a real model | search `sante` → `Parent: commandcode/inclusionai/ling-3.0-flash-sante:free · off`; the vendor-prefixed id survived intact |
| 11-12 | Minimal real request | answered `LISTO`; rail showed `Total 6.1k` tokens and `Coste Total $0.00` (a real zero, not `—`) |
| 13 | Anthropic 401 not usable | a real 401 turn recorded `{provider: anthropic, status: 401, reason: authentication_error, fingerprint: 571e8d80…}` — digest only, no secret — and the provider step became `2 providers no utilizables · anthropic (401), llama.cpp` with Anthropic gone from the usable list |

Also observed live: the health warning fired exactly once (`anthropic · credencial rechazada · HTTP 401 · authentication_error — no queda seleccionable en /aies-models`), and a provider HTTP 400 for `max_tokens` was correctly **not** classified as a credential rejection.

### T8 — EZE-436 real-use gate: not conclusive

A disposable fixture (`sum.mjs` with `a - b`, one failing `node --test`) was run with an explicit Explore → Worker → Verify instruction. `aies_delegate role=explore` failed:

```
### Explore Result: FAILED
**Summary**: Explore session failed: No API key found for commandcode.
```

The Parent then solved the fixture inline (the file was fixed and the test passed), so the rail never entered a real child delegation and no EZE-436 evidence could be collected.

Root cause, confirmed by reading the code: `delegate.ts` passes `modelRuntime: ctx.modelRegistry`; `isSessionModelRuntime` requires `getAuth`, which Pi's `ModelRegistry` facade does not expose (it has `getProviderAuth`), so the child is created with `modelRuntime: undefined`; the child loader also sets `noExtensions: true`, so it never registers `commandcode`; `resolveAgentModel` then falls back to the parent's `commandcode/...` model object, which the child runtime cannot authenticate. Built-in and `models.json` providers are unaffected, which is why earlier child smokes passed.

This is a latent pre-existing defect that EZE-453 exposed by introducing the first extension-registered provider. It was **not** fixed here: `session.ts`, `explore.ts`, `worker.ts` and `verify.ts` all held uncommitted concurrent EZE-436 work at the time. Filed as **EZE-454** with the root cause, the files and the acceptance criteria.

### Known limitations

1. **EZE-454** — extension-registered provider models work for Parent but not for Explore/Worker/Verify.
2. A credential rejection is only known after one real failing request; AIES never probes at startup, because zero-network startup is an isolation invariant.
3. `maxTokens` is still a derivation for 68 of 76 models. Only `poolside/laguna-s-2.1-free` has a measured override; a full sweep was not run because it would spend real credits. The failure mode is a loud provider HTTP 400 naming the real cap.
4. `enabledModels` remains Pi's Ctrl+P cycling scope. CommandCode models are reachable through `/aies-models` and the `all` scope but are not added to `enabledModels` automatically.
5. `docs/DECISIONS.md` defines D26–D28 on this branch while `feat/aies-settings-reseed` has a **committed** D26 (settings reseed). Merging both needs a renumber.
6. `.codegraph/` and `.cursor/rules/codegraph.mdc` are untracked tooling artifacts, deliberately left out of every commit.
