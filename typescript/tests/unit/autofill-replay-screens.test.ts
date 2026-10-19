import { Data, Effect, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { makeReplayScreenWait } from "../../src/runtime/autofill-replay-screens.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

it.each(["not_found", "not_editable"] as const)(
  "keeps a required account choice when it is %s beside ready password fields",
  async (reason) => {
    const page = "https://example.test/login";
    const choice = { fields: [], submit: "#authorized-plan" } satisfies AutofillStep;
    const password = {
      fields: [{ slot: "password", selector: "#password" }],
      submit: "#submit",
    } satisfies AutofillStep;
    const later = { ...password, page };
    const hooks: AutofillHooks<TestFailure> = {
      inspect: (step) =>
        Effect.succeed(
          step.fields[0]?.selector === "#password"
            ? {
                page,
                siteOrigin: "https://example.test",
                authenticationOrigins: [],
                targets: { fields: [], submit: null },
                screen: { origin: "https://example.test", fields: [], submit: null, buttons: [] },
              }
            : { outcome: "refused", reason },
        ),
      check: () => Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: page }),
      fill: () => Effect.dieMessage("Unexpected fill"),
      confirm: () => Effect.dieMessage("Unexpected confirm"),
      open: () => Effect.dieMessage("Unexpected open"),
    };
    const wait = makeReplayScreenWait(
      {
        hooks,
        entryUrl: page,
        recipe: {
          version: 1,
          steps: [{ ...choice, page }, later],
          signedIn: { selector: "#identity" },
        },
        emit: () => Effect.void,
        correlation: { jobId: "job", attemptId: "attempt" },
      },
      { anythingSent: false, ran: [] },
      { stepWaitMs: 0, pollMs: 1 },
      () => password,
    );
    const result = await Effect.runPromise(
      wait(choice, 0, page, [later]).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(result).toEqual({ found: { outcome: "refused", reason } });
  },
);
