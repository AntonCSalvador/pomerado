import { Data, Effect } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A read's sign-in that lands on a page that can't tell signs in from the check that found it so.
// Here the page moves on to the account page, where the marker shows, between that check and the
// end of the sign-in, as an SSO "redirecting" page or a header drawn seconds late does. The page
// is scripted, so the move lands exactly between the two.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};

/** The password screen, a landing page off the marker's path, then the account page. */
const replay = async () => {
  let page: "login" | "landing" | "account" = "login";
  let confirms = 0;
  const confirmed: unknown[] = [];
  const isPassword = (step: AutofillStep) =>
    step.fields.some((field) => field.selector === "#password");
  const here = () =>
    page === "account"
      ? ({ signedIn: true, url: `${origin}/account` } as const)
      : page === "landing"
        ? ({ signedIn: false, failed: "path_mismatch", url: `${origin}/choose` } as const)
        : ({ signedIn: false, failed: "indicator_not_visible", url: login } as const);
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () =>
      Effect.sync(() => {
        confirms += 1;
        return here();
      }),
    inspect: (step) =>
      Effect.sync(() => {
        // Once the landing page settled, the page moves on as the host looks for the password
        // field again.
        if (page === "landing" && isPassword(step)) page = "account";
        return page === "login" && isPassword(step)
          ? {
              page: login,
              siteOrigin: origin,
              authenticationOrigins: [],
              targets: {
                fields: step.fields.map(() => target),
                submit: { ...target, editable: false, control: "other" as const },
              },
              screen: { origin, fields: [], submit: null, buttons: ["Sign in"] },
            }
          : { outcome: "refused" as const, reason: "not_found" as const };
      }),
    fill: ({ step }) =>
      Effect.sync(() => {
        page = "landing";
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: login,
        };
      }),
    confirmCantTell: (identifiers) =>
      Effect.sync(() => {
        confirmed.push(identifiers);
      }),
  };
  const recipe: AutofillRecipe = {
    version: 2,
    steps: [{ page: login, fields: [{ selector: "#password", slot: "password" }], submit: "#go" }],
    signedIn: { selector: "#identity", urlPath: "/account" },
  };
  const outcome = await Effect.runPromise(
    replayAutofillRecipe({
      recipe,
      hooks,
      entryUrl: login,
      credentials: { username: "synthetic-user", password: "synthetic-password" },
      ask: () => Effect.dieMessage("Unexpected question"),
      broker: {
        register: () => Effect.void,
        registeredSecretMatches: () => Effect.succeed([]),
      },
      site: "example.test",
      correlation: { jobId: "job", attemptId: "attempt" },
      emit: () => Effect.void,
      failures: {
        unanswered: () => new TestFailure({ code: "BrowserUnavailable" }),
        unavailable: () => new TestFailure({ code: "BrowserUnavailable" }),
      },
      timing: { stepWaitMs: 5_000, pollMs: 20 },
      sent: { current: false },
    }).pipe(Effect.scoped),
  );
  return { outcome, confirms, confirmed, page };
};

it("signs a read in on a page that can't tell though the marker shows before its sign-in ends", async () => {
  const { outcome, confirms, confirmed, page } = await replay();
  expect(page).toBe("account");
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  // It checked the identifiers it sent without binding them, and waited out no marker settle.
  expect(confirmed).toHaveLength(1);
  expect(confirms).toBe(0);
}, 20_000);
