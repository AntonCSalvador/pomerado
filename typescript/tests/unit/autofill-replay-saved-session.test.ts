import { Data, Effect } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A saved session whose site shows a page of its own at the login address, with no sign-in form,
// no marker and no redirect: before the first screen's wait ends, the recipe's account page
// decides. A wait after a recorded click never reopens the entry, since that would lose the click.

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

/** A site signed in already, whose login address shows its public page. */
const replay = async (steps: AutofillRecipe["steps"]) => {
  const opened: string[] = [];
  const confirmed: (string | undefined)[] = [];
  const isLogIn = (step: AutofillStep) => step.submit === "#log-in" && step.fields.length === 0;
  const hooks: AutofillHooks<TestFailure> = {
    open: (url) =>
      Effect.sync(() => {
        opened.push(url);
      }),
    check: () =>
      Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: login } as const),
    confirm: (indicator) =>
      Effect.sync(() => {
        confirmed.push(indicator.openPath);
        return indicator.openPath === undefined
          ? ({ signedIn: false, failed: "indicator_not_visible", url: login } as const)
          : ({ signedIn: true, url: `${origin}/account` } as const);
      }),
    // Only a "Log in" link shows; no recorded sign-in screen does.
    inspect: (step) =>
      Effect.succeed(
        isLogIn(step)
          ? {
              page: login,
              siteOrigin: origin,
              authenticationOrigins: [],
              targets: { fields: [], submit: target },
              screen: { origin, fields: [], submit: null, buttons: ["Log in"] },
            }
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: () =>
      Effect.succeed({ outcome: "filled" as const, fields: [], submit: "clicked" as const, url: login }),
  };
  const recipe: AutofillRecipe = {
    version: 2,
    steps,
    signedIn: { selector: "#identity", openPath: "/account" },
  };
  const outcome = await Effect.runPromise(
    replayAutofillRecipe({
      recipe,
      hooks,
      entryUrl: login,
      credentials: undefined,
      ask: () => Effect.dieMessage("Unexpected question"),
      broker: {
        register: () => Effect.void,
        registeredSecretMatches: () => Effect.succeed([]),
      },
      site: "example.test",
      correlation: undefined,
      emit: () => Effect.void,
      failures: {
        unanswered: () => new TestFailure({ code: "Unanswered" }),
        unavailable: () => new TestFailure({ code: "Unavailable" }),
      },
      timing: { stepWaitMs: 60, pollMs: 5 },
      sent: { current: false },
    }).pipe(Effect.scoped),
  );
  return { outcome, opened, confirmed };
};

const passwordScreen = {
  page: login,
  fields: [{ selector: "#password", slot: "password" as const }],
  submit: "#go",
};

it("signs a saved session in by the account page when the login address shows no screen", async () => {
  const { outcome, opened, confirmed } = await replay([passwordScreen]);
  expect(outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true });
  expect(opened).toEqual([login]);
  expect(confirmed).toEqual(["/account"]);
});

it("never checks the account page once a recorded click ran, so the entry is not reopened", async () => {
  const logIn = { page: login, fields: [], submit: "#log-in" };
  const { outcome, opened } = await replay([logIn, passwordScreen]);
  expect(outcome).toMatchObject({ outcome: "unsent" });
  expect(opened).toEqual([login]);
});
