// src/auth-types.ts — tipos de autenticación de pi-ai re-declarados localmente.
//
// pi-ai define `AuthInteraction`/`AuthPrompt`/`AuthEvent` en su paquete pero NO los exporta
// desde el entrypoint público (sólo desde el path interno `./auth/types.ts`, bloqueado por
// el campo `exports`). Mantenemos una copia local sincronizada con pi-ai 0.84.x; si la upstream
// cambia, ajustamos aquí. Mantenemos sólo los miembros que AIES consume.

export type AuthType = "api_key" | "oauth";

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthPrompt = {
	signal?: AbortSignal;
} & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: readonly { id: string; label: string; description?: string }[];
	  }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "progress"; message: string };

export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}