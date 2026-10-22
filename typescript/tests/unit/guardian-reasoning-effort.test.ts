import OpenAI from "openai";
import { OpenAIProvider, setDefaultModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { lunaModel } from "../../src/models/models.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import type { GuardianModelOptions } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeGuardian } from "../../src/guardian/review.js";
import type { GuardianDiagnostics, PendingExecution } from "../../src/guardian/review.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const pending: PendingExecution = {
  invocationId: "mint_effort",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the selected trip",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://travel.example.test"],
  allowedEffects: ["read"],
};
const quick: PendingExecution = { ...pending, screenedInput: '{"quick":true}' };

const readCurrent = () =>
  Effect.succeed(
    JSON.stringify({
      kind: "untrusted_source",
      path: pending.entrypoint,
      byteOffset: 0,
      source: "export default 1",
      nextOffset: 16,
      hasMore: false,
    }),
  );

/** A Responses API that records each request body and allows every review in one call. */
const wire = () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
      );
      return new Response(
        JSON.stringify({
          id: `resp_${bodies.length}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: lunaModel,
          output: [
            {
              type: "message",
              id: `msg_${bodies.length}`,
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    outcome: "allow",
                    rationale: "Current source was read",
                    action: "read",
                  }),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  setDefaultModelProvider(new OpenAIProvider({ openAIClient: client }));
  return bodies;
};

const recording = () => {
  const usage: unknown[] = [];
  const diagnostics: GuardianDiagnostics = {
    emit: (name, details) =>
      Effect.sync(() => {
        if (name === "guardian.usage") usage.push(details);
      }),
    retainModelTranscript: () => Effect.void,
    retainScreenedSource: () => Effect.void,
  };
  return { diagnostics, usage };
};

const reviewAll = (options: Omit<GuardianModelOptions, "executionEnvironment">) => {
  const { diagnostics, usage } = recording();
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
      ...options,
    }),
    diagnostics,
    {},
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      for (const review of [pending, quick, pending])
        yield* guardian.review(review, readCurrent);
      return usage;
    }),
  );
};

it("sends each review at the reasoning effort its host picks, on one model and one session", async () => {
  const bodies = wire();
  const usage = await reviewAll({
    specialize: (turn) =>
      turn.pending.screenedInput === quick.screenedInput ? { reasoningEffort: "low" } : {},
  });

  expect(bodies.map((body) => body.model)).toEqual([lunaModel, lunaModel, lunaModel]);
  expect(bodies.map((body) => (body.reasoning as { effort?: string }).effort)).toEqual([
    "medium",
    "low",
    "medium",
  ]);
  // The later reviews continue the same conversation.
  const requests = (bodies[2]?.input as { role?: string }[]).filter((item) => item.role === "user");
  expect(requests).toHaveLength(3);
  expect(usage).toEqual([
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "low" }) }),
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
  ]);
});

it("reviews at medium effort when the host picks none", async () => {
  const bodies = wire();
  const usage = await reviewAll({});

  expect(bodies.map((body) => (body.reasoning as { effort?: string }).effort)).toEqual([
    "medium",
    "medium",
    "medium",
  ]);
  expect(usage).toEqual([
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
  ]);
});
