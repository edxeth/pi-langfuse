/**
 * Decode JSON-encoded OTLP ExportTraceServiceRequest payloads into a flat
 * span list with plain attribute values, mirroring how a Langfuse server
 * reads the ingestion body. Used to assert on what the extension actually
 * put on the wire.
 */

export type OtlpAttribute = { key: string; value?: OtlpAttributeValue };

export type OtlpAttributeValue = {
	stringValue?: string;
	intValue?: string;
	doubleValue?: number;
	boolValue?: boolean;
	arrayValue?: { values?: OtlpAttributeValue[] };
	kvlistValue?: { values?: OtlpAttribute[] };
};

export type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	/** Instrumentation scope name; identifies which transport sent the span. */
	scopeName?: string;
	attributes?: OtlpAttribute[];
};

export type DecodedSpan = OtlpSpan & {
	attrs: Record<string, unknown>;
};

export function decodeOtlpAttributeValue(
	value: OtlpAttributeValue | undefined,
): unknown {
	if (!value) return undefined;
	if (value.stringValue !== undefined) return value.stringValue;
	if (value.intValue !== undefined) return Number(value.intValue);
	if (value.doubleValue !== undefined) return value.doubleValue;
	if (value.boolValue !== undefined) return value.boolValue;
	if (value.arrayValue) {
		return (value.arrayValue.values ?? []).map(decodeOtlpAttributeValue);
	}
	if (value.kvlistValue) {
		return Object.fromEntries(
			(value.kvlistValue.values ?? []).map((entry) => [
				entry.key,
				decodeOtlpAttributeValue(entry.value),
			]),
		);
	}
	return undefined;
}

export function decodeOtlpPayload(body: unknown): DecodedSpan[] {
	const spans: DecodedSpan[] = [];
	const payload = body as
		| {
				resourceSpans?: Array<{
					scopeSpans?: Array<{
						scope?: { name?: string };
						spans?: OtlpSpan[];
					}>;
				}>;
		  }
		| undefined;
	for (const resource of payload?.resourceSpans ?? []) {
		for (const scope of resource.scopeSpans ?? []) {
			for (const span of scope.spans ?? []) {
				const attrs: Record<string, unknown> = {};
				for (const attribute of span.attributes ?? []) {
					attrs[attribute.key] = decodeOtlpAttributeValue(attribute.value);
				}
				spans.push({ ...span, scopeName: scope.scope?.name, attrs });
			}
		}
	}
	return spans;
}

/** Group decoded spans by span name. */
export function spansByName(
	spans: DecodedSpan[],
): Record<string, DecodedSpan[]> {
	const byName: Record<string, DecodedSpan[]> = {};
	for (const span of spans) {
		const list = byName[span.name] ?? [];
		list.push(span);
		byName[span.name] = list;
	}
	return byName;
}

/** Successive batched exports carry snapshots of the same span; keep the last. */
export function latestSpanPerId(spans: DecodedSpan[]): DecodedSpan[] {
	const latest = new Map<string, DecodedSpan>();
	for (const span of spans) latest.set(span.spanId, span);
	return [...latest.values()];
}

export function spanAttribute(span: DecodedSpan, key: string): unknown {
	return span.attrs[key];
}
