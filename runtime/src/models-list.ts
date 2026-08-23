// src/models-list.ts — formateo de catálogo de modelos por provider (/models).
//
// getModels() en pi es SÍNCRONO y no requiere red: providers estáticos (anthropic, openai,
// minimax, ...) devuelven su catálogo embebido tal cual; providers dinámicos devuelven lo
// último cacheado (vacío si nunca se ha hecho refresh()). No hace falta login para listar.

import type { AuthRuntime, ModelInfo } from "./auth.js";

/** Filtro simple, insensible a mayúsculas, sobre id/name — sin dependencias externas. */
export function searchModels(models: readonly ModelInfo[], query: string | undefined): ModelInfo[] {
	const q = query?.trim().toLowerCase();
	if (!q) return [...models];
	return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
	return String(n);
}

/**
 * ModelCost.input/output de pi YA vienen en $/1M tokens (verificado contra el catálogo real:
 * gpt-4 → {input:30, output:60}, igual que la tabla de precios pública de OpenAI). Nada que
 * escalar — multiplicar por 1e6 aquí fue el primer intento y disparaba precios delirantes
 * ($30 000 000/1M en vez de $30/1M).
 */
function formatCostPerMTok(perMillionTokens: number): string {
	if (perMillionTokens <= 0) return "gratis";
	return `$${perMillionTokens.toFixed(2)}`;
}

export function formatModelLine(m: ModelInfo): string {
	const ctx = formatTokens(m.contextWindow);
	const out = formatTokens(m.maxTokens);
	const cost = `${formatCostPerMTok(m.cost.input)} in / ${formatCostPerMTok(m.cost.output)} out`;
	const think = m.reasoning ? " · thinking" : "";
	return `  ${m.id.padEnd(28)} ctx ${ctx.padEnd(6)} out ${out.padEnd(6)} ${cost}${think}`;
}

export function formatModelsTable(models: readonly ModelInfo[]): string {
	if (models.length === 0) return "  (sin resultados)";
	return models.map(formatModelLine).join("\n");
}

/** Provider a listar: el pasado por argumento, o todos los registrados si se omite. */
export function resolveModelsForListing(runtime: AuthRuntime, providerId: string | undefined): ModelInfo[] {
	if (providerId) return [...runtime.getModels(providerId)];
	return [...runtime.getModels()];
}

/**
 * Gramática compartida entre `/models` (REPL) y `aies models` (CLI):
 *   ""                → { providerId: defaultProvider, query: undefined }
 *   "gpt"              → busca "gpt" dentro de defaultProvider
 *   "@openai"          → lista defaultProvider → openai, sin filtro
 *   "@openai gpt"      → lista openai, filtrado por "gpt"
 *
 * El prefijo `@` evita la ambigüedad de "¿el primer token es un provider o parte de la
 * búsqueda?" — sin él, buscar "gpt" se leería como "cambia al provider gpt".
 */
export function parseModelsQuery(
	arg: string,
	defaultProvider: string,
): { providerId: string; query: string | undefined } {
	const trimmed = arg.trim();
	if (trimmed.startsWith("@")) {
		const sp = trimmed.indexOf(" ");
		const providerId = sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp);
		const query = sp === -1 ? undefined : trimmed.slice(sp + 1).trim() || undefined;
		return { providerId, query };
	}
	return { providerId: defaultProvider, query: trimmed || undefined };
}
