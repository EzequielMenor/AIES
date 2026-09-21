# AIES right-rail compatibility with Pi 0.87.0

Real regression, not a feature. Pi was updated after the `AIES UI v1` freeze.
Symptom on the user's machine: AIES still starts in fullscreen, the general code
works, but the right rail no longer mounts on the right and AIES falls back to
the below-editor dock, while Gentle AI shows its own right sidebar on the same
machine and the same Pi runtime.

Scope guard: no architecture change, no routing/agents/autonomy/Linear change,
no rail redesign, no Pi downgrade. Presentation-shim compatibility only.

## Root cause (verified, not assumed)

**The AIES version guard failed. Pi's private layout internals did not change.**

`extensions/aies-ui/right-rail.ts` gates the shim on an explicit audited-minor
set:

```ts
const SUPPORTED_PI_MINORS: ReadonlySet<string> = new Set(["0.85", "0.86"]);
```

`installRightRail()` returns `noopHandle()` before it ever inspects the host, so
`active` is `false`, `showing()` is `false`, the dock-yield predicate never fires,
and the below-editor dock takes over — which is exactly the designed fallback,
behaving correctly on a guard rejection.

Observed versions on this machine:

| Surface | Pi runtime | Evidence |
| --- | --- | --- |
| `pi` (global) | 0.87.0 | `pi --version`; `pnpm` bin shim → `pi-coding-agent/dist/bundle/cli.js` at `0.87.0` |
| `aies` | 0.87.0 | `aies --aies-info` → `pi_bin=/Users/.../pnpm/bin/pi`, `pi_version=0.87.0`; the launcher `exec pi`, so AIES has no separate Pi. `extensions/aies-runtime/index.ts` imports `VERSION` from `@earendil-works/pi-coding-agent`, i.e. the host's own 0.87.0 |
| Gentle | 0.87.0 | `~/.pi/agent/settings.json` → `packages: ["npm:gentle-pi", ...]`, `lastChangelogVersion: "0.87.0"`, `tuiMode: "fullscreen"`. Gentle is a Pi *package* in the same global Pi, not its own Pi. Its `gentle-pi@3.3.0` pins `@earendil-works/pi-tui@0.85.1` only as a private library import (`ScrollView`/`VStack`), never as the host runtime |

Direct reproduction of the guard failure:

```
guard 0.85.1 -> true
guard 0.86.1 -> true
guard 0.87.0 -> false
install at 0.87 with a perfectly-shaped host -> active = false
install at 0.86 with the same host           -> active = true
```

### Upstream diff audit (Pi 0.85.1 → 0.87.0 pi-tui)

| Item | Result |
| --- | --- |
| `dist/layout-node.js` | identical (`LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node")`, `getLayoutNode` unchanged) |
| `dist/layout-node.d.ts` | identical (`StackLayoutNode { type: "vstack"\|"hstack", entries, gap, align }`) |
| `dist/layout.js` | byte-identical (MD5 `624eed4a0131380c109222c24abce831`) |
| `dist/tui-alt-screen.js` `layoutRoot` | same 7 occurrences, same semantics: `this.layoutRoot ?? this.implicitScrollView` in `doRender` |
| real diffs in that file | clipboard error flash, scroll-to-end label centering, WezTerm Kitty row clearing — none layout-compositional |
| fullscreen dock | added in Pi **0.84.0**, not in 0.86/0.87 (so it was already inside the audited range) |
| Pi 0.87 public surface | `setWidget` placement is still `aboveEditor \| belowEditor` (`rpc-types.d.ts`: `widgetPlacement?: "aboveEditor" \| "belowEditor"`); `layoutRoot` is `private` in `tui-alt-screen.d.ts`; `LAYOUT_NODE`/`getLayoutNode` are **not** exported from `pi-tui/index.d.ts` |

Conclusion: **no sufficient public API exists yet**, so exactly one presentation
shim stays. `setLayoutRoot()` is public but *replaces* Pi's root, which would make
AIES own the whole fullscreen tree instead of passively wrapping it — not a
migration target.

### Why Gentle keeps working (technical evidence, pattern extracted — not copied)

`gentle-pi/lib/shell-sidebar-layout.ts`:

- same private hook: `Symbol.for("@earendil-works/pi-tui/layout-node")`;
  `Symbol.for` is the global registry, so the key is identical across Pi copies;
- same private read: `host.layoutRoot`, `host.mode === "fullscreen"`;
- same injected node vocabulary: `{ type: "hstack", gap, align, entries: [
  { component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
  { component: scroll, basis: 50, grow: 0, shrink: 0, minSize: 50 } ] }`;
- **no version gate at all**: it relies on host feature detection
  (`mode`, `typeof root[NODE] === "function"`), on a `try/catch` that latches
  `failed = true`, and on structurally reading the host's own node
  (`reclaimFooterRow` inspects `node.type`/`node.entries`/`dock[NODE]`) before
  rewriting it;
- it re-attaches on a 100 ms timer because Pi replaces renderers without a
  session event — AIES installs from the widget factory instead, which is a
  separate concern and out of scope here.

Minimum pattern AIES adopts: **feature detection (including a structural probe of
the host's own layout node) is the real safety mechanism; the version set is only
documentation of what was hand-audited plus a fail-closed floor.**

## Tasks

| Task | Status | Notes |
| --- | --- | --- |
| R1 Re-audit Pi 0.87 layout internals and the public surface | complete | parent evidence above |
| R2 Regression-first shim capability gate + tests | complete | RED on 0.87 rail, GREEN after; suite green |
| R3 Documentation correction (D24 append + UX + README) | complete | append-only decision history |
| R4 Full automated validation | complete | `npm test`, `check:isolation`, `bash -n`, `git diff --check` |
| R5 Real smoke on the user's install (`aies` in tmux @ 200 cols) | complete | rail physically on the right, `/aies-models`, `/agents`, Ctrl+D |

## Acceptance

- Pi 0.87.0 runtime on a recognized fullscreen host → physical rail on the right.
- Layout capability absent (no `layoutRoot`, no `LAYOUT_NODE` function, non-
  fullscreen) → below-editor dock.
- Host node shape not recognized (an unverified future Pi) → dock, never a
  half-built layout; the shim latches off and delegates permanently.
- Narrow terminal → dock/footer exactly per the current breakpoints (>=120 rail,
  80–119 compact dock, <80 rich footer).
- Never rail + dock at the same time.
- Fullscreen entry/scroll/teardown stay Pi-owned; `dispose()` restores the exact
  original descriptor.
- A throwing or empty rail render must not break AIES: dock fallback, no crash.
- No architecture, routing, agents, autonomy or Linear change; no rail redesign;
  no Pi downgrade; nothing written outside the AIES repo/profile.
- Real `aies` run shows `transcript │ Status/Agents/Todos` in the window where it
  currently falls to the dock.

## Evidence

Real-runtime A/B smoke on the user's install, driven through `tmux` at `200x50`
with the production `aies` launcher:

- before the fix (stashed): no rail, and the below-editor dock
  `✧ AIES · listo · IDLE` renders under the editor at 200 columns;
- after the fix: the physical rail renders on the right —
  `╭─ ✧ AIES · listo · IDLE ─╮` with `Status` (Proyecto `AIES`, Rama
  `feat/aies-010d-fullscreen-shell`, Etapa `IDLE`, Modelo `Qwen3.8 Flash`,
  Proveedor `qwen-token-plan`, Contexto, Tiempo), `Agents` (`en espera`) and
  `Todos` (`— sin tarea activa`), and zero dock rows between editor and footer;
- resize `200` → `100` keeps the compact dock and drops the rail; `76` shows
  neither rail nor dock and keeps the rich footer; back to `200` restores the
  rail;
- `/agents` renders over the rail (`AIES Agents · sin agentes en esta sesión`);
  `/aies-models` opens its role list with the rail still mounted and no duplicate
  dock;
- `Ctrl+D` exits to the shell with no residual rail/dock rows on screen.

Automated:

- `npm test` → 760/760;
- `npm run check:isolation` → 760/760;
- `bash -n bin/aies scripts/*.sh` → clean;
- `git diff --check` → clean.

R6 follow-up (same session): `isSupportedPiVersion()` and `AUDITED_PI_MINORS`
were deleted outright. After the fix they were public and tested but consulted
by nothing — the audited minors are a strict subset of what the 0.85 floor
already admits — and a predicate named "is supported" that is not the
installation gate is the same trap that hid this regression. The hand-audited
coverage now lives only where it is read: the shim's header comment, `docs/UX.md`
§5 and D24's correction. `README.md` was also corrected: it promised the rail
only on audited minors, which the shipped probe-based gate does not do.

## Closure

- Independent read-only verification over `26cd083..HEAD` returned **PASS**: root
  cause confirmed from the pre-fix source, scope confirmed at six files (shim, its test, its
  docs), the deleted predicate confirmed unreferenced outside append-only history, and the
  probe confirmed to accept the node Pi 0.87.0 really produces (`createChatViewport` builds
  `new VStack([transcript, dock])`; `Stack[LAYOUT_NODE]()` returns `{type:"vstack", entries,
  gap, align}`). It found two wording misreadings, both fixed in `b1d6211`.
- Risk assessment was unassessable (`native command returned empty output`), so the plan
  treated the candidate as high risk and required writer self-verification plus the separate
  independent verifier above.
- Final automated state: `npm test` 760/760, `npm run check:isolation` 760/760,
  `node --test tests/fullscreen-shell.test.mjs` 42/42, `bash -n bin/aies scripts/*.sh` clean,
  `git diff --check` clean.
- Final real-runtime smoke on the committed HEAD (`aies` in tmux at 200x50): the physical rail
  renders in columns 154-201 with `Status` / `Agents` / `Todos`, and zero dock rows between
  editor and footer.
- Commits: `dc1ba1e` fix, `903a58f` + `92a0d48` + `6f5d536` + `f4a28cc` + `b1d6211` records and
  cleanup. Not pushed; push, PR and merge remain the user's decisions.
- Deliberately not done, per the user's stop condition: the additional `/agents` and
  `/aies-models` polish.
