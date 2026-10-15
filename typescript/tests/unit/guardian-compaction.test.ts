// Failure modes covered: a long Guardian conversation compacts inside a review's own model calls,
// adding the compaction's time to the review; a review on a short conversation pays for a
// compaction it does not need; the compaction rewrites history a later call already sent, so the
// provider's cached prefix breaks; a failed compaction fails the review; a review that compacts
// first still lists sources as already read that the compaction took out of view, or makes the
// model read its included entrypoint again; a session restored after a takeover forgets its size.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { AgentInputItem, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { GuardianDiagnostics, PendingExecution } from "../../src/guardian/review.js";
import { GuardianSessionSnapshot } from "../../src/guardian/session.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

const native = { executionEnvironment: nativeExecutionEnvironment };
const startMs = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(startMs);
});
afterEach(() => {
  vi.useRealTimers();
  setDefaultModelProvider(new OpenAIProvider());
});

const pending: PendingExecution = {
  invocationId: "compaction_job",
  attemptId: "compaction_attempt",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the listed opening hours",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_compaction",
  allowedOrigins: ["https://hours.example.test"],
  allowedEffects: ["read"],
};
const files = () =>
  new Map([
    ["operation/operation.mjs", 'import { hours } from "./src/helper.mjs"; export default hours;'],
    ["operation/src/helper.mjs", "export const hours = () => 'synthetic-hours';"],
  ]);
const reader = (workspace = files()) =>
  makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = workspace.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
const executed: PendingExecution = {
  ...pending,
  mintContext: {
    repeatableRead: false,
    operationSources: [...files().keys()],
    executedSources: ["operation/operation.mjs", "operation/src/helper.mjs"],
    browser: "active",
    executions: [],
  },
};

const allow: ModelResponse["output"][number] = {
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: JSON.stringify({
        outcome: "allow",
        rationale: "Reads the hours only.",
        reason: null,
        findings: null,
        label: null,
        action: "read",
      }),
    },
  ],
};
const read = (id: string, path: string): ModelResponse["output"][number] => ({
  type: "function_call",
  callId: id,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({ path, offset: 0 }),
});
const compacted: ModelResponse["output"][number] = {
  type: "compaction",
  id: "cmp_before_review",
  encrypted_content: "opaque-compacted-context",
};

/** A conversation of this many tokens is long enough to compact, or well short of it. */
const longContext = 200_000;
const shortContext = 60_000;

/** Whether the request asks the provider to compact the context it is sent. */
const compactionRequest = (request: ModelRequest | undefined) => {
  const last = Array.isArray(request?.input) ? request.input.at(-1) : undefined;
  return (
    last?.type === "unknown" &&
    (last.providerData as { type?: unknown } | undefined)?.type === "compaction_trigger"
  );
};
const hasCompactionItem = (items: readonly AgentInputItem[] | ModelResponse["output"]) =>
  items.some((item) => item.type === "compaction");
const inputOf = (request: ModelRequest | undefined): AgentInputItem[] =>
  Array.isArray(request?.input) ? request.input : [];
/** The host's review request a user message carries. */
const reviewRequest = (item: AgentInputItem | undefined) =>
  JSON.parse(String((item as { content?: unknown } | undefined)?.content)) as Record<
    string,
    Record<string, unknown>
  >;

/**
 * A scripted provider: each review call takes the next review output and reports the given
 * input tokens; a compaction request returns `compaction()`, taking 30 s on the test clock.
 */
const scripted = (
  reviews: readonly {
    readonly output: ModelResponse["output"];
    readonly inputTokens: number;
  }[],
  compaction: () => ModelResponse["output"] = () => [compacted],
) => {
  const requests: ModelRequest[] = [];
  const responses: ModelResponse["output"][] = [];
  let review = 0;
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        if (compactionRequest(request)) {
          vi.setSystemTime(Date.now() + 30_000);
          const output = compaction();
          responses.push(output);
          return {
            usage: new Usage({
              requests: 1,
              inputTokens: longContext + 1_000,
              outputTokens: 4_000,
              inputTokensDetails: { cached_tokens: 190_000 },
            }),
            output,
          };
        }
        const next = reviews[review++];
        if (next === undefined) throw new Error("No scripted response");
        responses.push(next.output);
        return {
          usage: new Usage({
            requests: 1,
            inputTokens: next.inputTokens,
            outputTokens: 500,
          }),
          output: next.output,
        };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return { requests, responses };
};

const recording = () => {
  const events: { name: string; details: unknown }[] = [];
  const diagnostics: GuardianDiagnostics = {
    emit: (name, details) =>
      Effect.sync(() => {
        events.push({ name, details });
      }),
    retainModelTranscript: () => Effect.void,
    retainScreenedSource: () => Effect.void,
  };
  const named = (name: string) =>
    events.filter((event) => event.name === name).map((event) => event.details);
  return { diagnostics, named };
};

const guardianWith = (diagnostics?: GuardianDiagnostics) =>
  makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    diagnostics,
    {},
  );

it("compacts a long conversation before a review's first call, and its review calls carry none", async () => {
  const { requests, responses } = scripted([
    { output: [allow], inputTokens: longContext },
    {
      output: [read("helper", "operation/src/helper.mjs")],
      inputTokens: 30_000,
    },
    { output: [allow], inputTokens: 31_000 },
    { output: [allow], inputTokens: 32_000 },
  ]);
  const { diagnostics, named } = recording();
  const guardian = guardianWith(diagnostics);
  await Effect.runPromise(guardian.review(pending, reader()));
  const second = await Effect.runPromise(
    guardian.review({ ...pending, screenedInput: '{"day":2}' }, reader()),
  );
  // The included entrypoint stays in view: the compaction came before the review's request.
  expect(second.decision.outcome).toBe("allow");
  expect(requests.map(compactionRequest)).toEqual([false, true, false, false]);
  const [first, compaction, review, reviewRead] = requests;

  // The compaction request is the conversation so far, the cached prefix of the last call's
  // request, with the same instructions, tools and output format the review then sends.
  expect(inputOf(compaction).slice(0, inputOf(first).length)).toEqual(inputOf(first));
  expect(inputOf(compaction)).toHaveLength(inputOf(first).length + responses[0]!.length + 1);
  expect(compaction?.systemInstructions).toBe(review?.systemInstructions);
  expect(compaction?.tools).toEqual(review?.tools);
  expect(compaction?.outputType).toEqual(review?.outputType);

  // The review starts from the compacted context, followed by its own request, and none of its
  // calls carries a compaction request or returns a compaction.
  expect(inputOf(review)[0]).toMatchObject({
    type: "compaction",
    encrypted_content: "opaque-compacted-context",
  });
  expect(inputOf(review)).toHaveLength(2);
  expect(reviewRequest(inputOf(review)[1]).submitted_call).toMatchObject({
    input: '{"day":2}',
  });
  expect(responses.slice(2).some(hasCompactionItem)).toBe(false);
  // Each later call appends: what an earlier call sent is never rewritten.
  expect(inputOf(reviewRead).slice(0, inputOf(review).length)).toEqual(inputOf(review));

  // The compaction's time and tokens are reported apart from the review's.
  expect(named("guardian.session_compacted")).toEqual([
    {
      reviewId: expect.any(String),
      details: {
        state: "completed",
        contextTokens: longContext + 500,
        startedAtUtc: "2026-01-01T00:00:00.000Z",
        endedAtUtc: "2026-01-01T00:00:30.000Z",
        elapsedMs: 30_000,
        usage: {
          inputTokens: longContext + 1_000,
          cachedTokens: 190_000,
          cacheWriteTokens: 0,
          outputTokens: 4_000,
          reasoningTokens: 0,
        },
      },
    },
  ]);
  expect(named("guardian.usage").at(-1)).toMatchObject({
    details: { modelCalls: 2 },
  });
  expect(guardian.session?.snapshot().history[0]).toMatchObject({
    type: "compaction",
  });

  // A later review on the short conversation appends to it without compacting again.
  await Effect.runPromise(guardian.review({ ...pending, screenedInput: '{"day":3}' }, reader()));
  expect(requests).toHaveLength(5);
  const third = requests[4];
  expect(compactionRequest(third)).toBe(false);
  const earlier = [...inputOf(reviewRead), ...responses[3]!];
  expect(inputOf(third).slice(0, earlier.length)).toEqual(earlier);
  expect(named("guardian.session_compacted")).toHaveLength(1);
});

it("does not compact a conversation below the threshold", async () => {
  const { requests } = scripted([
    { output: [allow], inputTokens: shortContext },
    { output: [allow], inputTokens: shortContext + 5_000 },
  ]);
  const { diagnostics, named } = recording();
  const guardian = guardianWith(diagnostics);
  await Effect.runPromise(guardian.review(pending, reader()));
  await Effect.runPromise(guardian.review({ ...pending, screenedInput: '{"day":2}' }, reader()));
  expect(requests).toHaveLength(2);
  expect(requests.some(compactionRequest)).toBe(false);
  expect(inputOf(requests[1]).slice(0, inputOf(requests[0]).length)).toEqual(inputOf(requests[0]));
  expect(named("guardian.session_compacted")).toEqual([]);
});

it("reviews uncompacted when the compaction fails, and does not try again in the session", async () => {
  const { requests } = scripted(
    [
      { output: [allow], inputTokens: longContext },
      { output: [allow], inputTokens: longContext + 5_000 },
      { output: [allow], inputTokens: longContext + 10_000 },
    ],
    () => {
      throw new Error("Synthetic compaction failure");
    },
  );
  const { diagnostics, named } = recording();
  const guardian = guardianWith(diagnostics);
  await Effect.runPromise(guardian.review(pending, reader()));
  const second = await Effect.runPromise(
    guardian.review({ ...pending, screenedInput: '{"day":2}' }, reader()),
  );
  await Effect.runPromise(guardian.review({ ...pending, screenedInput: '{"day":3}' }, reader()));
  expect(second.decision.outcome).toBe("allow");
  expect(requests.map(compactionRequest)).toEqual([false, true, false, false]);
  // The review sends the whole conversation, as it would have without the attempt.
  expect(inputOf(requests[2]).slice(0, inputOf(requests[0]).length)).toEqual(inputOf(requests[0]));
  expect(named("guardian.session_compacted")).toEqual([
    {
      reviewId: expect.any(String),
      details: expect.objectContaining({
        state: "failed",
        reason: "provider_failed",
      }),
    },
  ]);
});

it("lists no source as unchanged when the review compacts first", async () => {
  const { requests } = scripted([
    {
      output: [read("helper", "operation/src/helper.mjs")],
      inputTokens: shortContext,
    },
    { output: [allow], inputTokens: longContext },
    { output: [allow], inputTokens: 20_000 },
  ]);
  const guardian = guardianWith();
  await Effect.runPromise(guardian.review(executed, reader()));
  const second = await Effect.runPromise(
    guardian.review({ ...executed, screenedInput: '{"day":2}' }, reader()),
  );
  expect(second.decision.outcome).toBe("allow");
  expect(requests.map(compactionRequest)).toEqual([false, false, true, false]);
  // The helper read went into the compaction, so it is no longer in view to count as read.
  expect(reviewRequest(inputOf(requests[3])[1]).trusted_review).not.toHaveProperty(
    "unchangedSources",
  );
});

it("compacts before the first review of a session restored after a takeover", async () => {
  const { requests } = scripted([
    { output: [allow], inputTokens: longContext },
    { output: [allow], inputTokens: 20_000 },
  ]);
  const first = guardianWith();
  await Effect.runPromise(first.review(pending, reader()));
  const restored = Schema.decodeUnknownSync(GuardianSessionSnapshot)(
    JSON.parse(JSON.stringify(first.session?.snapshot())),
  );
  const replacement = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    undefined,
    { initial: restored },
  );
  await Effect.runPromise(replacement.review({ ...pending, attemptId: "takeover" }, reader()));
  expect(requests.map(compactionRequest)).toEqual([false, true, false]);
  expect(inputOf(requests[2])[0]).toMatchObject({ type: "compaction" });
});
