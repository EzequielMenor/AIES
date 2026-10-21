# `/aies-design`

Design work is opt-in. Start with a concrete objective, for example:

```text
/aies-design Improve the onboarding flow
```

The workflow inspects the real project structure, relevant documentation,
current UI, styles, assets, and existing technical/brand conventions before
asking questions. It turns the objective and that evidence into a compact,
actionable Brief V0: product/screen goal; primary user and task; what to preserve
and change; existing technical and brand constraints; personality/references
only when needed; and observable success criteria. Findings distinguish
observations from inferences, and evidence should be described rather than just
listing paths.

Questions are limited to unresolved material decisions, with an explanation of
the Brief/design decision each answer blocks. The workflow infers confidently
from evidence, uses no fixed questionnaire, and asks zero questions when the
evidence is sufficient. Explore delegation is conditional on relevant context
remaining missing or the project being too large to inspect directly. This is
discovery only: it does not open new design directions or implement visuals. The
brief stays in this execution context/ticket; it is never automatically written
to `PRODUCT.md`, `DESIGN.md`, or another planning artifact in the repository.

End the workflow explicitly at any time with `/aies-design cancel`, `/aies-design
exit`, or `/aies-design complete` (also `/aies-design done`). While it is active,
plain `cancel`, `cancel design`, `stop design`, `exit design`, `finish design`,
and `finish design workflow` also end it; unrelated prompts are not intercepted.
Cancellation aborts the active Pi turn and discards queued workflow guidance.
These actions remove the session-local design instructions, and normal prompts
proceed as usual. Empty `/aies-design` does not enable the workflow. State is not
persisted or restored across a new, resumed, or forked session.

## Lifecycle details

- **Inspection first.** The workflow instructs the model to inspect structure, docs,
  UI, styles, assets and conventions with its normal read-only tools before asking
  questions. There is no tool gate: a rigid guard would block legitimate short
  objectives. The prompt contract describes the required Brief V0, evidence-based
  inference, material-question threshold and non-persistence boundary; it does
  not prove live-model compliance.
- **Explore when context is missing.** If inspection leaves relevant context missing
  or the project is too large to read directly, and `aies_delegate` exists, discovery
  goes to its `explore` role. It is never launched by obligation.
- **Cancelling with a pending kickoff.** An idle session starts the kickoff turn at
  once. A busy one stores the kickoff for the next user message instead of queuing a
  follow-up (an extension cannot withdraw a queued follow-up, so a cancel would still
  be followed by a turn). After a cancel the stored kickoff is inert.
- **Automatic close.** When the final message of a run ends with a line containing
  exactly `AIES_DESIGN_DONE`, the workflow closes itself and the session is normal.

