import type { ResponseCompactionItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamCodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const TERMINAL_SSE = `data: ${JSON.stringify({
	type: "response.completed",
	sequence_number: 0,
	response: {
		id: "resp_test",
		status: "completed",
		output: [],
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	},
})}\n\ndata: [DONE]\n\n`;

function createModel<TApi extends "openai-responses" | "openai-codex-responses">(
	api: TApi,
	provider: TApi extends "openai-responses" ? "openai" : "openai-codex",
): Model<TApi> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api,
		provider,
		baseUrl: api === "openai-responses" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	} as Model<TApi>;
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* compactionEvents(item: ResponseCompactionItem): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		output_index: 0,
		sequence_number: 0,
		item,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 1,
		item,
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_test", status: "completed", output: [item] },
	} as ResponseStreamEvent;
}

async function consume(stream: ReturnType<typeof streamOpenAIResponses> | ReturnType<typeof streamCodexResponses>) {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
}

describe("OpenAI native context compaction", () => {
	afterEach(() => vi.restoreAllMocks());

	it("requests automatic compaction at 272K from both OpenAI providers", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(TERMINAL_SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const payloads: unknown[] = [];

		await consume(
			streamOpenAIResponses(createModel("openai-responses", "openai"), context, {
				apiKey: "test",
				onPayload: (payload) => void payloads.push(payload),
			}),
		);

		const claims = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }));
		await consume(
			streamCodexResponses(createModel("openai-codex-responses", "openai-codex"), context, {
				apiKey: `header.${claims}.signature`,
				transport: "sse",
				onPayload: (payload) => void payloads.push(payload),
			}),
		);

		for (const payload of payloads) {
			expect(payload).toMatchObject({
				context_management: [{ type: "compaction", compact_threshold: 272000 }],
			});
		}
	});

	it("persists, replays, and prunes before the latest encrypted compaction item", async () => {
		const model = createModel("openai-responses", "openai");
		const output = createOutput(model);
		const item: ResponseCompactionItem = {
			type: "compaction",
			id: "cmp_test",
			encrypted_content: "opaque-context",
		};

		await processResponsesStream(compactionEvents(item), output, new AssistantMessageEventStream(), model);

		expect(output.content).toHaveLength(1);
		expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "" });
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "discard me", timestamp: 0 },
				output,
				{ role: "user", content: "keep me", timestamp: 1 },
			],
		};
		const input = convertResponsesMessages(model, context, new Set(["openai"]));

		expect(input).toHaveLength(3);
		expect(input[0]).toMatchObject({ role: "developer", content: "system" });
		expect(input[1]).toMatchObject(item);
		expect(input[2]).toMatchObject({ role: "user" });
		expect(JSON.stringify(input)).not.toContain("discard me");
	});
});
