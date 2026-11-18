import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

describe("AgentSession retryLastTurn", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("retries the latest failed response in place without duplicating its user message", async () => {
		const requests: string[] = [];
		const prompts: string[] = [];
		const respond =
			(text: string, stopReason?: "error"): FauxResponseStep =>
			(_context, options, _state, model) => {
				requests.push(`${model.id}:${options?.reasoning ?? "off"}`);
				return fauxAssistantMessage(text, {
					stopReason,
					errorMessage: stopReason === "error" ? "overloaded_error" : undefined,
				});
			};
		harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (event.messageType === "user") prompts.push(event.prompt);
					});
				},
			],
		});
		harness.setResponses([respond("failed partial", "error"), respond("second answer")]);

		await harness.session.prompt("same prompt");
		const userEntry = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntry).toBeDefined();

		await harness.session.setModel(harness.getModel("faux-2")!);
		harness.session.setThinkingLevel("high");
		await harness.session.retryLastTurn();

		expect(requests).toEqual(["faux-1:off", "faux-2:high"]);
		expect(prompts).toEqual(["same prompt", "same prompt"]);
		expect(getUserTexts(harness)).toEqual(["same prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["second answer"]);

		const entries = harness.sessionManager.getEntries();
		const allMessages = entries.filter((entry) => entry.type === "message");
		expect(allMessages.filter((entry) => entry.message.role === "user")).toHaveLength(1);
		const assistantEntries = allMessages.filter((entry) => entry.message.role === "assistant");
		expect(assistantEntries).toHaveLength(2);
		expect(assistantEntries[0]?.parentId).toBe(userEntry?.id);
		const omission = entries.find(
			(entry) => entry.type === "context_edit" && entry.targetId === assistantEntries[0]?.id,
		);
		expect(omission).toMatchObject({ replacement: null });
		expect(assistantEntries[1]?.parentId).toBe(omission?.id);
	});

	it("rejects when the active branch has no user turn", async () => {
		harness = await createHarness();

		await expect(harness.session.retryLastTurn()).rejects.toThrow("Nothing to retry");
		expect(harness.sessionManager.getEntries()).toEqual([]);
	});
});
