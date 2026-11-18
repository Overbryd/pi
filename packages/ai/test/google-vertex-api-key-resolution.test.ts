import { arch, platform, release } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	requestCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* (params: Record<string, unknown>) {
				googleGenAiMock.requestCalls.push(params);
				yield {
					responseId: "vertex-response-id",
					candidates: [
						{
							content: { parts: [{ text: "ok" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 1,
						totalTokenCount: 2,
					},
				};
			},
		};

		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}
	}

	return {
		GoogleGenAI,
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import type { Model } from "../src/types.ts";

const PI_USER_AGENT = `pi (${platform()} ${release()}; ${arch()})`;
const model = getModel("google-vertex", "gemini-3-flash-preview");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

const originalGoogleCloudApiKey = process.env.GOOGLE_CLOUD_API_KEY;

beforeEach(() => {
	googleGenAiMock.constructorCalls.length = 0;
	googleGenAiMock.requestCalls.length = 0;
	for (const name of [
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"GOOGLE_APPLICATION_CREDENTIALS",
	]) {
		vi.stubEnv(name, undefined);
	}
	delete process.env.GOOGLE_CLOUD_API_KEY;
});

afterEach(() => {
	vi.unstubAllEnvs();
	if (originalGoogleCloudApiKey === undefined) {
		delete process.env.GOOGLE_CLOUD_API_KEY;
	} else {
		process.env.GOOGLE_CLOUD_API_KEY = originalGoogleCloudApiKey;
	}
});

describe("google-vertex api key resolution", () => {
	it("falls back to ADC when options.apiKey is a placeholder marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "<authenticated>",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when options.apiKey is the gcp-vertex-credentials marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "gcp-vertex-credentials",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when GOOGLE_CLOUD_API_KEY is a placeholder marker", async () => {
		process.env.GOOGLE_CLOUD_API_KEY = "<authenticated>";

		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("still uses the API key client for real API keys", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("project");
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("location");
	});

	it("keeps scoped routing in native API-key authentication results", async () => {
		const env = { GOOGLE_CLOUD_PROJECT: "test-project", GOOGLE_CLOUD_LOCATION: "global" };
		const result = await googleVertexProvider().auth.apiKey?.resolve({
			credential: { type: "api_key", key: "test-key", env },
			ctx: { env: async () => undefined },
			signal: new AbortController().signal,
		} as never);
		expect(result).toMatchObject({ auth: { apiKey: "test-key" }, env });
	});

	it("preserves provider-scoped global routing when an API key is configured", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "wrong-project");
		vi.stubEnv("GOOGLE_CLOUD_LOCATION", "europe-west1");
		await streamGoogleVertex(model, context, {
			apiKey: "test-key",
			env: {
				GOOGLE_CLOUD_PROJECT: "test-project",
				GOOGLE_CLOUD_LOCATION: "global",
				GOOGLE_APPLICATION_CREDENTIALS: "/unused/adc.json",
			},
		}).result();
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			apiKey: "test-key",
			project: "test-project",
			location: "global",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("googleAuthOptions");
	});

	it("uses an environment API key before ADC, including when the caller passes an ADC marker", async () => {
		await streamGoogleVertex(model, context, {
			apiKey: "<authenticated>",
			env: {
				GOOGLE_CLOUD_API_KEY: "environment-key",
				GOOGLE_CLOUD_PROJECT: "test-project",
				GOOGLE_CLOUD_LOCATION: "global",
				GOOGLE_APPLICATION_CREDENTIALS: "/unused/adc.json",
			},
		}).result();
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			apiKey: "environment-key",
			project: "test-project",
			location: "global",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("googleAuthOptions");
	});

	it("passes a configured timeout to the Google request", async () => {
		await streamGoogleVertex(model, context, { apiKey: "test-key", timeoutMs: 120_000 }).result();
		expect(googleGenAiMock.requestCalls[0]).toMatchObject({ config: { httpOptions: { timeout: 120_000 } } });
	});

	it("does not forward generated Vertex base URL placeholders", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]?.httpOptions).toEqual({
			headers: { "User-Agent": PI_USER_AGENT },
		});
	});

	it("lets explicit headers override the default User-Agent", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
			headers: { "User-Agent": "custom-agent" },
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]?.httpOptions).toEqual({
			headers: { "User-Agent": "custom-agent" },
		});
	});

	it("forwards custom baseUrl to the ADC client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("forwards custom baseUrl to the API key client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("does not append apiVersion when custom baseUrl already includes one", async () => {
		const customModel: Model<"google-vertex"> = {
			...model,
			baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
		};
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			httpOptions: {
				baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
				baseUrlResourceScope: "COLLECTION",
				apiVersion: "",
			},
		});
	});
});
