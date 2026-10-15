import {
  makeMintContinuationFixture,
  portableJobSession,
  readAllow,
} from "../support/mint-fixtures.js";
import { Usage } from "@openai/agents";
import type { ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";

/*
 * How an unpublished build ends: each ending carries its own typed reason, so a host can tell the
 * caller what stopped the build instead of reporting a missing publication. Every scenario runs
 * the real minter loop on recorded model responses.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const prose = (text = "I stopped before publication."): ModelResponse => ({
  usage: new Usage({
    requests: 1,
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  }),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});

const intentTools = new Set(["execute", "finish_build", "request_input", "report_blocked"]);

const call = (name: string, input: unknown, id = name): ModelResponse => ({
  usage: new Usage({
    requests: 1,
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  }),
  output: [
    {
      type: "function_call",
      name,
      callId: id,
      arguments: JSON.stringify(
        intentTools.has(name) && typeof input === "object" && input !== null && !("intent" in input)
          ? { ...input, intent: `Synthetic ${name} purpose` }
          : input,
      ),
      status: "completed",
    },
  ],
});

const ask = (prompt: string) => ({
  questions: [{ id: "report", type: "text", prompt }],
});

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

it.each([
  { reason: "question_unanswered", refusal: "no_question_unanswered" },
  { reason: "owner_declined", refusal: "owner_not_declined" },
] as const)(
  "refuses $reason with nothing on record, then ends with it once its basis is recorded",
  async ({ reason, refusal }) => {
    const explanation = "The owner's answer is needed to choose the report, so this build stops.";
    const f = await fixture(
      (_request, index) =>
        [
          call("report_blocked", { reason, explanation }, "before"),
          reason === "question_unanswered"
            ? call("request_input", ask("Which report?"))
            : call("request_input", {
                questions: [
                  {
                    id: "proceed",
                    type: "confirm",
                    prompt: "May the tool do this?",
                  },
                ],
              }),
          call("report_blocked", { reason, explanation }, "after"),
        ][index] ?? prose("Stopping."),
      reason === "owner_declined"
        ? {
            askInput: () =>
              Effect.succeed({
                proceed: { type: "confirm", value: { confirmed: false } },
              }),
          }
        : {},
    );
    const outcome = await f.run();
    expect(JSON.stringify(f.requests[1]?.input)).toContain(refusal);
    expect(outcome).toMatchObject({
      build: "incomplete",
      blocked: { reason, explanation },
      stopReason: reason,
    });
  },
);

// Guardian's refusal stays a policy block, even when a question also went unanswered.
it("keeps a policy block that stands on a Guardian refusal", async () => {
  const explanation = "Guardian refused the only way to reach the requested page.";
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", ask("Which report?")),
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      preflight: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reviewId: "review_denied",
              rationale: "Not allowed.",
            },
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "policy", explanation },
    stopReason: "policy",
  });
});

// A minter that stops answering with tools says why in its last answer. Its caller reads that
// answer only after the pipeline a blocked explanation takes: host-private values removed and
// Guardian's review of a blocked outcome allowing it.
it("ends three tool-free answers as final_text_without_tool, with the reviewed last answer", async () => {
  const reviewed: unknown[] = [];
  const f = await fixture(
    (_request, index) =>
      index < 2
        ? prose("Still looking.")
        : prose("The site lists no prices for account acct-7731 without a membership."),
    {
      redactCallerText: (text) => text.replaceAll("acct-7731", "[account]"),
      reviewQuestion: (candidate, context) =>
        Effect.sync(() => {
          reviewed.push({ candidate, blockedOutcome: context?.blockedOutcome });
          return { outcome: "allow_business" as const, rationale: "Plain." };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    stopReason: "final_text_without_tool",
    stopExplanation: "The site lists no prices for account [account] without a membership.",
  });
  expect(JSON.stringify(reviewed)).not.toContain("acct-7731");
  expect(reviewed).toEqual([expect.objectContaining({ blockedOutcome: true })]);
});

it("keeps no last answer Guardian did not allow", async () => {
  const f = await fixture(() => prose("Call 555-0100 to finish this request."), {
    reviewQuestion: () =>
      Effect.succeed({
        outcome: "reword" as const,
        rationale: "It passes on a phone number.",
      }),
  });
  const outcome = await f.run();
  expect(outcome.stopReason).toBe("final_text_without_tool");
  expect(outcome).not.toHaveProperty("stopExplanation");
  expect(JSON.stringify(outcome)).not.toContain("555-0100");
});

it("ends an attempt that spent its model calls as turn_budget_spent", async () => {
  const f = await fixture(
    () => call("read_source", { path: "src/tool.ts", offset: null, limit: null }),
    {},
    {},
    { modelCallCapacity: 4, segmentTurns: 2 },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    stopReason: "turn_budget_spent",
  });
  expect(outcome).not.toHaveProperty("hostFailure");
});

it("names a published build's ending with no stop reason", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("finish_build", {
          entrypoint: "src/tool.ts",
          executionId: "execution_one",
          metadata: { name: "read_public", description: "Read public data" },
          coverage: "One actual example.",
        }),
      ][index] ?? prose(),
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  expect(outcome).not.toHaveProperty("stopReason");
});

// Guardian's public reason for a denial reaches the caller screened like their other text, and the
// private rationale never does.
it("carries Guardian's screened public reason on a publication denial", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("finish_build", {
          entrypoint: "src/tool.ts",
          executionId: "execution_one",
          metadata: { name: "read_public", description: "Read public data" },
          coverage: "One actual example.",
        }),
      ][index] ?? prose("Stopping."),
    {
      redactCallerText: (text) => text.replaceAll("acct-7731", "[account]"),
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reason: "privacy",
              reviewId: "review_denied",
              rationale: "Private rationale: src/tool.ts hard-codes a member number.",
              findings: [],
              publicReason: "The tool for acct-7731 would have published private details.",
            },
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome.publicationDenial).toEqual({
    reason: "privacy",
    publicReason: "The tool for [account] would have published private details.",
  });
  // What a caller reads; the host's own diagnostics keep the review as it came.
  expect(JSON.stringify([outcome.summary, outcome.publicationDenial])).not.toContain(
    "Private rationale",
  );
});

const authenticate = {
  purpose: "authenticate",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

const accountLocked = new MintFailure({
  code: "Unavailable",
  authentication: {
    phase: "credential_submit",
    code: "AccountLocked",
    afterSubmission: true,
  },
});

// The site said the account is locked: no retry or correction gets past it, so the build ends at
// once, typed, with words its owner can act on and no operator code.
it("ends a sign-in the site refused for its account as account_locked", async () => {
  const f = await fixture(
    (_request, index) =>
      index === 0 ? call("execute", authenticate) : prose("The account is locked."),
    { reviewAndExecute: () => Effect.fail(accountLocked) },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "account_locked",
  });
  expect(outcome.summary).toContain("locked, suspended or disabled");
  expect(outcome.summary).not.toMatch(/AccountLocked|credential_submit|receipts/u);
  // The build ends with the failed sign-in itself, with no further model call.
  expect(f.requests).toHaveLength(1);
});

// A sign-in that failed for good while an earlier receipt might still publish used to leave the
// minter no ending: report_blocked was refused as an unresolved sign-in. It now ends the build
// with the sign-in's own result.
it("lets the minter end the build once sign-in is unavailable and a receipt was held back", async () => {
  let executions = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("execute", authenticate, "sign_in"),
        call("report_blocked", {
          reason: "site_lacks_capability",
          explanation: "The account page cannot be reached without signing in.",
        }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: (_submitted, beforeDispatch = () => Effect.void) =>
        executions++ === 0
          ? beforeDispatch(readAllow).pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            )
          : Effect.fail(accountLocked),
    },
  );
  const outcome = await f.run();
  // report_blocked ended the build at once: no refusal went back for another model call.
  expect(f.requests).toHaveLength(3);
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "account_locked",
  });
  expect(outcome).not.toHaveProperty("blocked");
});

// The owner's summary of a failed sign-in is plain words: never the root cause's code or phase.
it("words a failed sign-in's summary without operator codes", async () => {
  const f = await fixture(
    (_request, index) => (index === 0 ? call("execute", authenticate) : prose("Stopping.")),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "credential_submit",
              code: "AuthenticationFailed",
              afterSubmission: true,
            },
            spentSignIn: "relogin_spent",
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    recoveryReason: "sign_in_unavailable",
    stopReason: "sign_in_failed",
  });
  expect(outcome.summary).toContain("could not be signed in");
  expect(outcome.summary).not.toMatch(/AuthenticationFailed|credential_submit|receipts/u);
});

// The owner chose not to sign in: their answer comes back as a result, not a failed sign-in, the
// host never signs in again, and the build may end as the owner's choice.
it("hands a declined login back as a result and ends as owner_declined when the minter stops", async () => {
  let signIns = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate, "first"),
        call("execute", authenticate, "again"),
        call("report_blocked", {
          reason: "policy",
          explanation: "Without signing in, the site shows no order history.",
        }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () =>
        Effect.suspend(() => {
          signIns++;
          return Effect.fail(new MintFailure({ code: "Unavailable", loginDeclined: "no_account" }));
        }),
    },
  );
  const outcome = await f.run();
  const declined = JSON.stringify(f.requests[1]?.input);
  expect(declined).toContain('\\"status\\":\\"login_declined\\"');
  expect(declined).toContain('\\"declined\\":\\"no_account\\"');
  expect(declined).not.toContain("authentication_unavailable");
  // The second authenticate hears the same answer and runs nothing.
  expect(signIns).toBe(1);
  expect(JSON.stringify(f.requests[2]?.input)).toContain("login_declined");
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "owner_declined" },
    stopReason: "owner_declined",
  });
  expect(outcome).not.toHaveProperty("recoveryReason");
});

// A login request Guardian routed a question to may be declined too: the minter hears it and
// builds the public part, and the host raises no further login request.
it("hands a declined login request back with the public-only guidance", async () => {
  let loginRequests = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", ask("What is your password?")),
        call("request_input", ask("What is your password, please?"), "again"),
        call("report_blocked", {
          reason: "owner_declined",
          explanation: "The owner chose not to sign in, and the site shows nothing signed out.",
        }),
      ][index] ?? prose("Stopping."),
    {
      // Guardian routes each password question to the host's login request, and allows the
      // blocked explanation.
      reviewQuestion: (candidate) =>
        Effect.succeed(
          candidate.questions[0]?.id === "blocked"
            ? { outcome: "allow_business" as const, rationale: "Plain." }
            : { outcome: "authentication" as const, rationale: "Asks for a login." },
        ),
      requestLogin: () =>
        Effect.sync(() => {
          loginRequests++;
          return "public_only" as const;
        }),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  const outcome = await f.run();
  const answer = JSON.stringify(f.requests[1]?.input);
  expect(answer).toContain('\\"declined\\":\\"public_only\\"');
  expect(answer).toContain("without signing in");
  expect(outcome).toMatchObject({ blocked: { reason: "owner_declined" } });
  // The second login question hears the owner's answer again; nobody is asked twice.
  expect(JSON.stringify(f.requests[2]?.input)).toContain("without signing in");
  expect(loginRequests).toBe(1);
});
