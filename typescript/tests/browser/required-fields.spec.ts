import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { formControlsCode } from "../../src/browser/form-controls.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The authoring library's required-field helpers, run as a Kernel call body runs them (`page` in
// scope) on a local checkout form that adds required fields once an earlier answer is in.
// Chromium must lay the page out: a field counts only while it is visible.
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
 * A checkout: choosing engraving reveals the fields that depend on it, with fields that never
 * count beside them (filled, hidden, disabled or optional).
 */
const checkoutForm = `
<form aria-label="Checkout">
  <label for="item">Item</label><input id="item" name="item" required value="Fountain pen">
  <label for="engraved">Engraving</label>
  <select id="engraved" name="engraved" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
  <fieldset id="engraving" hidden>
    <label for="text">Engraving
      text</label><input id="text" name="text" required>
    <label>Engraving style
      <select name="style" required>
        <option value="">Choose one</option><option>Script</option><option>Block capitals</option><option disabled>Gothic</option>
      </select>
    </label>
    <span id="box-name">Gift box</span>
    <input role="combobox" name="box" aria-labelledby="box-name" aria-required="true" aria-expanded="false" aria-controls="box-list" autocomplete="off">
    <div role="listbox" id="box-list" hidden><div role="option">Plain</div><div role="option">Velvet</div></div>
    <div role="combobox" aria-haspopup="listbox" aria-label="Ribbon colour" aria-required="true" tabindex="0">&#8203;</div>
    <input aria-label="Gift message" name="message" aria-invalid="true">
    <input type="checkbox" id="terms" name="terms" required><label for="terms">I accept the engraving terms</label>
    <label for="ready">Ready by</label><input type="date" id="ready" name="ready" required>
    <label for="pin">Account PIN</label><input type="password" id="pin" name="pin" required>
    <input name="unnamed" required>
    <label for="notes">Notes</label><textarea id="notes" name="notes"></textarea>
    <input aria-label="Store code" name="store" required style="display:none">
    <input aria-label="Branch" name="branch" required disabled>
  </fieldset>
</form>
<script>
  document.querySelector("#engraved").addEventListener("change", (event) => {
    document.querySelector("#engraving").hidden = event.target.value !== "Yes";
  });
  const box = document.querySelector("[role=combobox]");
  const list = document.querySelector("#box-list");
  box.addEventListener("click", () => { list.hidden = false; box.setAttribute("aria-expanded", "true"); });
  list.addEventListener("click", (event) => {
    box.value = event.target.closest("[role=option]").textContent;
    list.hidden = true;
    box.setAttribute("aria-expanded", "false");
  });
</script>`;

const engravingFields = [
  {
    label: "Engraving text",
    shape: "text",
  },
  {
    label: "Engraving style",
    shape: "select",
    options: [
      { value: "Script", label: "Script" },
      { value: "Block capitals", label: "Block capitals" },
    ],
  },
  {
    label: "Gift box",
    shape: "combobox",
    options: [
      { value: "Plain", label: "Plain" },
      { value: "Velvet", label: "Velvet" },
    ],
  },
  // A custom dropdown that shows a zero-width space while empty, its listbox not rendered yet.
  { label: "Ribbon colour", shape: "combobox" },
  { label: "Gift message", shape: "text" },
  { label: "I accept the engraving terms", shape: "other", unsupported: true },
  { label: "Ready by", shape: "date", unsupported: true },
  { label: "Account PIN", shape: "other", unsupported: true },
  { label: "", shape: "text", unsupported: true },
];

test("unfilledRequiredFields finds the required fields an earlier answer revealed, by their labels", async ({
  page,
}) => {
  await page.setContent(checkoutForm);
  const form = `page.getByRole("form", { name: "Checkout" })`;
  // Before the tool answers the engraving question from its input, that select is the one empty field.
  expect(await call(page, `return await unfilledRequiredFields(${form});`)).toEqual({
    result: [
      {
        label: "Engraving",
        shape: "select",
        options: [
          { value: "Yes", label: "Yes" },
          { value: "No", label: "No" },
        ],
      },
    ],
  });
  await page.locator("#engraved").selectOption("Yes");
  expect(await call(page, `return await unfilledRequiredFields(${form});`)).toEqual({
    result: engravingFields,
  });
});

test("fillRequiredField fills a text field, a select and a combobox by label, and they drop out once filled", async ({
  page,
}) => {
  await page.setContent(checkoutForm);
  await page.locator("#engraved").selectOption("Yes");
  const form = `page.getByRole("form", { name: "Checkout" })`;
  expect(
    await call(
      page,
      `return [
        await fillRequiredField(${form}, "Engraving text", "J.D."),
        await fillRequiredField(${form}, "Engraving style", "Script"),
        await fillRequiredField(${form}, "Gift box", "Velvet"),
        await unfilledRequiredFields(${form}),
      ];`,
    ),
  ).toEqual({
    result: [
      { shape: "text" },
      { shape: "select" },
      { shape: "combobox" },
      engravingFields.filter(({ label }) => !["Engraving text", "Engraving style", "Gift box"].includes(label)),
    ],
  });
  expect(await submitted(page)).toMatchObject({ text: "J.D.", style: "Script", box: "Velvet" });
});

test("unfilledRequiredFields never offers a card, code, password or identity number field as a question", async ({
  page,
}) => {
  // Identity, tax and bank numbers and a card's expiry, by their label in each language covered.
  const identityLabels = [
    "Passport number",
    "Driver's licence",
    "Driving license number",
    "National insurance number",
    "National ID",
    "TIN",
    "EIN",
    "IBAN",
    "Bank account number",
    "Routing number",
    "Routing transit number",
    "Sort code",
    "Card expiry",
    "CC exp",
    "Expiration date on card",
    "Expiration (MM/YY)",
    "Valid thru",
    "Reisepass",
    "Führerschein",
    "Personalausweis",
    "Sozialversicherungsnummer",
    "Kontonummer",
    "Bankleitzahl",
    "Pasaporte",
    "Permiso de conducir",
    "DNI",
    "NIE",
    "Número de la Seguridad Social",
    "Cuenta bancaria",
    "Passeport",
    "Permis de conduire",
    "Carte d'identité",
    "Numéro de sécurité sociale",
    "Compte bancaire",
  ];
  // Business and shop fields that only sound like them stay ordinary text.
  const ordinaryLabels = ["VAT number", "Tax ID", "NIF", "Account number", "Expiry date", "Routing instructions", "SWIFT"];
  // Each is asked by the host's own protected forms, never as a site field, whatever its type.
  await page.setContent(`<form>
  <label>Number<input type="tel" name="n1" autocomplete="cc-number" required></label>
  <label>Code<input type="tel" name="n2" autocomplete="billing cc-csc" required></label>
  <label>Expiry<input name="n3" autocomplete="cc-exp" required></label>
  <label>Choose a word<input name="n4" autocomplete="new-password" required></label>
  <label>Your word<input name="n5" autocomplete="current-password" required></label>
  <label>Text code<input name="n6" autocomplete="one-time-code" required></label>
  <label>SSN<input name="n7" required></label>
  <label>Social security number<input name="n8" required></label>
  <label>Verification code<input name="n9" required></label>
  <label>Security code<input name="n10" required></label>
  <label>CVV<input name="n11" required></label>
  <label>Card number<input name="n12" required></label>
  <label>Password<input name="n13" required></label>
  <label>Number on card<input name="cardNumber" required></label>
  <label>Expires<input name="ccExpiry" required></label>
  <label>Ends<input name="cc-exp" required></label>
  <label>Card #<input name="n14" required></label>
  <label>Credit card<input name="n15" required></label>
  <label>Card verification value<input name="n16" required></label>
  <label>CVN<input name="n17" required></label>
  <label>CID<input name="n18" required></label>
  <label>OTP<input name="n19" required></label>
  <label>SMS code<input name="n20" required></label>
  <label>Authentication code<input name="n21" required></label>
  <label>6-digit code<input name="n22" required></label>
  <label>Card PIN<input name="n23" required></label>
  <label>Kartennummer<input name="n24" required></label>
  <label>Número de tarjeta<input name="n25" required></label>
  <label>Numéro de carte<input name="n26" required></label>
  <label>Passwort<input name="n27" required></label>
  <label>Kennwort<input name="n28" required></label>
  <label>Contraseña<input name="n29" required></label>
  <label>Mot de passe<input name="n30" required></label>
  ${identityLabels.map((label, index) => `<label>${label}<input name="id${index}" required></label>`).join("")}
  <label>Reference<input name="ref" required readonly></label>
  <label>Card message<input name="note" required></label>
  <label>PIN code<input name="postal" required></label>
  <label>Pincode<input name="postal2" required></label>
  <label>Nationality<input name="nationality" required></label>
  <label>Tin colour<input name="colour" required></label>
  ${ordinaryLabels.map((label, index) => `<label>${label}<input name="plain${index}" required></label>`).join("")}
</form>`);
  expect(await call(page, `return await unfilledRequiredFields(page.locator("form"));`)).toEqual({
    result: [
      ...[
        "Number",
        "Code",
        "Expiry",
        "Choose a word",
        "Your word",
        "Text code",
        "SSN",
        "Social security number",
        "Verification code",
        "Security code",
        "CVV",
        "Card number",
        "Password",
        "Number on card",
        "Expires",
        "Ends",
        "Card #",
        "Credit card",
        "Card verification value",
        "CVN",
        "CID",
        "OTP",
        "SMS code",
        "Authentication code",
        "6-digit code",
        "Card PIN",
        "Kartennummer",
        "Número de tarjeta",
        "Numéro de carte",
        "Passwort",
        "Kennwort",
        "Contraseña",
        "Mot de passe",
        ...identityLabels,
      ].map((label) => ({ label, shape: "other", unsupported: true })),
      // A read-only box is not one the caller's answer can go into.
      { label: "Reference", shape: "other", unsupported: true },
      // A greeting card's message is no card number, and a PIN code or pincode is a postcode.
      { label: "Card message", shape: "text" },
      { label: "PIN code", shape: "text" },
      { label: "Pincode", shape: "text" },
      // A nationality is no national ID, and a short code counts only in capitals.
      { label: "Nationality", shape: "text" },
      { label: "Tin colour", shape: "text" },
      ...ordinaryLabels.map((label) => ({ label, shape: "text" })),
    ],
  });
});

test("unfilledRequiredFields lists a nested combobox once, refuses repeated options and leaves a long list unlisted", async ({
  page,
}) => {
  const many = Array.from({ length: 60 }, (_, index) => `<option>Font ${index + 1}</option>`).join("");
  await page.setContent(`<form>
  <div role="combobox" aria-haspopup="listbox" aria-label="Size" aria-required="true" aria-expanded="false">
    <input role="textbox" aria-label="Size" aria-required="true">
  </div>
  <div role="combobox" aria-haspopup="listbox" aria-label="Strap" aria-expanded="false">
    <input aria-label="Strap" name="strap" required>
  </div>
  <label>Colour<select name="colour" required><option value="">Choose</option><option>Red</option><option>Red</option><option>Blue</option></select></label>
  <label>Nib<select name="nib" required><option value="">Choose</option><option value="s1">Small</option><option value="s2">Small</option></select></label>
  <label>Font<select name="font" required><option value="">Choose</option>${many}</select></label>
</form>`);
  expect(await call(page, `return await unfilledRequiredFields(page.locator("form"));`)).toEqual({
    result: [
      { label: "Size", shape: "combobox" },
      // A combobox whose own text box carries the required mark.
      { label: "Strap", shape: "combobox" },
      // Two options with one label can't be told apart by an answer.
      { label: "Colour", shape: "select", unsupported: true },
      { label: "Nib", shape: "select", unsupported: true },
      // Over 50 options: asked as text, and the answer still chooses its option.
      { label: "Font", shape: "select" },
    ],
  });
  expect(await call(page, `return await fillRequiredField(page.locator("form"), "Font", "Font 42");`)).toEqual({
    result: { shape: "select" },
  });
  expect(await submitted(page)).toMatchObject({ font: "Font 42" });
  // Once its text box holds a value, the combobox is filled.
  await page.locator("[name=strap]").fill("Leather");
  expect(
    await call(page, `return (await unfilledRequiredFields(page.locator("form"))).map((field) => field.label);`),
  ).toEqual({ result: ["Size", "Colour", "Nib"] });
});

test("fillRequiredField names why it could not fill, never the value", async ({ page }) => {
  await page.setContent(`<form>
  <label>Engraving text<input name="text" required></label>
  <label>Owner<input name="first" required></label><label>Owner<input name="second" required></label>
  <label>Postcode<input name="postcode" required></label>
  <label>Copies<input type="number" name="copies" required></label>
  <label>Gift receipt<input type="checkbox" name="receipt" required></label>
</form>
<script>
  document.querySelector("[name=postcode]").addEventListener("input", (event) => { event.target.value = ""; });
</script>`);
  const form = `page.locator("form")`;
  expect(await call(page, `return await fillRequiredField(${form}, "Engraving font", "Script");`)).toEqual({
    error: "field_missing",
  });
  expect(await call(page, `return await fillRequiredField(${form}, "Owner", "Sam Roe");`)).toEqual({
    error: "field_ambiguous",
  });
  expect(await call(page, `return await fillRequiredField(${form}, "Postcode", "AB1 2CD");`)).toEqual({
    error: "not_committed",
  });
  // A number box refuses letters, and Playwright's own error would quote them.
  expect(await call(page, `return await fillRequiredField(${form}, "Copies", "SECRETVALUE");`)).toEqual({
    error: "not_committed",
  });
  expect(await call(page, `return await fillRequiredField(${form}, "Gift receipt", "yes");`)).toEqual({
    error: "field_missing",
  });
  expect(await submitted(page)).toEqual({ text: "", first: "", second: "", postcode: "", copies: "" });
});

/**
 * A review step whose Place order the site refuses until a field it shows only then is filled:
 * after the click the same form stays, with that field flagged empty. `hidden` holds the fields
 * the page shows only after the click.
 */
const blockedReview = (hidden: string, shown = "") => `
<form aria-label="Review">
  <label>Item<input name="item" required value="Fountain pen"></label>
  ${shown}
  <div id="later" hidden>${hidden}</div>
  <button>Place order</button>
</form>
<script>document.forms[0].addEventListener("submit", (event) => event.preventDefault());</script>`;

test("blockingRequiredFields proves a click saved nothing only when every flag is a new empty required field", async ({
  page,
}) => {
  const form = `page.getByRole("form", { name: "Review" })`;
  // The fields the form showed just before the click, then the page as the click left it.
  const before = () => call(page, `return await visibleFieldLabels(${form});`);
  const reveal = (flag: string) =>
    page.evaluate((selector) => {
      const later = document.querySelector("#later");
      if (later instanceof HTMLElement) later.hidden = false;
      for (const field of document.querySelectorAll(selector)) field.setAttribute("aria-invalid", "true");
    }, flag);
  const blocking = (labels: unknown) =>
    call(page, `return await blockingRequiredFields(${form}, ${JSON.stringify(labels)});`);
  // The site's script shows a field and flags it, with its message beside it.
  await page.setContent(
    blockedReview(`<label>Delivery phone<input name="phone" aria-describedby="phone-error"></label>
    <p id="phone-error">Enter a phone number for the courier</p>`),
  );
  expect(await before()).toEqual({ result: ["Item", "item"] });
  await reveal("[name=phone]");
  expect(await blocking(["Item"])).toEqual({ result: { fields: [{ label: "Delivery phone", shape: "text" }] } });
  // A framework's class, and the browser's own check after a submit, flag a new field too.
  await page.setContent(
    blockedReview(`<label>Gift wrap<select name="wrap" class="is-invalid"><option value="">Choose</option><option>Paper</option><option>Cloth</option></select></label>
    <label>Delivery note<input name="note" required></label>`),
  );
  await reveal("[name=none]");
  await page.locator("#later").evaluate(() => document.forms[0]?.requestSubmit());
  expect(await blocking(["Item"])).toEqual({
    result: {
      fields: [
        {
          label: "Gift wrap",
          shape: "select",
          options: [
            { value: "Paper", label: "Paper" },
            { value: "Cloth", label: "Cloth" },
          ],
        },
        { label: "Delivery note", shape: "text" },
      ],
    },
  });
  // A field that was on the page before the click proves nothing once flagged: an app may have
  // saved and cleared it, or the page flagged it before the click.
  await page.setContent(blockedReview("", `<label>Contact email<input name="email" aria-invalid="true"></label>`));
  expect(await before()).toEqual({ result: ["Item", "item", "Contact email", "email"] });
  expect(await blocking(["Item", "item", "Contact email", "email"])).toEqual({ result: null });
  // So is one whose label the page rewrites as it flags it, still known by its name or its id.
  await page.setContent(
    blockedReview("", `<label>Contact email<input name="email"></label><span id="ph-l">Phone</span><input id="phone" aria-labelledby="ph-l">`),
  );
  const shown = ((await before()) as { result: string[] }).result;
  expect(shown).toEqual(["Item", "item", "Contact email", "email", "Phone", "phone"]);
  await page.evaluate(() => {
    const email = document.querySelector("[name=email]");
    email?.insertAdjacentText("afterend", " Enter an email address");
    email?.setAttribute("aria-invalid", "true");
  });
  expect(await blocking(shown)).toEqual({ result: null });
  await page.evaluate(() => {
    document.querySelector("[name=email]")?.removeAttribute("aria-invalid");
    const label = document.querySelector("#ph-l");
    if (label !== null) label.textContent = "Mobile";
    document.querySelector("#phone")?.setAttribute("aria-invalid", "true");
  });
  expect(await blocking(shown)).toEqual({ result: null });
  // A new field whose label reads as the page's error message may be an old one renamed by it.
  await page.setContent(blockedReview(`<label>Please enter a phone number<input></label>`));
  await reveal("#later input");
  expect(await blocking(["Item", "item"])).toEqual({ result: null });
  await page.setContent(blockedReview(`<label>Phone number (required)<input></label>`));
  await reveal("#later input");
  expect(await blocking(["Item", "item"])).toEqual({ result: null });
  // So may one with no name or id whose label begins with a label shown before the click.
  await page.setContent(blockedReview("", `<label>Contact phone <input type="tel"></label>`));
  const unnamed = ((await before()) as { result: string[] }).result;
  expect(unnamed).toEqual(["Item", "item", "Contact phone"]);
  await page.evaluate(() => {
    const phone = document.querySelector("[type=tel]");
    phone?.insertAdjacentText("afterend", " Enter a phone number for the courier");
    phone?.setAttribute("aria-invalid", "true");
  });
  expect(await blocking(unnamed)).toEqual({ result: null });
  await page.setContent(blockedReview("", `<label>Contact phone <input type="tel"></label>`));
  await page.evaluate(() => {
    const phone = document.querySelector("[type=tel]");
    phone?.insertAdjacentText("afterend", " Required");
    phone?.setAttribute("aria-invalid", "true");
  });
  expect(await blocking(unnamed)).toEqual({ result: null });
  // So may a named one, since a page may rename a field as it flags it. A new field whose label
  // begins with an old one's is not asked either, which is safe.
  await page.setContent(blockedReview(`<label>Phone extension<input name="phone_ext"></label>`, `<label>Phone<input name="phone" value="555-0100"></label>`));
  await reveal("[name=phone_ext]");
  expect(await blocking(["Item", "item", "Phone", "phone"])).toEqual({ result: null });
  // A combobox whose own text box the page renames, its label marked.
  await page.setContent(
    blockedReview("", `<div role="combobox" aria-haspopup="listbox" aria-label="Size" aria-expanded="false"><input aria-label="Size" name="size_1" required value="M"></div>`),
  );
  const combobox = ((await before()) as { result: string[] }).result;
  expect(combobox).toEqual(["Item", "item", "Size", "size_1"]);
  await page.evaluate(() => {
    const size = document.querySelector<HTMLInputElement>("[name=size_1]");
    if (size === null) return;
    size.value = "";
    size.name = "size_2";
    size.setAttribute("aria-invalid", "true");
    document.querySelector("[role=combobox]")?.setAttribute("aria-label", "Size *");
  });
  expect(await blocking(combobox)).toEqual({ result: null });
  // A field whose name and id the page regenerates, its label marked.
  await page.setContent(
    blockedReview("", `<label for="f-1">Contact email</label><input type="email" id="f-1" name="f-1" required value="sam@example.com">`),
  );
  const regenerated = ((await before()) as { result: string[] }).result;
  expect(regenerated).toEqual(["Item", "item", "Contact email", "f-1", "f-1"]);
  await page.evaluate(() => {
    const email = document.querySelector<HTMLInputElement>("#f-1");
    const label = document.querySelector<HTMLLabelElement>("label[for=f-1]");
    if (email === null || label === null) return;
    email.value = "";
    email.id = "f-2";
    email.name = "f-2";
    label.htmlFor = "f-2";
    label.textContent = "Contact email *";
    email.setAttribute("aria-invalid", "true");
  });
  expect(await blocking(regenerated)).toEqual({ result: null });
  // A label that only begins with the same letters as one shown before is a new field.
  await page.setContent(blockedReview(`<label>Contactless note<input name="note"></label>`, `<label>Contact<input name="contact" value="Sam"></label>`));
  await reveal("[name=note]");
  expect(await blocking(["Item", "item", "Contact", "contact"])).toEqual({
    result: { fields: [{ label: "Contactless note", shape: "text" }] },
  });
  // A flagged value the site refused, beside the empty field, may be the site's answer to a save.
  await page.setContent(
    blockedReview(`<label>Delivery phone<input name="phone"></label>
    <label>Promo code<input name="promo" value="OLD10"></label>`),
  );
  await reveal("[name=phone], [name=promo]");
  expect(await blocking(["Item"])).toEqual({ result: null });
  // An empty required field the site never flagged proves nothing about the click.
  await page.setContent(blockedReview(`<label>Delivery phone<input name="phone" required></label>`));
  await reveal("[name=none]");
  expect(await blocking(["Item"])).toEqual({ result: null });
  // A flagged field no answer can go into proves nothing the tool can act on either.
  await page.setContent(blockedReview(`<label>Card number<input name="card" autocomplete="cc-number"></label>`));
  await reveal("[name=card]");
  expect(await blocking(["Item"])).toEqual({ result: null });
  // Without the labels read before the click, it refuses to judge.
  expect(await call(page, `return await blockingRequiredFields(${form});`)).toEqual({ error: "labels_missing" });
  // The form gone, or shown twice, is no longer the same step.
  await page.setContent(`<p>Order ORD-1001 is placed.</p>`);
  expect(await blocking(["Item"])).toEqual({ result: null });
  await page.setContent(`${blockedReview("", `<input aria-label="Delivery phone" aria-invalid="true">`)}${blockedReview("")}`);
  expect(await blocking(["Item"])).toEqual({ result: null });
});
