---
name: linear-ticket
description: Procedural workflow for managing the active Linear ticket in an AIES Parent session.
---

# Linear Ticket Workflow

Linear is the single source of truth for the active ticket, its status, acceptance criteria, and relevant project metadata.
The Parent session is the sole owner of Linear operations. Isolated child agents (Explore, Worker, Verify) never access Linear directly.

## Rules of Engagement

1. **One Active Ticket**
   - Each AIES session works on at most one active Linear ticket at a time.
   - Do not switch tickets while current work is in progress unless completed or blocked.

2. **Exact Ticket Loading**
   - Load only the requested ticket using `/aies-ticket <id>` or `aies_ticket({ action: "load", ticketId: "<id>" })`.
   - Never query or dump the whole backlog or team issue lists without a concrete reason.

3. **Acceptance Criteria**
   - Use explicit criteria defined in the ticket description.
   - If not formally structured, extract explicit requirements from description checklists or statements.
   - Do not invent requirements or assume product scope.
   - Ambiguous or conflicting requirements must be flagged as blockers.

4. **Status Transitions**
   - Opening/loading a ticket does NOT change its status.
   - Transition to `started` / `In Progress` only when concrete implementation work begins.
   - Transition to `completed` / `Done` ONLY when implementation is complete AND the Verify Gate is satisfied.
   - If a blocker is encountered, keep the ticket open and report a compact blocker note.

5. **Done Gate (Verification Enforcement)**
   - For changes that affect behavior (`requiresVerification === true`), marking `complete` strictly requires a valid, fresh Verify PASS (`verifiedRevision === revision`).
   - If verification status is `none`, `fail`, `blocked`, or `stale`, marking Done is programmatically denied.
   - Documentation-only or trivial changes that do not alter behavior may complete without a Verify child.

6. **Compact Feedback & Zero Spam**
   - Do not post intermediate progress comments to Linear (no "Reading files...", "Worker started...", etc.).
   - On completion, add a single compact note detailing verified evidence and local commit reference if applicable.
   - On blocker, record a single compact note detailing the blocker cause and evidence.
