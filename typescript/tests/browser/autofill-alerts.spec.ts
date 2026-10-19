import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// Chromium must lay the page out: whether an alert is seen depends on its box and its styles.
const site = "https://member.example.test";
const step: AutofillStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#continue",
};

// The same notice shows before and after the submit; it is no answer to it.
const banner = '<div aria-live="polite">We use cookies on this site</div>';
const form = (field: string) =>
  `<form action="/session" method="post"><label>Password${field}</label><button id="continue">Sign in</button></form>`;

// Beside the site's answer, text no person sees, and a success notice, none of them an error: a
// screen reader's live region, a toast at opacity 0, an error moved off the page and a success
// alert. The field names its error, which wraps an alert of its own.
const answered = [
  banner,
  '<div role="alert">The password is incorrect</div>',
  '<div aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Form submitted</div>',
  '<div role="alert" style="opacity:0">Saved</div>',
  '<div class="error" style="position:absolute;left:-9999px;width:200px">Moved off the page</div>',
  '<div class="alert alert-success">Code sent</div>',
  '<div id="password-message">Error: <span role="alert">Try again</span></div>',
  form(
    '<input id="password" name="password" type="password" aria-invalid="true" aria-errormessage="password-message">',
  ),
].join("");

const serve = async (page: Page) => {
  await page.route(`${site}/**`, async (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        route.request().method() === "POST"
          ? answered
          : `${banner}${form('<input id="password" name="password" type="password">')}`,
    }),
  );
  await page.goto(`${site}/login`);
};

test("a submit's answer is the alert text a person sees that was not there before the click", async ({
  page,
}) => {
  await serve(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({
      step,
      page: await hostPage(page),
      siteOrigin: site,
      authenticationOrigins: [],
    }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["synthetic-alert-password"],
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  if (report.outcome !== "filled") throw new Error(`Fill did not complete: ${report.outcome}`);
  expect(report.controls?.alerts).toEqual([
    "We use cookies on this site",
    "The password is incorrect",
    "Error: Try again",
  ]);
  // The notice shown before the click is no answer to it.
  expect(report.controls?.newAlerts).toBe(2);
});
