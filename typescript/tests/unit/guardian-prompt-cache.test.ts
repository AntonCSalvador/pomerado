// Failure modes covered: a build's own request in the instructions every build shares, so no
// build reads another's cached prefix; top-level instructions, which cannot hold a cache
// breakpoint; a review message that repeats a kind's or host's policy the instructions hold; a
// per-review effort that changes the request's own effort and with it the whole cached prefix; a
// configuration update next to another, combined with provider-side automatic compaction, or lost
// at a compaction; a review without a session whose later calls cannot read its earlier ones
// from the cache; a session that changed its effort left with no compaction at all when its own
// compaction cannot run, after a failed compaction or a restore;
// the provider's split of cache writes by lifetime dropped from usage; the outcome reviewer's
// fixed instructions sent where no breakpoint can hold them; a conversation sent the policy of
// kinds it never reviews, or a kind's policy that changes what came before it when it joins,
// repeats on a later review, or goes missing after a compaction or a restore.
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
import type { GuardianSessionOptions } from "../../src/guardian/session.js";
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
  /** An error status the provider refuses the request with instead. */
  readonly status?: number;
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
      const { output, usage, fields, status } = reply(body, bodies.length - 1);
      if (status !== undefined)
        return new Response(
          JSON.stringify({
            error: { message: "Synthetic refusal", type: "invalid_request_error" },
          }),
          { status, headers: { "content-type": "application/json" } },
        );
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

/** A request's items after its two leading developer messages. */
const conversationOf = (body: Body | undefined) => itemsOf(body).slice(2);

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

/** A wire item's text when it is a developer message, else undefined. */
const developerTextOf = (item: WireItem | undefined) =>
  item?.role === "developer"
    ? (item.content as readonly { readonly text: string }[]).map((part) => part.text).join("")
    : undefined;

/** The headings of the kind sections a Review Kinds message holds, in order. */
const sectionsOf = (text: string) =>
  text
    .split("\n\n")
    .filter((part) => part.startsWith("## "))
    .map((part) => part.slice(3));

/** A review request's `trusted_review`. */
const trustedReviewOf = (item: WireItem) =>
  (JSON.parse(String(item.content)) as { trusted_review: Record<string, unknown> }).trusted_review;

/**
 * The conversation after the two leading instructions, as what the model reads: each developer
 * message as the kind sections it adds, and each review request as its kind.
 */
const kindsOf = (body: Body | undefined) =>
  conversationOf(body).flatMap((item): (string | string[])[] => {
    const text = developerTextOf(item);
    if (text !== undefined) {
      expect(text.startsWith("# Review Kinds\n\n")).toBe(true);
      return [sectionsOf(text)];
    }
    return item.role === "user" ? [`review ${String(trustedReviewOf(item)["kind"])}`] : [];
  });

/** The items a request adds to the conversation it continues, by role or type. */
const addedBy = (body: Body | undefined, before: Body | undefined) =>
  itemsOf(body)
    .slice(itemsOf(before).length + 1)
    .map((item) => item.role ?? item.type);

const listingKind = (kind: string, policy: string) => ({
  kind,
  policy,
  evidence: { listing: "Synthetic listing" },
  outcomes: ["allow", "deny"] as const,
});

it("adds each kind's policy to the conversation on its first review of that kind, after everything before", async () => {
  const bodies = wire();
  const listing = "Synthetic listing policy.";
  await build("Read the listed opening hours", {
    policies: { ...hostPolicies, hostKinds: { catalog_listing: listing } },
  });

  expect(bodies).toHaveLength(4);
  // Each request continues the one before it byte for byte, so registering a kind keeps the
  // cached conversation.
  for (let index = 1; index < bodies.length; index++) {
    const before = itemsOf(bodies[index - 1]);
    expect(JSON.stringify(itemsOf(bodies[index]).slice(0, before.length))).toBe(
      JSON.stringify(before),
    );
  }
  // The instructions every build shares hold no kind's policy, core or host.
  const shared = JSON.stringify(itemsOf(bodies[0]).slice(0, 2));
  expect(shared).not.toContain("# Review Kinds");
  for (const policy of [...Object.values(hostPolicies), listing])
    expect(shared).not.toContain(policy);
  // Each kind's sections come right before its first review, and only that kind's.
  expect(kindsOf(bodies.at(-1))).toEqual([
    ["Execution, recovery and publication reviews", "Execution reviews"],
    "review execution",
    ["Question reviews"],
    "review question",
    ["Task update reviews (kind update)"],
    "review update",
    ["Publication reviews", "Publication reviews whose request carries publication_delta"],
    "review publication",
  ]);
  const whole = JSON.stringify(bodies.at(-1));
  // Each host policy reaches the model exactly once, with its kind; an unreviewed kind's never.
  for (const policy of Object.values(hostPolicies)) expect(whole.split(policy)).toHaveLength(2);
  expect(whole).not.toContain(listing);
  expect(
    conversationOf(bodies.at(-1)).filter(
      (item) => item.role === "user" && trustedReviewOf(item)["policy"] !== undefined,
    ),
  ).toEqual([]);
  // The review history is the whole conversation: every request and decision, in order.
  expect(
    conversationOf(bodies.at(-1))
      .filter((item) => item.role !== "developer")
      .map((item) => item.role),
  ).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
});

it("adds nothing for a kind the conversation holds, and only the sections it lacks for another", async () => {
  const bodies = wire();
  const listing = "Synthetic listing policy.";
  const unlisted = "Synthetic unregistered kind policy.";
  const guardian = makeGuardian(
    reviewer({ policies: { ...hostPolicies, hostKinds: { catalog_listing: listing } } }),
    undefined,
    {},
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* guardian.review(pending, readCurrent);
      yield* guardian.review({ ...pending, screenedInput: '{"again":true}' }, readCurrent);
      yield* guardian.reviewRecovery(pending, "Synthetic stalled browser", readCurrent);
      yield* guardian.reviewHostKind(pending, listingKind("catalog_listing", listing));
      yield* guardian.reviewHostKind(pending, listingKind("catalog_listing", listing));
      yield* guardian.reviewHostKind(pending, listingKind("other_listing", unlisted));
    }),
  );

  expect(bodies).toHaveLength(6);
  const [first, again, recovery, hosted, hostedAgain, other] = bodies;
  // The second execution review and the second review of the host kind add only their request.
  expect(addedBy(again, first)).toEqual(["user"]);
  expect(addedBy(hostedAgain, hosted)).toEqual(["user"]);
  // A recovery review adds its own section, not the outcome section execution reviews share.
  expect(addedBy(recovery, again)).toEqual(["developer", "user"]);
  expect(sectionsOf(developerTextOf(itemsOf(recovery).at(-2)) ?? "")).toEqual(["Recovery reviews"]);
  // A host kind's registered policy joins on its first review, and its request names no policy.
  expect(addedBy(hosted, recovery)).toEqual(["developer", "user"]);
  expect(developerTextOf(itemsOf(hosted).at(-2))).toBe(
    `# Review Kinds\n\n## Reviews of kind catalog_listing\n\n${listing}`,
  );
  const hostedRequest = itemsOf(hosted).at(-1);
  if (hostedRequest === undefined) throw new Error("No host kind request");
  expect(trustedReviewOf(hostedRequest)).not.toHaveProperty("policy");
  // A host kind with no registered policy adds none, and its request carries its policy.
  expect(addedBy(other, hostedAgain)).toEqual(["user"]);
  const otherRequest = itemsOf(other).at(-1);
  if (otherRequest === undefined) throw new Error("No host kind request");
  expect(trustedReviewOf(otherRequest)["policy"]).toBe(unlisted);
  const whole = JSON.stringify(other);
  for (const heading of ["## Execution, recovery and publication reviews", "## Execution reviews"])
    expect(whole.split(heading)).toHaveLength(2);
});

it("keeps the kinds a restored conversation holds, adding only a new kind's", async () => {
  const bodies = wire();
  const options = { policies: hostPolicies };
  let saved: Parameters<NonNullable<GuardianSessionOptions["save"]>>[0] | undefined;
  const save = (snapshot: NonNullable<typeof saved>) =>
    Effect.sync(() => {
      saved = snapshot;
    });
  const original = makeGuardian(reviewer(options), undefined, { save });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* original.review(pending, readCurrent);
      yield* original.reviewQuestion(
        pending,
        {
          questions: [{ id: "branch", type: "text", prompt: "Which branch?" }],
          credentialsAvailable: false,
        },
        readCurrent,
      );
    }),
  );
  if (saved === undefined) throw new Error("The session saved no snapshot");
  const snapshot = saved;
  const before = bodies.at(-1);

  const restored = makeGuardian(reviewer(options), undefined, { initial: snapshot, save });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* restored.review(pending, readCurrent);
      yield* restored.reviewTaskUpdate(
        pending,
        {
          summary: "Read the north branch's hours instead.",
          changes: [{ setting: "input", values: { branch: "north" } }],
          recommend: "update",
          confirmation: [],
          effect: "read",
        },
        readCurrent,
      );
    }),
  );

  expect(bodies).toHaveLength(4);
  const [, , execution, update] = bodies;
  // The restored conversation continues the saved one byte for byte, with every kind it held.
  expect(JSON.stringify(itemsOf(execution).slice(0, itemsOf(before).length + 1))).toBe(
    JSON.stringify([...itemsOf(before), itemsOf(execution)[itemsOf(before).length]]),
  );
  // An execution review again adds only its request; a task update adds its own section.
  expect(addedBy(execution, before)).toEqual(["user"]);
  expect(addedBy(update, execution)).toEqual(["developer", "user"]);
  expect(kindsOf(update)).toEqual([
    ["Execution, recovery and publication reviews", "Execution reviews"],
    "review execution",
    ["Question reviews"],
    "review question",
    "review execution",
    ["Task update reviews (kind update)"],
    "review update",
  ]);
  // The snapshot holds each kind's policy once, so a second restore adds none again.
  const history = JSON.stringify(restored.session?.snapshot().history);
  for (const policy of [hostPolicies.execution, hostPolicies.question])
    expect(history.split(policy)).toHaveLength(2);
  expect(history).not.toContain(hostPolicies.publication);
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
  // The kind's policy the compaction cut follows them again, word for word, and only once.
  const policy = itemsOf(first).find(
    (item, index) => index >= 2 && developerTextOf(item) !== undefined,
  );
  expect(after[4]).toEqual(policy);
  expect(after.filter((item) => developerTextOf(item) !== undefined)).toHaveLength(3);
  // The next review at medium appends its own update right before its request, and the
  // compacted conversation it continues is unchanged.
  const next = itemsOf(medium);
  expect(JSON.stringify(next.slice(0, after.length))).toBe(JSON.stringify(after));
  const update = next.findLastIndex((item) => item.type === "configuration_update");
  expect(next[update]).toEqual({ type: "configuration_update", reasoning: { effort: "medium" } });
  expect(next[update + 1]?.role).toBe("user");
  expect(guardian.session?.snapshot().history.slice(0, 3)).toMatchObject([
    { type: "compaction" },
    { type: "unknown", providerData: { type: "configuration_update" } },
    { type: "unknown", providerData: { type: "message", role: "developer" } },
  ]);
  // The next execution review holds the policy already, so it adds only its update and request.
  expect(addedBy(medium, bodies[3])).toEqual(["configuration_update", "user"]);
});

it("keeps automatic compaction as the backstop for a session that never changes its effort", async () => {
  const bodies = wire();
  await build("Read the listed opening hours");
  for (const body of bodies)
    expect(body["context_management"]).toEqual([{ type: "compaction", compact_threshold: 240000 }]);
  expect(JSON.stringify(bodies)).not.toContain("configuration_update");
});

it("reads the shared prefix in a review without a session, as every session writes it", async () => {
  const bodies = wire();
  const sessionless = makeGuardian(reviewer({ specialize: () => ({ reasoningEffort: "low" }) }));
  await Effect.runPromise(sessionless.review(pending, readCurrent));
  await build("Read the rows of the named table");

  const [single, sessionFirst] = bodies;
  expect(single?.["prompt_cache_options"]).toEqual({ mode: "implicit" });
  expect(sessionFirst?.["prompt_cache_options"]).toEqual({ mode: "implicit" });
  // It reads the same shared prefix every session writes.
  expect(cachedPrefix(single)).toBe(cachedPrefix(sessionFirst));
  // Its kind's policy, then its effort as an update, come before its request, as in a session.
  expect(itemsOf(single).map((item) => item.role ?? item.type)).toEqual([
    "developer",
    "developer",
    "developer",
    "configuration_update",
    "user",
  ]);
  expect(kindsOf(single)).toEqual([
    ["Execution, recovery and publication reviews", "Execution reviews"],
    "review execution",
  ]);
});

/** A `read_source` call for the entrypoint, as the model would send it. */
const readEntrypoint = (id: string) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name: "read_source",
  arguments: JSON.stringify({ path: pending.entrypoint, offset: 0, match: null, paths: null }),
  status: "completed",
});

it("lets each call of a review without a session read the calls before it from the cache", async () => {
  const bodies = wire((_body, index) => (index === 0 ? { output: [readEntrypoint("read")] } : {}));
  await Effect.runPromise(makeGuardian(reviewer()).review(pending, readCurrent));

  expect(bodies).toHaveLength(2);
  // The second call continues the first, so it reads what the first cached, not just the
  // shared instructions.
  const [first, second] = bodies;
  expect(JSON.stringify(itemsOf(second).slice(0, itemsOf(first).length))).toBe(
    JSON.stringify(itemsOf(first)),
  );
  for (const body of bodies) expect(body["prompt_cache_options"]).toEqual({ mode: "implicit" });
});

const providerCompaction = {
  type: "compaction",
  id: "cmp_provider",
  encrypted_content: "opaque-provider-compacted-context",
};

/** An execution review's decision, for a reply after a compaction took its request out of view. */
const executionDecision = {
  type: "message",
  id: "msg_after_compaction",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: JSON.stringify({
        outcome: "allow",
        rationale: "Synthetic decision",
        action: "read",
        reason: null,
        findings: null,
      }),
      annotations: [],
    },
  ],
};

/** Whether a request may be compacted at all: by the provider, or by its own trigger. */
const compactable = (body: Body | undefined) =>
  body?.["context_management"] !== undefined ||
  itemsOf(body).at(-1)?.type === "compaction_trigger";

it("keeps the provider's compaction for a session at another effort when its own compaction fails", async () => {
  let calls = 0;
  const bodies = wire((body) => {
    calls++;
    // The session's own compaction request is refused.
    if (itemsOf(body).at(-1)?.type === "compaction_trigger") return { status: 400 };
    // The provider compacts the crossing request itself, mid-review.
    if (calls === 3)
      return {
        output: [providerCompaction, readEntrypoint("read_after_compaction")],
        usage: { input_tokens: 252_000, output_tokens: 1, total_tokens: 1 },
      };
    // The compaction took the review's request out of view, so the decision is scripted here.
    if (calls === 4) return { output: [executionDecision] };
    return {
      usage: { input_tokens: calls === 1 ? 236_000 : 30_000, output_tokens: 1, total_tokens: 1 },
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
      // Its request would cross the threshold.
      yield* guardian.review(
        { ...quick, screenedObservations: `second ${"x".repeat(48_000)}` },
        readCurrent,
      );
    }),
  );

  expect(bodies).toHaveLength(4);
  const [, refused, crossing, continued] = bodies;
  expect(itemsOf(refused).at(-1)?.type).toBe("compaction_trigger");
  // The crossing request keeps the provider's compaction, so it holds no configuration update
  // and carries the effort in force as its own.
  expect(crossing?.["context_management"]).toEqual([
    { type: "compaction", compact_threshold: 240000 },
  ]);
  expect(itemsOf(crossing).some((item) => item.type === "configuration_update")).toBe(false);
  expect(crossing?.["reasoning"]).toMatchObject({ effort: "low" });
  // After the provider's compaction the effort goes on as an update after its item, then the
  // kind's policy the conversation held, and the request's own effort is the default again.
  expect(itemsOf(continued).map((item) => item.role ?? item.type)).toEqual([
    "developer",
    "developer",
    "compaction",
    "configuration_update",
    "developer",
    "function_call",
    "function_call_output",
  ]);
  expect(sectionsOf(developerTextOf(itemsOf(continued)[4]) ?? "")).toEqual([
    "Execution, recovery and publication reviews",
    "Execution reviews",
  ]);
  expect(itemsOf(continued)[3]).toEqual({
    type: "configuration_update",
    reasoning: { effort: "low" },
  });
  expect(continued?.["reasoning"]).toMatchObject({ effort: "medium" });
  expect(guardian.session?.snapshot().history.slice(0, 2)).toMatchObject([
    { type: "compaction" },
    { type: "unknown", providerData: { type: "configuration_update" } },
  ]);
});

it("keeps a restored session at another effort compactable before it knows its size", async () => {
  const bodies = wire();
  const low = reviewer({ specialize: () => ({ reasoningEffort: "low" }) });
  let saved: Parameters<NonNullable<GuardianSessionOptions["save"]>>[0] | undefined;
  await Effect.runPromise(
    makeGuardian(low, undefined, {
      save: (snapshot) =>
        Effect.sync(() => {
          saved = snapshot;
        }),
    }).review(pending, readCurrent),
  );
  expect(JSON.stringify(saved?.history)).toContain("configuration_update");
  if (saved === undefined) throw new Error("The session saved no snapshot");

  // The restored session's first request is past the threshold, and nothing has reported its
  // size yet.
  const restored = makeGuardian(low, undefined, { initial: saved });
  await Effect.runPromise(
    restored.review({ ...pending, screenedObservations: "y".repeat(800_000) }, readCurrent),
  );
  const crossing = bodies.at(-1);
  expect(bodies).toHaveLength(2);
  expect(compactable(crossing)).toBe(true);
  expect(itemsOf(crossing).some((item) => item.type === "configuration_update")).toBe(false);
  expect(crossing?.["reasoning"]).toMatchObject({ effort: "low" });
});

it("continues from the session's own compaction after the provider compacted earlier in the review", async () => {
  const sessionCompaction = {
    type: "compaction",
    id: "cmp_session",
    encrypted_content: "opaque-session-compacted-context",
  };
  let restoring = true;
  let calls = 0;
  const bodies = wire((body) => {
    if (restoring) return {};
    calls++;
    if (itemsOf(body).at(-1)?.type === "compaction_trigger") return { output: [sessionCompaction] };
    const usage = (input_tokens: number) => ({ input_tokens, output_tokens: 1, total_tokens: 1 });
    // The provider compacts the restored session's first request, then the review reads on
    // until its next request would cross the threshold again.
    if (calls === 1)
      return { output: [providerCompaction, readEntrypoint("first")], usage: usage(30_000) };
    if (calls === 2) return { output: [readEntrypoint("second")], usage: usage(239_990) };
    if (calls === 4) return { output: [readEntrypoint("third")], usage: usage(30_000) };
    return { output: [executionDecision], usage: usage(30_000) };
  });
  const low = reviewer({ specialize: () => ({ reasoningEffort: "low" }) });
  let saved: Parameters<NonNullable<GuardianSessionOptions["save"]>>[0] | undefined;
  await Effect.runPromise(
    makeGuardian(low, undefined, {
      save: (snapshot) =>
        Effect.sync(() => {
          saved = snapshot;
        }),
    }).review(pending, readCurrent),
  );
  if (saved === undefined) throw new Error("The session saved no snapshot");
  restoring = false;
  bodies.splice(0);

  const restored = makeGuardian(low, undefined, { initial: saved });
  await Effect.runPromise(
    restored.review({ ...pending, screenedObservations: "y".repeat(800_000) }, readCurrent),
  );

  expect(bodies).toHaveLength(5);
  const [, , compacting, compacted, after] = bodies;
  expect(itemsOf(compacting).at(-1)?.type).toBe("compaction_trigger");
  // Every request after the session's own compaction continues from its item, not from the
  // provider's earlier one.
  for (const body of [compacted, after])
    expect(conversationOf(body)[0]).toMatchObject({ type: "compaction", id: "cmp_session" });
  expect(conversationOf(after).map((item) => item.role ?? item.type)).toEqual([
    "compaction",
    "configuration_update",
    "developer",
    "function_call",
    "function_call_output",
    "function_call",
    "function_call_output",
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
  // Only the shared instructions, exactly as the review sends them first, with no kind's policy,
  // which follows the build's own message.
  expect(itemsOf(prewarm)).toEqual(itemsOf(review).slice(0, 1));
  expect(JSON.stringify(itemsOf(prewarm))).not.toContain("# Review Kinds");
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
  expect(bodies[4]?.["prompt_cache_options"]).toEqual({ mode: "implicit" });
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
