import { Data, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillSignedInCheck, AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import type { ReplayWorkspace } from "../../src/runtime/autofill-replay-workspace.js";

// A recorded approval step, where the owner approves the sign-in on another device, as a replay
// on a new browser meets it. The site's approval page often carries a code of its own in its path,
// and a recording may have saved the signed-in page instead, so neither page shows again: the
// replay admits the approval on any page of the recorded page's origin that is no other recorded
// screen, shows no returned credential form and shows no signed-in marker.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const home = `${origin}/feed`;
const pollMs = 50;
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const loginScreen: AutofillRecipe["steps"][number] = {
  page: login,
  fields: [
    { selector: "#username", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#go",
};
const onLoginForm = (step: AutofillStep) =>
  step.fields.some((field) => field.selector === "#password" || field.selector === "#username");

/**
 * A site whose login form sends the browser to `afterSubmit`, where the owner approves the sign-in
 * on a device, after which the page shows the signed-in home page. `formAt` lists the pages that
 * show the login form, such as a form post's answer showing it again.
 */
const approvalSite = (afterSubmit: string, formAt: readonly string[] = [login]) => {
  const site = { page: login, signedIn: false };
  const here = (): AutofillSignedInCheck =>
    site.signedIn && site.page === home
      ? { signedIn: true, url: home }
      : { signedIn: false, failed: "indicator_not_visible", url: site.page };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    // A step with fields shows only where the login form does; a fieldless step, such as an
    // approval, is found on whatever page shows, as the host's inspection of one is.
    inspect: (step) =>
      Effect.sync(() =>
        onLoginForm(step) && !formAt.includes(site.page)
          ? ({ outcome: "refused", reason: "not_found" } as const)
          : {
              page: site.page,
              siteOrigin: origin,
              authenticationOrigins: [],
              targets: {
                fields: step.fields.map(() => target),
                submit:
                  step.submit === undefined
                    ? null
                    : { ...target, editable: false, control: "other" as const },
              },
              screen: { origin, fields: [], submit: null, buttons: [] },
            },
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        site.page = afterSubmit;
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: afterSubmit,
        };
      }),
  };
  /** The owner approved on the device: the site signs the browser in and shows its home page. */
  const approve = () => {
    site.signedIn = true;
    site.page = home;
  };
  return { hooks, site, approve };
};

/** A login screen, then an approval recorded on `approvalPage`. */
const recipe = (approvalPage: string): AutofillRecipe => ({
  version: 2,
  steps: [loginScreen, { page: approvalPage, fields: [], approval: "device" }],
  signedIn: { selector: "#identity" },
});

/**
 * Replays `recipe` on `site` with the login, the test clock moving one poll at a time. The owner
 * confirms every approval question, which approves the sign-in on the device first.
 */
const replay = async (
  recipeToRun: AutofillRecipe,
  site: ReturnType<typeof approvalSite>,
  workspace?: ReplayWorkspace<TestFailure>,
) => {
  const questions: string[] = [];
  const events: unknown[] = [];
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        replayAutofillRecipe({
          recipe: recipeToRun,
          hooks: site.hooks,
          entryUrl: login,
          credentials: { username: "synthetic-user", password: "synthetic-password" },
          ask: (request) =>
            Effect.sync(() => {
              for (const question of request.questions) questions.push(question.id);
              site.approve();
              return { approved: { type: "confirm" as const, value: { confirmed: true } } };
            }),
          broker: {
            register: () => Effect.void,
            registeredSecretMatches: () => Effect.succeed([]),
          },
          site: "example.test",
          correlation: undefined,
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          failures: {
            unanswered: () => new TestFailure({ code: "Unanswered" }),
            unavailable: () => new TestFailure({ code: "Unavailable" }),
          },
          timing: { stepWaitMs: 5_000, pollMs },
          sent: { current: false },
          ...(workspace === undefined ? {} : { workspace }),
        }).pipe(Effect.scoped),
      );
      for (let polls = 0; polls < 1_000; polls++) {
        if (Option.isSome(yield* Fiber.poll(running))) break;
        yield* TestClock.adjust(Duration.millis(pollMs));
      }
      return yield* Fiber.join(running);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  return { outcome, questions, events };
};

it("admits an approval page whose path holds another sign-in's code, on the recorded origin", async () => {
  const site = approvalSite(`${origin}/checkpoint/BBB/`);
  const { outcome, questions } = await replay(recipe(`${origin}/checkpoint/AAA/`), site);
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(questions).toEqual(["approved"]);
});

it("admits the approval page when the recording saved the signed-in home page instead", async () => {
  const site = approvalSite(`${origin}/checkpoint/BBB/`);
  const { outcome, questions } = await replay(recipe(`${home}/`), site);
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(questions).toEqual(["approved"]);
});

it("still admits the exact recorded approval page", async () => {
  const site = approvalSite(`${origin}/checkpoint/AAA/`);
  const { outcome, questions } = await replay(recipe(`${origin}/checkpoint/AAA/`), site);
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(questions).toEqual(["approved"]);
});

it("never admits an approval page on another origin, and asks nothing", async () => {
  const site = approvalSite("https://other.example.test/checkpoint/BBB/");
  const { outcome, questions } = await replay(recipe(`${origin}/checkpoint/AAA/`), site);
  expect(outcome).toMatchObject({ outcome: "unclear", reason: "screen_origin_changed" });
  expect(questions).toEqual([]);
});

it("never admits an approval page on the login's own workspace origin, which the screen check admits", async () => {
  const pinned = "https://acme.example.test";
  const site = approvalSite(`${pinned}/checkpoint/BBB/`);
  const { outcome, questions } = await replay(
    { ...recipe(`${origin}/checkpoint/AAA/`), version: 4, workspace: { parent: "example.test" } },
    site,
    { siteOrigin: origin, parent: "example.test", pinned, observe: () => Effect.void },
  );
  expect(outcome).toMatchObject({ outcome: "unclear", reason: "screen_changed" });
  expect(questions).toEqual([]);
});

it("ends as before when the login form shows again on its recorded page, and asks nothing", async () => {
  const site = approvalSite(login);
  const { outcome, questions } = await replay(recipe(`${origin}/checkpoint/AAA/`), site);
  expect(outcome).toMatchObject({ outcome: "unclear", reason: "screen_changed" });
  expect(questions).toEqual([]);
});

it("ends as before when a form post's answer shows the login form again, and asks nothing", async () => {
  const session = `${origin}/session`;
  const site = approvalSite(session, [login, session]);
  const { outcome, questions } = await replay(recipe(`${origin}/checkpoint/AAA/`), site);
  expect(outcome).toMatchObject({ outcome: "unclear", reason: "screen_changed" });
  expect(questions).toEqual([]);
});

it("signs in without a question when the site skipped its approval and shows the marker", async () => {
  const site = approvalSite(home);
  site.site.signedIn = true;
  const { outcome, questions, events } = await replay(recipe(`${origin}/checkpoint/AAA/`), site);
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
  expect(questions).toEqual([]);
  expect(events).toContainEqual({ stage: "skipped", reason: "signed_in_indicator" });
});
