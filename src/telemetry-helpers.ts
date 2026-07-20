import { basename } from "node:path";
import type { Config } from "./config.js";
import type { PiUsage, PromptState } from "./lifecycle-types.js";
import { appendRawTrace } from "./raw-trace.js";
import { redactionMetadata, redactString } from "./redaction.js";
import type { SessionState } from "./session-state.js";

export function truncate(text: string, max = 1200) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function telemetryText(config: Config, text: string, max: number) {
	const scanLimit = Math.max(max * 2, max + 500);
	const bounded =
		text.length > scanLimit
			? `${text.slice(0, scanLimit)}…[truncated ${text.length - scanLimit} chars]`
			: text;
	return truncate(redactString(config, bounded), max);
}

export function safeJson(config: Config, value: unknown, max = 1200) {
	try {
		return telemetryText(config, JSON.stringify(value, null, 2), max);
	} catch {
		return "[unserializable]";
	}
}

export function summarizeToolArgs(
	config: Config,
	toolName: string,
	args: unknown,
) {
	if (!args || typeof args !== "object")
		return safeJson(config, args, config.toolArgsMaxChars);
	const data = args as Record<string, unknown>;
	switch (toolName) {
		case "bash":
			return telemetryText(
				config,
				String(data.command ?? ""),
				config.toolArgsMaxChars,
			);
		case "read":
			return telemetryText(
				config,
				`${String(data.path ?? "")}#${String(data.offset ?? 1)}:${String(data.limit ?? "")}`,
				config.toolArgsMaxChars,
			);
		case "write":
		case "edit":
			return telemetryText(
				config,
				String(data.path ?? ""),
				config.toolArgsMaxChars,
			);
		case "web_search":
			return telemetryText(
				config,
				String(
					data.query ??
						(Array.isArray(data.queries) ? data.queries.join(" | ") : ""),
				),
				config.toolArgsMaxChars,
			);
		default:
			return safeJson(config, args, config.toolArgsMaxChars);
	}
}

export function extractTextFromContent(
	content: Array<{ type: string; text?: string }> | undefined,
) {
	if (!content?.length) return "";
	return content
		.filter((item) => item.type === "text" && item.text)
		.map((item) => item.text)
		.join("\n");
}

export function summarizeMessageContent(config: Config, content: unknown) {
	if (typeof content === "string") {
		return telemetryText(config, content, config.traceInputMaxChars);
	}
	if (Array.isArray(content)) {
		const text = extractTextFromContent(
			content.slice(0, 20) as Array<{ type: string; text?: string }>,
		);
		if (text) return telemetryText(config, text, config.traceInputMaxChars);
		return `[${content.length} content item(s)]`;
	}
	if (content && typeof content === "object") {
		const maybeContent = (content as { content?: unknown }).content;
		if (Array.isArray(maybeContent))
			return summarizeMessageContent(config, maybeContent);
		return "[object content]";
	}
	return content == null ? "" : String(content);
}

export function summarizeMessages(
	config: Config,
	messages: Array<{ role?: string; content?: unknown }>,
) {
	const limit = 40;
	const selected = messages.slice(-limit).map((message) => ({
		role: message.role || "unknown",
		content: summarizeMessageContent(config, message.content),
	}));
	if (messages.length > limit) {
		selected.unshift({
			role: "system",
			content: `[truncated ${messages.length - limit} earlier message(s)]`,
		});
	}
	return selected;
}

export function summarizeProviderPayload(
	config: Config,
	payload: unknown,
	fallbackModel: string,
) {
	if (!payload || typeof payload !== "object") return { type: typeof payload };
	const data = payload as Record<string, unknown>;
	const messages = Array.isArray(data.messages)
		? summarizeMessages(
				config,
				data.messages as Array<{ role?: string; content?: unknown }>,
			)
		: undefined;
	return {
		model: typeof data.model === "string" ? data.model : fallbackModel,
		messageCount: Array.isArray(data.messages)
			? data.messages.length
			: undefined,
		messages,
		keys: Object.keys(data).slice(0, 50),
	};
}

export function estimateJsonBytes(value: unknown) {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf-8");
	} catch {
		return undefined;
	}
}

export function summarizeProviderRequestMessages(
	config: Config,
	messages: unknown,
) {
	if (!Array.isArray(messages)) return undefined;
	return summarizeMessages(
		config,
		messages as Array<{ role?: string; content?: unknown }>,
	);
}

export function redactToolContent(config: Config, result: unknown): string {
	if (!result) return "";
	if (typeof result === "string") return redactString(config, result);
	if (typeof result === "object") {
		const data = result as {
			content?: Array<{ type: string; text?: string }>;
		};
		if (data.content) {
			const textParts: string[] = [];
			let imageCount = 0;
			for (const item of data.content) {
				if (item.type === "text" && item.text) {
					textParts.push(item.text);
				} else if (item.type === "image" || item.type === "image_url") {
					imageCount++;
				}
			}
			let result = textParts.join("\n");
			if (imageCount > 0) {
				result += `${result ? "\n" : ""}[${imageCount} image content block(s) from tool result]`;
			}
			if (result) return redactString(config, result);
		}
	}
	try {
		return redactString(config, JSON.stringify(result, null, 2));
	} catch {
		return "[unserializable]";
	}
}

export function summarizeToolResult(config: Config, result: unknown) {
	if (!result) return "";
	if (typeof result === "string")
		return telemetryText(config, result, config.toolOutputMaxChars);
	if (typeof result === "object") {
		const data = result as { content?: Array<{ type: string; text?: string }> };
		const text = extractTextFromContent(data.content);
		if (text) return telemetryText(config, text, config.toolOutputMaxChars);
	}
	return safeJson(config, result, config.toolOutputMaxChars);
}

export function usageDetailsFromUsage(usage?: PiUsage) {
	if (!usage) return undefined;
	const details: Record<string, number> = {};
	if (usage.input) details.input = usage.input;
	if (usage.output) details.output = usage.output;
	if (usage.cacheRead) details.input_cached_read = usage.cacheRead;
	if (usage.cacheWrite) details.input_cached_write = usage.cacheWrite;
	if (usage.totalTokens) details.total = usage.totalTokens;
	return Object.keys(details).length > 0 ? details : undefined;
}

export function standardUsageFromUsage(usage?: PiUsage) {
	if (!usage) return undefined;
	const standard: Record<string, number> = {};
	if (usage.input) standard.input = usage.input;
	if (usage.output) standard.output = usage.output;
	if (usage.totalTokens) {
		standard.total = usage.totalTokens;
	} else if (usage.input || usage.output) {
		standard.total = (usage.input ?? 0) + (usage.output ?? 0);
	}
	return Object.keys(standard).length > 0 ? standard : undefined;
}

export function costDetailsFromUsage(usage?: PiUsage) {
	const cost = usage?.cost;
	if (!cost) return undefined;
	const details: Record<string, number> = {};
	if (typeof cost.input === "number") details.input = cost.input;
	if (typeof cost.output === "number") details.output = cost.output;
	if (typeof cost.total === "number") details.total = cost.total;
	return Object.keys(details).length > 0 ? details : undefined;
}

export function getUserId(config?: Config) {
	return config?.userId || undefined;
}

export function getRuntimeName() {
	return process.env.TIA_ACTIVE === "1" ? "tia" : "pi";
}

export function getSessionRoot(sessionFile: string) {
	const marker = "/sessions/";
	const index = sessionFile.indexOf(marker);
	return index >= 0
		? sessionFile.slice(0, index + marker.length - 1)
		: undefined;
}

function rawTraceBase(state: SessionState<PromptState>, turnIndex?: number) {
	return {
		timestamp: new Date().toISOString(),
		sessionId: state.sessionId || undefined,
		sessionFile: state.sessionFile || undefined,
		turnIndex,
		provider: state.provider || undefined,
		model: state.model || undefined,
		runtime: getRuntimeName(),
	};
}

export function currentTurnIndex(prompt: PromptState) {
	const activeTurns = Array.from(prompt.activeTurns.values());
	return activeTurns.length > 0
		? activeTurns[activeTurns.length - 1]?.index
		: undefined;
}

export function writeRawTrace(
	config: Config,
	state: SessionState<PromptState>,
	record: { type: string } & Record<string, unknown>,
) {
	appendRawTrace(config, state.sessionFile, {
		...rawTraceBase(
			state,
			typeof record.turnIndex === "number" ? record.turnIndex : undefined,
		),
		redaction: redactionMetadata(config),
		traceId: state.promptState?.trace?.id,
		...record,
	});
}

export function buildTraceTags(
	config: Config | undefined,
	state: SessionState<PromptState>,
	cwd: string,
) {
	const runtime = getRuntimeName();
	const tags = [
		"pi",
		"pi-langfuse",
		`runtime:${runtime}`,
		...(config?.defaultTags ?? []),
	];
	const projectName = basename(cwd || process.cwd());
	if (projectName) tags.push(`project:${projectName}`);
	if (state.provider) tags.push(`provider:${state.provider}`);
	if (state.model) tags.push(`model:${state.model}`);
	if (state.sessionReason) tags.push(`session:${state.sessionReason}`);
	return Array.from(new Set(tags)).slice(0, 20);
}
