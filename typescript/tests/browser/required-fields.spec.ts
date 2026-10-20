import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { formControlsCode } from "../../src/browser/form-controls.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The authoring library's required-field helpers, run as a Kernel call body runs them (`page` in
// scope) on a local quote form that adds required fields once an earlier answer is in. Chromium
// must lay the page out: a field counts only while it is visible.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${formControlsCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: answer.error };
};

/** What the page's form would submit. */
const submitted = (page: Page) =>
  page.evaluate(() => {
    const form = document.forms[0];
    return form === undefined ? {} : Object.fromEntries(new FormData(form));
  });

/**
 * A home insurance quote: answering that the roof was replaced reveals the fields that depend on
 * it, with fields that never count beside them (filled, hidden, disabled or optional).
 */
const quoteForm = `
<form aria-label="Quote">
  <label for="holder">Policy holder</label><input id="holder" name="holder" required value="Jane Doe">
  <label for="replaced">Roof replaced</label>
  <select id="replaced" name="replaced" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
  <fieldset id="roof" hidden>
    <label for="year">Year of roof
      replacement</label><input id="year" name="year" required>
    <label>Roof material
      <select name="material" required>
        <option value="">Choose one</option><option>Asphalt shingle</option><option>Metal</option><option disabled>Thatch</option>
      </select>
    </label>
    <span id="county-name">County</span>
    <input role="combobox" name="county" aria-labelledby="county-name" aria-required="true" aria-expanded="false" aria-controls="county-list" autocomplete="off">
    <div role="listbox" id="county-list" hidden><div role="option">Kent</div><div role="option">Essex</div></div>
    <div role="combobox" aria-haspopup="listbox" aria-label="Roof pitch" aria-required="true" tabindex="0">&#8203;</div>
    <input aria-label="Previous claims" name="claims" aria-invalid="true">
    <input type="checkbox" id="confirm" name="confirm" required><label for="confirm">I confirm the details</label>
    <label for="inspected">Inspection date</label><input type="date" id="inspected" name="inspected" required>
    <label for="pin">Account PIN</label><input type="password" id="pin" name="pin" required>
    <input name="unnamed" required>
    <label for="notes">Notes</label><textarea id="notes" name="notes"></textarea>
    <input aria-label="Agent code" name="agent" required style="display:none">
    <input aria-label="Branch" name="branch" required disabled>
  </fieldset>
</form>
<script>
  document.querySelector("#replaced").addEventListener("change", (event) => {
    document.querySelector("#roof").hidden = event.target.value !== "Yes";
  });
  const county = document.querySelector("[role=combobox]");
  const list = document.querySelector("#county-list");
  county.addEventListener("click", () => { list.hidden = false; county.setAttribute("aria-expanded", "true"); });
  list.addEventListener("click", (event) => {
    county.value = event.target.closest("[role=option]").textContent;
    list.hidden = true;
    county.setAttribute("aria-expanded", "false");
  });
</script>`;

const roofFields = [
  {
    label: "Year of roof replacement",
    shape: "text",
  },
  {
    label: "Roof material",
    shape: "select",
    options: [
      { value: "Asphalt shingle", label: "Asphalt shingle" },
      { value: "Metal", label: "Metal" },
    ],
  },
  {
    label: "County",
    shape: "combobox",
    options: [
      { value: "Kent", label: "Kent" },
      { value: "Essex", label: "Essex" },
    ],
  },
  // A custom dropdown that shows a zero-width space while empty, its listbox not rendered yet.
  { label: "Roof pitch", shape: "combobox" },
  { label: "Previous claims", shape: "text" },
  { label: "I confirm the details", shape: "other", unsupported: true },
  { label: "Inspection date", shape: "date", unsupported: true },
  { label: "Account PIN", shape: "other", unsupported: true },
  { label: "", shape: "text", unsupported: true },
];

test("unfilledRequiredFields finds the required fields an earlier answer revealed, by their labels", async ({
  page,
}) => {
  await page.setContent(quoteForm);
  const form = `page.getByRole("form", { name: "Quote" })`;
  // Before the tool answers the roof question from its input, that select is the one empty field.
  expect(await call(page, `return await unfilledRequiredFields(${form});`)).toEqual({
    result: [
      {
        label: "Roof replaced",
        shape: "select",
        options: [
          { value: "Yes", label: "Yes" },
          { value: "No", label: "No" },
        ],
      },
    ],
  });
  await page.locator("#replaced").selectOption("Yes");
  expect(await call(page, `return await unfilledRequiredFields(${form});`)).toEqual({
    result: roofFields,
  });
});

test("fillRequiredField fills a text field, a select and a combobox by label, and they drop out once filled", async ({
  page,
}) => {
  await page.setContent(quoteForm);
  await page.locator("#replaced").selectOption("Yes");
  const form = `page.getByRole("form", { name: "Quote" })`;
  expect(
    await call(
      page,
      `return [
        await fillRequiredField(${form}, "Year of roof replacement", "1998"),
        await fillRequiredField(${form}, "Roof material", "Metal"),
        await fillRequiredField(${form}, "County", "Essex"),
        await unfilledRequiredFields(${form}),
      ];`,
    ),
  ).toEqual({
    result: [
      { shape: "text" },
      { shape: "select" },
      { shape: "combobox" },
      roofFields.filter(({ label }) => !["Year of roof replacement", "Roof material", "County"].includes(label)),
    ],
  });
  expect(await submitted(page)).toMatchObject({ year: "1998", material: "Metal", county: "Essex" });
});

test("fillRequiredField names why it could not fill, never the value", async ({ page }) => {
  await page.setContent(`<form>
  <label>Year built<input name="built" required></label>
  <label>Owner<input name="first" required></label><label>Owner<input name="second" required></label>
  <label>Postcode<input name="postcode" required></label>
  <label>Contact by post<input type="checkbox" name="post" required></label>
</form>
<script>
  document.querySelector("[name=postcode]").addEventListener("input", (event) => { event.target.value = ""; });
</script>`);
  const form = `page.locator("form")`;
  expect(await call(page, `return await fillRequiredField(${form}, "Year of purchase", "2001");`)).toEqual({
    error: "field_missing",
  });
  expect(await call(page, `return await fillRequiredField(${form}, "Owner", "Sam Roe");`)).toEqual({
    error: "field_ambiguous",
  });
  expect(await call(page, `return await fillRequiredField(${form}, "Postcode", "AB1 2CD");`)).toEqual({
    error: "not_committed",
  });
  expect(await call(page, `return await fillRequiredField(${form}, "Contact by post", "yes");`)).toEqual({
    error: "field_missing",
  });
  expect(await submitted(page)).toEqual({ built: "", first: "", second: "", postcode: "" });
});
