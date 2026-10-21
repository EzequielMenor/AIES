# `/aies-design`

Design work is opt-in. Start with a concrete objective, for example:

```text
/aies-design Improve the onboarding flow
```

The workflow first classifies the objective as a new product, redesign, or
improvement. It inspects the real project structure, relevant documentation,
current UI, styles, and assets before asking product questions or proposing a
design; findings should describe what is actually present, not just list paths.
It stays scoped to the objective and does not create a full design system.

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
  UI, styles and assets with its normal read-only tools before asking or proposing,
  and never to ask what the project can answer. There is no tool gate: a rigid guard
  would block legitimate short objectives.
- **Explore when context is missing.** If inspection leaves relevant context missing
  or the project is too large to read directly, and `aies_delegate` exists, discovery
  goes to its `explore` role. It is never launched by obligation.
- **Cancelling with a pending kickoff.** An idle session starts the kickoff turn at
  once. A busy one stores the kickoff for the next user message instead of queuing a
  follow-up (an extension cannot withdraw a queued follow-up, so a cancel would still
  be followed by a turn). After a cancel the stored kickoff is inert.
- **Automatic close.** When the final message of a run ends with a line containing
  exactly `AIES_DESIGN_DONE`, the workflow closes itself and the session is normal.

