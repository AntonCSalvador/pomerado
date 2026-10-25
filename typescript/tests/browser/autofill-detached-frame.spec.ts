import { expect, test } from "@playwright/test";
import type { Frame, Locator, Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A page can take a frame away while a step call searches its frames, as an ad slot or a widget
// that reloads itself does. A frame that is gone holds nothing to type into, so the search skips it
// and reads the rest; any other failure still fails the call.
const site = "https://login.example.test";
const ads = "https://ads.widgets.test";

const loginStep: AutofillStep = {
  fields: [
    { selector: "input[name=username]", slot: "username", accepts: ["username"] },
    { selector: "input[name=password]", slot: "password" },
  ],
  submit: 'button:text-is("Sign in")',
};

const loginForm = `<form action="/session" method="post">
<label>Username<input name="username"></label>
<label>Password<input name="password" type="password"></label>
<button>Sign in</button></form>`;

/** Serves the sign-in page with the ad slot's frame, and waits for the frame's content. */
const serve = async (page: Page, screen: string, slot: string, slotOrigin = ads) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `${screen}<iframe src="${slotOrigin}/slot"></iframe>` }),
  );
  await page.route(`${slotOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<p>Sponsored</p>${slot}` }),
  );
  await page.goto(`${site}/login`);
  const frame = page.frames().find((each) => each !== page.mainFrame());
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("p").waitFor();
  return frame;
};

/**
 * Fails the ad slot's frame on the `nth` call (from 1) of `at` on a locator the inspection makes in
 * it for a selector `when` accepts. `detach` takes the frame out of the page just before that call
 * runs, so Playwright's own call fails as the frame is gone; otherwise the call throws while the
 * frame stays attached.
 */
const failFrame = (
  page: Page,
  frame: Frame,
  failure: {
    readonly at: "count" | "isVisible";
    readonly when: (selector: string) => boolean;
    readonly nth?: number;
    readonly detach: boolean;
  },
) => {
  const locate = frame.locator.bind(frame);
  let calls = 0;
  const failing = (located: Locator): Locator =>
    new Proxy(located, {
      get: (target, property) => {
        if (property === "nth") return (index: number) => failing(target.nth(index));
        if (property === failure.at)
          return async (options?: { readonly timeout?: number }) => {
            calls++;
            if (calls === (failure.nth ?? 1)) {
              if (!failure.detach) throw new Error("Synthetic frame failure");
              const gone = page.waitForEvent("framedetached");
              await page.evaluate(() => document.querySelector("iframe")?.remove());
              await gone;
            }
            return failure.at === "count" ? target.count() : target.isVisible(options);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  Object.defineProperty(frame, "locator", {
    configurable: true,
    value: (selector: string, options?: Parameters<Frame["locator"]>[1]) => {
      const located = locate(selector, options);
      return failure.when(selector) ? failing(located) : located;
    },
  });
};

const inspect = async (page: Page, step: AutofillStep) =>
  Effect.runPromise(
    inspectAutofillStep({ step, page: await hostPage(page), siteOrigin: site, authenticationOrigins: [] }),
  );

/** Where the inspection found each of the step's fields, by origin. */
const fieldOrigins = (inspection: Awaited<ReturnType<typeof inspect>>) => {
  if ("outcome" in inspection)
    throw new Error(
      `Inspection refused: ${inspection.reason} ${JSON.stringify(inspection.failureDetail ?? null)}`,
    );
  return inspection.targets.fields.map((field) => field.ownerUrl);
};

test("finds the sign-in fields when a frame detaches as the search reaches it", async ({ page }) => {
  const frame = await serve(page, loginForm, "");
  failFrame(page, frame, {
    at: "count",
    when: (selector) => selector === "input[name=username]",
    detach: true,
  });
  expect(fieldOrigins(await inspect(page, loginStep))).toEqual([site, site]);
  expect(frame.isDetached()).toBe(true);
});

test("a frame that detaches while its matches are checked leaves none of them behind", async ({
  page,
}) => {
  // The slot's own sign-up form matches the selector twice; it goes away after its first match was
  // read as visible, so the page's own field is the one visible match left.
  const frame = await serve(
    page,
    loginForm,
    '<input name="username" aria-label="Newsletter"><input name="username" aria-label="Newsletter again">',
  );
  failFrame(page, frame, {
    at: "isVisible",
    when: (selector) => selector === "input[name=username]",
    nth: 2,
    detach: true,
  });
  expect(fieldOrigins(await inspect(page, loginStep))).toEqual([site, site]);
});

test("a field only in a frame that detaches is not found", async ({ page }) => {
  const frame = await serve(page, "<p>Sign in below</p>", '<input name="username" aria-label="Username">');
  failFrame(page, frame, {
    at: "count",
    when: (selector) => selector === "input[name=username]",
    detach: true,
  });
  const inspection = await inspect(page, {
    fields: [{ selector: "input[name=username]", slot: "username", accepts: ["username"] }],
  });
  expect(inspection).toMatchObject({
    outcome: "refused",
    reason: "not_found",
    target: 0,
    failureDetail: { context: { check: "not_found", framesSearched: 2 } },
  });
});

test("reads the screen's buttons when a frame detaches as their search reaches it", async ({
  page,
}) => {
  const frame = await serve(page, loginForm, "<button>Learn more</button>");
  failFrame(page, frame, {
    at: "count",
    when: (selector) => selector.startsWith("button, "),
    detach: true,
  });
  const inspection = await inspect(page, loginStep);
  expect(fieldOrigins(inspection)).toEqual([site, site]);
  expect(inspection).toMatchObject({ screen: { buttons: ["Sign in"] } });
});

test("fills the sign-in when a frame detaches as a fill call's search reaches it", async ({
  page,
}) => {
  // The slot shares the page's process, so the host keyboard's sessions outlive it.
  const frame = await serve(page, loginForm, "", "https://ads.example.test");
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: loginStep, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Fixture inspection refused: ${inspection.reason}`);
  failFrame(page, frame, {
    at: "count",
    when: (selector) => selector === "input[name=username]",
    detach: true,
  });
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: loginStep,
      values: ["synthetic-user", "synthetic-pass"],
      inspection,
      page: host,
      keyboard,
    }),
  );
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(frame.isDetached()).toBe(true);
});

const field = (selector: string) => selector === "input[name=username]";
for (const [search, at, when, slot] of [
  ["the fields", "count", field, ""],
  ["the fields' matches", "isVisible", field, '<input name="username" aria-label="Newsletter">'],
  ["the buttons", "count", (selector: string) => selector.startsWith("button, "), "<button>Learn more</button>"],
] as const)
  test(`a frame that fails without detaching during the search for ${search} still fails the inspection`, async ({
    page,
  }) => {
    const frame = await serve(page, loginForm, slot);
    failFrame(page, frame, { at, when, detach: false });
    const inspection = await inspect(page, loginStep);
    expect(inspection).toMatchObject({
      outcome: "refused",
      reason: "page_unavailable",
      failureDetail: {
        operation: "autofill.inspect",
        underlying: { message: "Synthetic frame failure" },
      },
    });
    expect(frame.isDetached()).toBe(false);
  });
