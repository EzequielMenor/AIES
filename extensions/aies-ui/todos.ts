/**
 * The run-local Todos checklist (AIES-010D / T11).
 *
 * This is a pure, ephemeral projection of the workflow state AIES already
 * measures: the ticket, the autonomy signal, the active child and the
 * verification verdict. It invents no step and stores nothing. There is no task
 * manager, no persistence, no model-authored task and no authority: the moment
 * the state says a step happened, the row follows; the human decides, the
 * projection only reports.
 *
 * The canonical normal flow is Cargar ticket → Implementar → Verificar →
 * Sincronizar Linear → Finalizar. `Explorar` is only part of the list while the
 * real run actually explored: a projection that always showed it would claim a
 * step the workflow never took.
 */

import type { AgentsSnapshot } from "./agents.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import { singleLine } from "./format.ts";
import { GLYPH } from "./vocabulary.ts";

/** The four states a projected step can be in. */
export type TodoState = "pending" | "running" | "done" | "blocked";

/** One derived step. `key` is stable so a consumer can address a step. */
export interface TodoItem {
  key: string;
  label: string;
  state: TodoState;
}

/** The whole run's projection plus its counted progress. */
export interface TodoProjection {
  items: TodoItem[];
  done: number;
  total: number;
}

/** Glyph and tone for a derived step. */
const TODO_LOOK: Record<TodoState, { glyph: string; tone: SemanticColor }> = {
  pending: { glyph: GLYPH.pending, tone: "pending" },
  running: { glyph: GLYPH.running, tone: "running" },
  done: { glyph: GLYPH.done, tone: "success" },
  blocked: { glyph: GLYPH.blocked, tone: "error" },
};

function ticketLoaded(snapshot: AgentsSnapshot): boolean {
  if (snapshot.ticket?.active && snapshot.ticket.identifier) return true;
  return Boolean(snapshot.autonomy?.ticketId);
}

function ticketComplete(snapshot: AgentsSnapshot): boolean {
  if (snapshot.autonomy?.stopReason === "completed") return true;
  if (snapshot.ticket?.workState === "complete") return true;
  const status = singleLine(snapshot.ticket?.status ?? "").toLowerCase();
  return status === "done" || status === "completed";
}

/** Whether the real run actually used Explore, however it was observed. */
function exploreUsed(snapshot: AgentsSnapshot): boolean {
  const records = snapshot.agents ?? [];
  if (records.some((record) => singleLine(record.role) === "explore")) return true;
  return (snapshot.delegations?.byRole?.explore ?? 0) > 0;
}

/** The state of a role-driven step: the active child wins, then the count. */
function roleStep(snapshot: AgentsSnapshot, role: string): TodoState {
  if (snapshot.delegations?.activeRole === role) return "running";
  const records = snapshot.agents ?? [];
  if (records.some((record) => singleLine(record.role) === role && record.status === "completed")) return "done";
  if ((snapshot.delegations?.byRole?.[role] ?? 0) > 0 && snapshot.delegations?.activeRole !== role) return "done";
  return "pending";
}

function verificationStep(snapshot: AgentsSnapshot): TodoState {
  const verification = snapshot.verification;
  if (!verification) return "pending";
  switch (verification.status) {
    case "pass":
      return verification.valid ? "done" : "running";
    case "blocked":
    case "protocol_error":
      return "blocked";
    case "fail":
      return "blocked";
    default:
      return verification.attempts > 0 || snapshot.delegations?.activeRole === "verify" ? "running" : "pending";
  }
}

/**
 * Project the ticket run's steps from nothing but real state. An empty session
 * has an empty projection; a session with no ticket still shows the pending
 * normal flow only when the workflow has actually started something.
 */
export function deriveTodos(snapshot: AgentsSnapshot): TodoProjection {
  const items: TodoItem[] = [];

  const loaded = ticketLoaded(snapshot);
  items.push({ key: "ticket", label: "Cargar ticket", state: loaded ? "done" : "pending" });
  if (exploreUsed(snapshot)) {
    items.push({ key: "explore", label: "Explorar", state: roleStep(snapshot, "explore") });
  }

  const work = roleStep(snapshot, "worker");
  items.push({ key: "work", label: "Implementar", state: work });

  const verify = verificationStep(snapshot);
  items.push({ key: "verify", label: "Verificar", state: verify });

  const complete = ticketComplete(snapshot);
  const verified = snapshot.verification?.status === "pass" && snapshot.verification.valid;
  items.push({
    key: "linear",
    label: "Sincronizar Linear",
    state: complete ? "done" : verified ? "running" : "pending",
  });
  items.push({ key: "done", label: "Finalizar", state: complete ? "done" : "pending" });

  const done = items.filter((item) => item.state === "done").length;
  return { items, done, total: items.length };
}

export interface TodoRenderOptions {
  paint?: Paint;
  /**
   * Rows the section may occupy. When it cannot fit the heading plus every step,
   * the whole section collapses to the single `Todos · n/m` line; the human still
   * sees progress without the shell inventing height it does not have.
   */
  maxRows?: number;
}

/**
 * Render the Todos section. With room, a heading plus one row per step; without
 * it, the compact `Todos · n/m` progress line. `[]` only when there is no room
 * for even that line.
 */
export function renderTodos(projection: TodoProjection, options: TodoRenderOptions = {}): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const { items, done, total } = projection;
  if (items.length === 0) return [];

  const budget = options.maxRows;
  if (typeof budget === "number" && budget < items.length + 1) {
    return budget >= 1 ? [paint.fg("muted", `Todos · ${done}/${total}`)] : [];
  }

  const lines = [paint.fg("accent", "Todos")];
  for (const item of items) {
    const look = TODO_LOOK[item.state];
    lines.push(`  ${paint.fg(look.tone, look.glyph)} ${item.label}`);
  }
  return lines;
}
