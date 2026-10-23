import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse, UsageInput } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { MintDiagnostics } from "../../src/mint/diagnostics.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import type { MintAgentSnapshot, MintRecoveryFactory } from "../../src/mint/recovery-contracts.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

/**
 * A call's usage as the SDK's Responses model builds it from a reply to a request with a
 * 12-hour cache breakpoint: the provider splits its cache writes by lifetime in a nested
 * `cache_write_tokens_details`, which the SDK copies as given.
 */
const providerUsage = () => {
  const input_tokens_details = {
    cached_tokens: 1_024,
    cache_write_tokens: 640,
    cache_write_tokens_details: { ttl_30m_tokens: 128, ttl_12h_tokens: 512 },
  };
  const output_tokens_details = { reasoning_tokens: 30 };
  const raw = {
    inputTokens: 2_000,
    outputTokens: 40,
    totalTokens: 2_040,
    inputTokensDetails: input_tokens_details,
    outputTokensDetails: output_tokens_details,
  };
  return new Usage({
    ...raw,
    requestUsageEntries: [{ ...raw, endpoint: "responses.create" }],
  } as unknown as UsageInput);
};

const call = (name: string, input: object): ModelResponse => ({
  usage: providerUsage(),
  output: [
    {
      type: "function_call",
      name,
      callId: name,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const finish = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};

/** A host's recovery boundary: it saves the run state before each model call. */
const savedStates: string[] = [];
const recoveryFactory: MintRecoveryFactory = () =>
  Effect.succeed({
    model: (state, counters, invoke) =>
      Effect.gen(function* () {
        const saved: MintAgentSnapshot = {
          version: 1,
          sdkVersion: "0.18.0",
          sdkState: state(),
          ...counters,
          tools: [],
        };
        savedStates.push(saved.sdkState);
        return yield* invoke;
      }),
    tool: (_call, invoke) => invoke,
  });

it("saves the run state after a reply that splits its cache writes by lifetime, and goes on", async () => {
  savedStates.length = 0;
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return requests.length === 1 ? call("execute", example) : call("finish_build", finish);
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  const events: { name: string; details: unknown }[] = [];
  const record: MintDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      events.push({ name, details });
    });
  const f = await fixture(() => call("finish_build", finish), {
    model: makeOpenAIMinter(provider, "medium", {}, { recoveryFactory }),
    agentRecovery: { save: () => Effect.void },
    diagnostics: { emit: record, retainModelTranscript: record },
  });

  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(requests).toHaveLength(2);
  // The host saved the run state before each call, the one after the split reply included.
  expect(savedStates).toHaveLength(2);
  // The host still reads each call's cache writes split by lifetime.
  const usage = events.flatMap(({ name, details }) =>
    name === "mint.model" &&
    typeof details === "object" &&
    details !== null &&
    Reflect.get(details, "phase") === "model_usage"
      ? [details]
      : [],
  );
  expect(usage).toEqual([
    expect.objectContaining({
      call: 1,
      cachedTokens: 1_024,
      cacheWriteTokens: 640,
      cacheWrite30mTokens: 128,
      cacheWrite12hTokens: 512,
    }),
    expect.objectContaining({ call: 2, cacheWrite30mTokens: 128, cacheWrite12hTokens: 512 }),
  ]);
});
