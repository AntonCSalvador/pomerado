import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import {
  codeBoxesRefusal,
  inspectAutofillStep,
  type AutofillStep,
} from "../../src/destinations/autofill-step.js";
import { hostPage } from "./autofill-host-page.js";

// Which code fields the host's inspection reads as one-character code boxes, and where each sits
// among them, when a page limits each box to one character by its own script rather than by
// `maxlength`. Chromium must lay the page out: a box counts only when it shows.

const site = "https://bank.example.test";

/** `count` see-through `tel` boxes with no `maxlength`, in one container, as script widgets draw. */
const scriptBoxes = (count: number) =>
  `<div id="boxes" style="display:flex;gap:4px"><input type="hidden" name="code">${Array.from(
    { length: count },
    (_, at) =>
      `<input id="box-${at + 1}" type="tel" inputmode="numeric" autocomplete="one-time-code" style="opacity:0;width:32px;height:40px">`,
  ).join("")}</div>`;

/** The code fields of each box, in order. */
const boxFields = (boxes: readonly number[]): AutofillStep["fields"] =>
  boxes.map((box) => ({ selector: `#box-${box}`, slot: "code" }));

/** Inspects the step on a page that shows `screen` in a form with a Verify button. */
const inspect = async (page: Page, screen: string, fields: AutofillStep["fields"]) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form method="post" action="/verify"><p>Enter the code we sent you</p>${screen}<button id="verify">Verify</button></form>`,
    }),
  );
  await page.goto(`${site}/verify`);
  const step: AutofillStep = { fields, submit: "#verify" };
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: await hostPage(page), siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  return { step, inspection, places: inspection.screen.fields.map((field) => field.codeBox) };
};

test("seven boxes a script limits, with no maxlength, are each read with their place among seven", async ({
  page,
}) => {
  const places = [1, 2, 3, 4, 5, 6, 7];
  const { step, inspection, places: read } = await inspect(page, scriptBoxes(7), boxFields(places));
  expect(read).toEqual(places.map((box) => ({ box, of: 7 })));
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

test("a step that names five of six boxes a script limits is sent back with how many the screen shows", async ({
  page,
}) => {
  const { step, inspection } = await inspect(page, scriptBoxes(6), boxFields([1, 2, 3, 4, 5]));
  expect(codeBoxesRefusal(step, inspection)).toMatchObject({
    outcome: "refused",
    reason: "code_boxes_incomplete",
    codeBoxes: { boxes: 6, named: [1, 2, 3, 4, 5] },
  });
});

test("one code field with no maxlength beside another text field is no box", async ({ page }) => {
  const { step, inspection, places } = await inspect(
    page,
    '<div><input id="name" aria-label="Name"><input id="code" autocomplete="one-time-code" aria-label="Code"></div>',
    [{ selector: "#code", slot: "code" }],
  );
  expect(places).toEqual([undefined]);
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});

test("two code fields with no maxlength, each alone in its own container, are no boxes", async ({ page }) => {
  const { places } = await inspect(
    page,
    '<div><input id="email-code" aria-label="Email code"></div><div><input id="text-code" aria-label="Text code"></div>',
    [
      { selector: "#email-code", slot: "code" },
      { selector: "#text-code", slot: "code" },
    ],
  );
  expect(places).toEqual([undefined, undefined]);
});

test("code fields with no maxlength beside a field of another type in their container are no boxes", async ({
  page,
}) => {
  const { places } = await inspect(
    page,
    '<div><input id="box-1" type="tel"><input id="box-2" type="tel"><input id="note" type="text" aria-label="Note"></div>',
    boxFields([1, 2]),
  );
  expect(places).toEqual([undefined, undefined]);
});

test("six boxes a script limits, split three and three between two containers, are no boxes, so a step that names all six is not sent back", async ({
  page,
}) => {
  const half = (first: number) =>
    `<div style="display:flex;gap:4px">${[first, first + 1, first + 2]
      .map((box) => `<input id="box-${box}" type="tel" inputmode="numeric" style="width:32px;height:40px">`)
      .join("")}</div>`;
  const { step, inspection, places } = await inspect(
    page,
    `<div style="display:flex;gap:8px">${half(1)}<span>-</span>${half(4)}</div>`,
    boxFields([1, 2, 3, 4, 5, 6]),
  );
  expect(places).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  expect(codeBoxesRefusal(step, inspection)).toBeUndefined();
});
