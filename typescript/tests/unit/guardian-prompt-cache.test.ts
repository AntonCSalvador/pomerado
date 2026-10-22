// Failure modes covered: a build's own request in the instructions every build shares, so no
// build reads another's cached prefix; top-level instructions, which cannot hold a cache
// breakpoint; a review message that repeats a kind's or host's policy the instructions hold; a
// per-review effort that changes the request's own effort and with it the whole cached prefix; a
// configuration update next to another, combined with provider-side automatic compaction, or lost
// at a compaction; a one-call review without a session writing its unique suffix to the cache;
// the provider's split of cache writes by lifetime dropped from usage; the outcome reviewer's
// fixed instructions sent where no breakpoint can hold them.
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
import { makeOpenAIOutcomeReviewer } from "../../src/mint/outcome-review-openai.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

type Body = Record<string, unknown>;
type WireItem = {
  readonly type?: string;
  readonly role?: string;
  readonly content?: unknown;
  readonly reasoning?: unknown;
};
const itemsOf = (body: Body | undefined) => (body?.["input"] ?? []) as readonly WireItem[];

const pending: PendingExecution = {
  invocationId: "mint_cache",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the listed opening hours",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://hours.example.test"],
  allowedEffects: ["read"],
};
const publication: PendingExecution = {
  ...pending,
  publication: {
    files: [
      {
        path: "operation/operation.mjs",
        byteLength: 16,
        published: true,
        current: true,
        owner: "minter",
      },
    ],
  },
};
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

interface Reply {
  readonly output?: readonly Record<string, unknown>[];
  readonly usage?: Record<string, unknown>;
  /** More top-level response fields, such as `prompt_cache_diagnostics`. */
  readonly fields?: Record<string, unknown>;
}

/**
 * A Responses API that records each request body. `reply` picks each response; by default every
 * review is allowed in one call, which every review kind accepts with its own outcome.
 */
const wire = (reply: (body: Body, index: number) => Reply = () => ({})) => {
  const bodies: Body[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Body;
      bodies.push(body);
      const { output, usage, fields } = reply(body, bodies.length - 1);
      const user = JSON.stringify(
        itemsOf(body)
          .filter((item) => item.role === "user")
          .at(-1)?.content ?? "",
      );
      const outcome = user.includes('\\"kind\\":\\"question\\"') ? "allow_business" : "allow";
      return new Response(
        JSON.stringify({
          id: `resp_${bodies.length}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: lunaModel,
          output: output ?? [
            {
              type: "message",
              id: `msg_${bodies.length}`,
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    outcome,
                    rationale: "Synthetic decision",
                    action: user.includes('\\"kind\\":\\"execution\\"') ? "read" : null,
                    reason: user.includes('\\"kind\\":\\"publication\\"') ? "approved" : null,
                    findings: user.includes('\\"kind\\":\\"publication\\"') ? [] : null,
                  }),
                  annotations: [],
                },
              ],
            },
          ],
          usage: usage ?? { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          ...fields,
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

const reviewer = (options: Omit<GuardianModelOptions, "executionEnvironment"> = {}) =>
  makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
    executionEnvironment: nativeExecutionEnvironment,
    ...options,
  });

/** What the provider caches through the shared instructions' breakpoint, in request order. */
const cachedPrefix = (body: Body | undefined) =>
  JSON.stringify({
    model: body?.["model"],
    tools: body?.["tools"],
    text: body?.["text"],
    effort: (body?.["reasoning"] as { effort?: unknown } | undefined)?.effort,
    instructions: body?.["instructions"],
    input: itemsOf(body).slice(0, 1),
  });

const breakpointOf = (item: WireItem | undefined) =>
  (item?.content as readonly { readonly prompt_cache_breakpoint?: unknown }[] | undefined)?.[0]
    ?.prompt_cache_breakpoint;

const hostPolicies = {
  execution: "Synthetic host execution policy.",
  question: "Synthetic host question policy.",
  publication: "Synthetic host publication policy.",
};

/** One build: an execution, a question, a task update and a publication review in one session. */
const build = async (screenedIntent: string, options = {}) => {
  const ofBuild = { ...pending, screenedIntent };
  const guardian = makeGuardian(reviewer(options), undefined, {});
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* guardian.review(ofBuild, readCurrent);
      yield* guardian.reviewQuestion(
        ofBuild,
        {
          questions: [{ id: "branch", type: "text", prompt: "Which branch?" }],
          credentialsAvailable: false,
        },
        readCurrent,
      );
      yield* guardian.reviewTaskUpdate(
        ofBuild,
        {
          summary: "Read the north branch's hours instead.",
          changes: [{ setting: "input", values: { branch: "north" } }],
          recommend: "update",
          confirmation: [],
          effect: "read",
        },
        readCurrent,
      );
      yield* guardian.review({ ...publication, screenedIntent }, readCurrent);
    }),
  );
};

it("sends two builds the same prefix through the shared instructions' 12-hour breakpoint", async () => {
  const bodies = wire();
  await build("Read the listed opening hours", { policies: hostPolicies });
  const first = bodies.splice(0);
  await build("Read the rows of the named table", { policies: hostPolicies });
  const second = bodies.splice(0);

  expect(first).toHaveLength(4);
  expect(second).toHaveLength(4);
  // Every review of both builds, whatever its kind, caches the same bytes through the breakpoint.
  expect(new Set([...first, ...second].map(cachedPrefix)).size).toBe(1);
  const [shared, own] = itemsOf(first[0]);
  expect(first[0]).not.toHaveProperty("instructions");
  expect(shared).toMatchObject({ role: "developer" });
  expect(breakpointOf(shared)).toEqual({ mode: "explicit", ttl: "12h" });
  // The build's own message follows it, with its request, and caches implicitly.
  expect(own).toMatchObject({ role: "developer" });
  expect(breakpointOf(own)).toBeUndefined();
  expect(JSON.stringify(own)).toContain("opening hours");
  expect(JSON.stringify(itemsOf(second[0])[1])).toContain("named table");
  expect(JSON.stringify(shared)).not.toContain("opening hours");
  for (const body of [...first, ...second]) {
    expect(body["prompt_cache_options"]).toMatchObject({ mode: "implicit" });
    expect(body["reasoning"]).toMatchObject({ effort: "medium" });
  }
});

it("states each kind's and host's policy once, before every review, and only appends reviews", async () => {
  const bodies = wire();
  await build("Read the listed opening hours", {
    policies: { ...hostPolicies, hostKinds: { catalog_listing: "Synthetic listing policy." } },
  });

  for (let index = 1; index < bodies.length; index++) {
    const before = itemsOf(bodies[index - 1]);
    expect(JSON.stringify(itemsOf(bodies[index]).slice(0, before.length))).toBe(
      JSON.stringify(before),
    );
  }
  const last = bodies.at(-1);
  const whole = JSON.stringify(last);
  // Each host policy reaches the model exactly once, in the shared instructions.
  for (const policy of [...Object.values(hostPolicies), "Synthetic listing policy."]) {
    expect(whole.split(policy)).toHaveLength(2);
    expect(JSON.stringify(itemsOf(last)[0])).toContain(policy);
  }
  // Each review's request names its kind and carries no policy.
  const requests = itemsOf(last)
    .filter((item) => item.role === "user")
    .map(
      (item) =>
        (JSON.parse(String(item.content)) as { trusted_review: Record<string, unknown> })
          .trusted_review,
    );
  expect(requests.map((review) => review["kind"])).toEqual([
    "execution",
    "question",
    "update",
    "publication",
  ]);
  for (const review of requests) expect(review).not.toHaveProperty("policy");
});

it("re-adds the effort after a compaction, never next to another update or with automatic compaction", async () => {
  const compaction = {
    type: "compaction",
    id: "cmp_cache",
    encrypted_content: "opaque-compacted-context",
  };
  let calls = 0;
  const bodies = wire((body) => {
    calls++;
    const trigger = itemsOf(body).at(-1)?.type === "compaction_trigger";
    // A compaction during a review takes the entrypoint out of view, so it is read again.
    const readAgain = {
      type: "function_call",
      id: "fc_after_compaction",
      call_id: "read_after_compaction",
      name: "read_source",
      arguments: JSON.stringify({ path: pending.entrypoint, offset: 0, match: null, paths: null }),
      status: "completed",
    };
    return trigger
      ? {
          output: [compaction],
          usage: { input_tokens: 236_010, output_tokens: 1, total_tokens: 1 },
        }
      : calls === 3
        ? {
            output: [readAgain],
            usage: { input_tokens: 30_000, output_tokens: 1, total_tokens: 1 },
          }
        : {
            usage: {
              input_tokens: calls === 1 ? 236_000 : 30_000,
              output_tokens: 1,
              total_tokens: 1,
            },
          };
  });
  const quick = { ...pending, screenedInput: '{"quick":true}' };
  const guardian = makeGuardian(
    reviewer({
      specialize: (turn) =>
        turn.pending.screenedInput === quick.screenedInput ? { reasoningEffort: "low" } : {},
    }),
    undefined,
    {},
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* guardian.review(quick, readCurrent);
      // Its request would cross the threshold, so the session compacts first.
      yield* guardian.review(
        { ...quick, screenedObservations: `second ${"x".repeat(48_000)}` },
        readCurrent,
      );
      yield* guardian.review(pending, readCurrent);
    }),
  );

  expect(bodies).toHaveLength(5);
  const [first, compacting, continued, , medium] = bodies;
  // The compaction request is the first request with the trigger appended, and carries no
  // automatic compaction, which the provider does not combine with a configuration update.
  expect(JSON.stringify(itemsOf(compacting).slice(0, -1))).toBe(JSON.stringify(itemsOf(first)));
  for (const body of bodies) {
    expect(body).not.toHaveProperty("context_management");
    expect(body["reasoning"]).toMatchObject({ effort: "medium" });
    const items = itemsOf(body);
    // No two updates ever stand next to each other.
    items.forEach((item, index) => {
      if (item.type === "configuration_update")
        expect(items[index + 1]?.type).not.toBe("configuration_update");
    });
  }
  // After the compaction, the shared instructions and the build's message lead, then the
  // compaction item, then the low effort it ended, then the rest of the conversation.
  const after = itemsOf(continued);
  expect(after.slice(0, 2)).toEqual(itemsOf(first).slice(0, 2));
  expect(after[2]).toMatchObject({ type: "compaction", id: "cmp_cache" });
  expect(after[3]).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
  expect(after.filter((item) => item.type === "configuration_update")).toHaveLength(1);
  // The next review at medium appends its own update right before its request, and the
  // compacted conversation it continues is unchanged.
  const next = itemsOf(medium);
  expect(JSON.stringify(next.slice(0, after.length))).toBe(JSON.stringify(after));
  const update = next.findLastIndex((item) => item.type === "configuration_update");
  expect(next[update]).toEqual({ type: "configuration_update", reasoning: { effort: "medium" } });
  expect(next[update + 1]?.role).toBe("user");
  expect(guardian.session?.snapshot().history.slice(0, 2)).toMatchObject([
    { type: "compaction" },
    { type: "unknown", providerData: { type: "configuration_update" } },
  ]);
});

it("keeps automatic compaction as the backstop for a session that never changes its effort", async () => {
  const bodies = wire();
  await build("Read the listed opening hours");
  for (const body of bodies)
    expect(body["context_management"]).toEqual([{ type: "compaction", compact_threshold: 240000 }]);
  expect(JSON.stringify(bodies)).not.toContain("configuration_update");
});

it("caches a review without a session only through the shared instructions", async () => {
  const bodies = wire();
  const sessionless = makeGuardian(reviewer({ specialize: () => ({ reasoningEffort: "low" }) }));
  await Effect.runPromise(sessionless.review(pending, readCurrent));
  await build("Read the rows of the named table");

  const [single, sessionFirst] = bodies;
  expect(single?.["prompt_cache_options"]).toEqual({ mode: "explicit" });
  expect(sessionFirst?.["prompt_cache_options"]).toEqual({ mode: "implicit" });
  // It reads the same shared prefix every session writes.
  expect(cachedPrefix(single)).toBe(cachedPrefix(sessionFirst));
  // Its effort is an update before its request, as in a session.
  expect(itemsOf(single).map((item) => item.role ?? item.type)).toEqual([
    "developer",
    "developer",
    "configuration_update",
    "user",
  ]);
});

it("reports cache writes by lifetime in the review's usage", async () => {
  wire(() => ({
    usage: {
      input_tokens: 20_000,
      output_tokens: 10,
      total_tokens: 20_010,
      input_tokens_details: {
        cached_tokens: 1_000,
        cache_write_tokens: 18_000,
        cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 15_000 },
      },
    },
  }));
  const { diagnostics, usage } = recording();
  await Effect.runPromise(makeGuardian(reviewer(), diagnostics, {}).review(pending, readCurrent));
  expect(usage).toEqual([
    expect.objectContaining({
      details: expect.objectContaining({
        inputTokens: 20_000,
        cachedTokens: 1_000,
        cacheWriteTokens: 18_000,
        cacheWrite30mTokens: 3_000,
        cacheWrite12hTokens: 15_000,
      }),
    }),
  ]);
});

it("sends the outcome reviewer's instructions as one developer message cached for 12 hours", async () => {
  const bodies: Body[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Body);
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
              content: [{ type: "output_text", text: "Nothing to assess.", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const unused = () => Effect.die(new Error("No tool call is scripted"));
  const model = makeOpenAIOutcomeReviewer({
    modelProvider: new OpenAIProvider({ openAIClient: client }),
  });
  let saved: Parameters<Parameters<typeof model.turn>[0]["conversation"]["save"]>[0] | undefined;
  for (const input of ["First synthetic wake", "Second synthetic wake"])
    await Effect.runPromise(
      model.turn({
        input,
        final: false,
        conversation: {
          initial: saved,
          save: (snapshot) =>
            Effect.sync(() => {
              saved = snapshot;
            }),
        },
        tools: {
          searchHistory: unused,
          readHistory: unused,
          listRecords: unused,
          readRecord: unused,
          readTask: unused,
          submitAssessment: unused,
          requestObservation: unused,
        },
      }),
    );

  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body).not.toHaveProperty("instructions");
    expect(body["prompt_cache_options"]).toMatchObject({ mode: "implicit" });
    expect(itemsOf(body)[0]).toMatchObject({ role: "developer" });
    expect(breakpointOf(itemsOf(body)[0])).toEqual({ mode: "explicit", ttl: "12h" });
  }
  expect(JSON.stringify(itemsOf(bodies[1]).slice(0, itemsOf(bodies[0]).length))).toBe(
    JSON.stringify(itemsOf(bodies[0])),
  );
  // The saved conversation keeps no copy of the instructions: each request adds them first.
  expect(JSON.stringify(saved?.history)).not.toContain("developer");
});

/** Everything of a request but its input and cache options, which a prewarm alone changes. */
const withoutInput = (body: Body | undefined) => {
  const { input: _input, prompt_cache_options: _options, ...rest } = body ?? {};
  return JSON.stringify(rest);
};

it("prewarms the shared instructions with the same bytes every review sends first, under the host's cache key", async () => {
  const bodies = wire(() => ({
    usage: {
      input_tokens: 15_000,
      output_tokens: 0,
      total_tokens: 15_000,
      input_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 15_000,
        cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 15_000 },
      },
    },
  }));
  const options = { policies: hostPolicies, promptCacheKey: "synthetic-environment" };
  const prewarmed = await Effect.runPromise(reviewer(options).prewarm());
  await build("Read the listed opening hours", options);

  const [prewarm, review] = bodies;
  expect(prewarm?.["prompt_cache_options"]).toEqual({ mode: "explicit", prewarm: true });
  // Only the shared instructions, exactly as the review sends them first.
  expect(itemsOf(prewarm)).toEqual(itemsOf(review).slice(0, 1));
  expect(cachedPrefix(prewarm)).toBe(cachedPrefix(review));
  // Every other part of the request is the review's own, the cache key included.
  expect(withoutInput(prewarm)).toBe(withoutInput(review));
  for (const body of bodies) expect(body["prompt_cache_key"]).toBe("synthetic-environment");
  expect(prewarmed).toMatchObject({ cacheWriteTokens: 15_000, cacheWrite12hTokens: 15_000 });
});

it("sends no cache key when the host gives none", async () => {
  const bodies = wire();
  await build("Read the listed opening hours");
  for (const body of bodies) expect(body).not.toHaveProperty("prompt_cache_key");
});

it("prewarms the outcome reviewer's instructions and tools as its turns send them", async () => {
  const bodies = wire();
  const model = makeOpenAIOutcomeReviewer({ promptCacheKey: "synthetic-environment" });
  await Effect.runPromise(model.prewarm());
  const unused = () => Effect.die(new Error("No tool call is scripted"));
  await Effect.runPromise(
    model.turn({
      input: "First synthetic wake",
      final: false,
      conversation: { initial: undefined, save: () => Effect.void },
      tools: {
        searchHistory: unused,
        readHistory: unused,
        listRecords: unused,
        readRecord: unused,
        readTask: unused,
        submitAssessment: unused,
        requestObservation: unused,
      },
    }),
  );
  const [prewarm, turn] = bodies;
  expect(prewarm?.["prompt_cache_options"]).toEqual({ mode: "explicit", prewarm: true });
  expect(itemsOf(prewarm)).toEqual(itemsOf(turn).slice(0, 1));
  expect(withoutInput(prewarm)).toBe(withoutInput(turn));
  for (const body of bodies) expect(body["prompt_cache_key"]).toBe("synthetic-environment");
});

const comparisonOf = (body: Body | undefined) =>
  (body?.["prompt_cache_options"] as { comparison_response_id?: string } | undefined)
    ?.comparison_response_id;

it("compares each session request's prompt cache with the conversation's previous response", async () => {
  const bodies = wire();
  await build("Read the listed opening hours");
  const sessionless = makeGuardian(reviewer());
  await Effect.runPromise(sessionless.review(pending, readCurrent));

  // The wire names its responses resp_1, resp_2, and so on, in request order.
  expect(bodies.slice(0, 4).map(comparisonOf)).toEqual([undefined, "resp_1", "resp_2", "resp_3"]);
  // The comparison joins the request's own cache options.
  expect(bodies[1]?.["prompt_cache_options"]).toEqual({
    mode: "implicit",
    comparison_response_id: "resp_1",
  });
  // A review without a session has no conversation to compare with.
  expect(bodies[4]?.["prompt_cache_options"]).toEqual({ mode: "explicit" });
});

it("reports each call's prompt cache comparison with its review's usage, enums and counts only", async () => {
  const diagnostics = [
    { type: "cache_hit" },
    {
      type: "cache_miss",
      reason: "reasoning_effort_changed",
      cache_missed_tokens: 5_629,
      comparison_reusable_tokens: 5_629,
      detail: "synthetic free text the host never keeps",
    },
    { type: "cache_miss", reason: "synthetic_future_reason" },
    { type: "synthetic_future_type" },
  ];
  wire((_body, index) => ({ fields: { prompt_cache_diagnostics: diagnostics[index] } }));
  const { diagnostics: recorded, usage } = recording();
  const guardian = makeGuardian(reviewer(), recorded, {});
  for (let index = 0; index < diagnostics.length; index++)
    await Effect.runPromise(guardian.review(pending, readCurrent));

  const reported = usage.map(
    (event) => (event as { details: { promptCacheDiagnostics?: unknown } }).details,
  );
  expect(reported.map((details) => details.promptCacheDiagnostics)).toEqual([
    [{ type: "cache_hit" }],
    [
      {
        type: "cache_miss",
        reason: "reasoning_effort_changed",
        cacheMissedTokens: 5_629,
        comparisonReusableTokens: 5_629,
      },
    ],
    // A reason this release does not name is left out, and a type it does not name skipped.
    [{ type: "cache_miss" }],
    undefined,
  ]);
});

it("compares the outcome reviewer's next turn with its previous response", async () => {
  const bodies = wire();
  const model = makeOpenAIOutcomeReviewer();
  const unused = () => Effect.die(new Error("No tool call is scripted"));
  let saved: Parameters<Parameters<typeof model.turn>[0]["conversation"]["save"]>[0] | undefined;
  for (const input of ["First synthetic wake", "Second synthetic wake"])
    await Effect.runPromise(
      model.turn({
        input,
        final: false,
        conversation: {
          initial: saved,
          save: (snapshot) =>
            Effect.sync(() => {
              saved = snapshot;
            }),
        },
        tools: {
          searchHistory: unused,
          readHistory: unused,
          listRecords: unused,
          readRecord: unused,
          readTask: unused,
          submitAssessment: unused,
          requestObservation: unused,
        },
      }),
    );
  // Each turn restores the conversation from its snapshot, which keeps the latest response.
  expect(bodies.map(comparisonOf)).toEqual([undefined, "resp_1"]);
  expect(saved?.latestResponseId).toBe("resp_2");
});
