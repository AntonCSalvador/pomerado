import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  inspectAutofillStep,
  type AutofillPage,
  type AutofillStep,
} from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { maySend } from "../../src/destinations/autofill-refusal.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A code widget that sends itself when its last box is filled: six one-character boxes, often with
// no form and no button, whose own script sends the code as soon as every box holds a digit, then
// moves on. The host never clicks anything there, so the page's own move is what says the code may
// have gone out. Chromium must generate the input events the widget's script listens for.
const site = "https://login.example.test";
const code = "246810";
// Six boxes take six focus calls and six insertions each fill, more than the default 30 s allows on
// a busy machine.
test.describe.configure({ timeout: 90_000 });

const boxes = [1, 2, 3, 4, 5, 6]
  .map(
    (box) =>
      `<input id="otp-${box}" name="d${box}" class="otp" maxlength="1" inputmode="numeric" aria-label="Digit ${box}"${box === 1 ? ' autocomplete="one-time-code"' : ""}>`,
  )
  .join("");

const boxesStep: AutofillStep = {
  fields: [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })),
};

/**
 * What the widget does once every box holds a digit, before the site answers: `removes` puts a
 * "Verifying" line in place of the boxes, `disables` disables them, `moves` puts a new path in the
 * address and leaves the boxes as they are, `waits` leaves everything as it is until the site
 * answers, and `stays` sends nothing and leaves everything as it is. An accepted code shows the
 * account, which `waits` loads as a page of its own; a refused one draws the boxes again, empty,
 * under an error.
 */
type Move = "removes" | "disables" | "moves" | "waits" | "stays";
const moves: Record<Move, string> = {
  removes: `view.replaceChildren(Object.assign(document.createElement("p"), { id: "verifying", textContent: "Verifying" }));`,
  disables: `boxes().forEach((box) => { box.disabled = true; });`,
  moves: `history.pushState(null, "", "/verify/sent");`,
  waits: "",
  stays: "return;",
};
const widget = (move: Move) => `<main id="view">${boxes}</main><p id="error"></p>
<script>
const view = document.getElementById("view");
const boxes = () => [...document.querySelectorAll(".otp")];
let sending = false;
const listen = () => boxes().forEach((box, index) => box.addEventListener("input", () => {
  const next = boxes()[index + 1];
  if (box.value !== "" && next) next.focus();
  const typed = boxes().map((each) => each.value).join("");
  if (sending || !/^[0-9]{6}$/.test(typed)) return;
  sending = true;
  ${moves[move]}
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: typed }) })
    .then((response) => {
      if (response.ok) {
        if (${JSON.stringify(move === "waits")}) location.assign("/account");
        else view.innerHTML = '<p id="account">Signed in</p>';
        return;
      }
      sending = false;
      view.innerHTML = ${JSON.stringify(boxes)};
      document.getElementById("error").textContent = "Wrong code";
      listen();
      boxes()[0].focus();
    });
}));
listen();
</script>`;

/**
 * Serves `screen` at /verify and keeps each code the widget sends. The site answers a code only
 * once the test releases it, accepting `code` alone, so the test decides whether the host looks
 * before or after the widget hears back.
 */
const serve = async (page: Page, screen: string) => {
  const sent: string[] = [];
  const posted: URLSearchParams[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/code") {
      const body: unknown = JSON.parse(request.postData() ?? "{}");
      const typed: unknown = Reflect.get(Object(body), "code");
      sent.push(typeof typed === "string" ? typed : "");
      await released;
      await route.fulfill({
        status: typed === code ? 200 : 400,
        contentType: "application/json",
        body: "{}",
      });
    } else if (request.method() === "POST") {
      posted.push(new URLSearchParams(request.postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: '<p id="account">Signed in</p>' });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: path === "/account" ? '<p id="account">Signed in</p>' : screen,
      });
  });
  await page.goto(`${site}/verify`);
  return { sent, posted, release };
};

/** The host's inspection and fill of `step` with one digit of `typed` in each box. */
const fill = async (
  page: Page,
  step: AutofillStep,
  typed: string,
  { host, settleMs = 500 }: { readonly host?: AutofillPage; readonly settleMs?: number } = {},
) => {
  const calls = host ?? (await hostPage(page));
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: calls, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  return Effect.runPromise(
    fillAutofillStep({
      step,
      values: Array.from(typed),
      inspection,
      page: calls,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs,
    }),
  );
};

const filledBoxes = boxesStep.fields.map(() => ({ slot: "code", status: "filled" }));

for (const [move, shown] of [
  ["removes", "#verifying"],
  ["disables", "#otp-6:disabled"],
  ["moves", "#otp-6"],
] as const)
  test(`a code widget that ${move === "moves" ? "changes the address" : `${move} its boxes`} as it sends itself is reported sent by the page`, async ({
    page,
  }) => {
    const { sent, release } = await serve(page, widget(move));
    try {
      const report = await fill(page, boxesStep, code);
      expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
      expect(maySend(report)).toBe(true);
      expect(report).not.toHaveProperty("clicked");
      expect(report).not.toHaveProperty("failureDetail");
      expect(JSON.stringify(report)).not.toContain(code);
      await expect(page.locator(shown)).toHaveCount(1);
      expect(sent).toEqual([code]);
    } finally {
      release();
    }
    await expect(page.locator("#account")).toBeVisible();
  });

test("a refused code whose widget draws its boxes again before the host looks is reported sent by the page, and the next code goes out the same way", async ({
  page,
}) => {
  const { sent, release } = await serve(page, widget("removes"));
  const host = await hostPage(page);
  // The host's submit call waits until the site refused the code and the widget drew its boxes
  // again, empty, so the call finds them back where they were.
  const redrawnFirst: AutofillPage = {
    ...host,
    execute: (script, timeout) =>
      script.includes("guardCall")
        ? Effect.promise(async () => {
            release();
            await expect(page.locator("#error")).toHaveText("Wrong code");
          }).pipe(Effect.zipRight(host.execute(script, timeout)))
        : host.execute(script, timeout),
  };
  const refused = await fill(page, boxesStep, "135790", { host: redrawnFirst });
  expect(refused).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
  expect(maySend(refused)).toBe(true);
  for (const box of boxesStep.fields) await expect(page.locator(box.selector)).toHaveValue("");
  // The code screen is back, so a new code is filled into it as the first was.
  expect(await fill(page, boxesStep, code)).toMatchObject({ submit: "page" });
  expect(sent).toEqual(["135790", code]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a refused code whose widget disabled its boxes while it waited is reported sent by the page, and its boxes come back empty", async ({
  page,
}) => {
  const { sent, release } = await serve(page, widget("disables"));
  const report = await fill(page, boxesStep, "135790").finally(release);
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
  await expect(page.locator("#error")).toHaveText("Wrong code");
  for (const box of boxesStep.fields) {
    await expect(page.locator(box.selector)).toHaveValue("");
    await expect(page.locator(box.selector)).toBeEnabled();
  }
  expect(sent).toEqual(["135790"]);
});

test("a widget with no button that moves on only once the site answers, after the host first looked, is reported sent by the page", async ({
  page,
}) => {
  const { sent, release } = await serve(page, widget("waits"));
  const host = await hostPage(page);
  // The site answers only once the host's first submit call found the boxes as they were, so the
  // page loads the account while the host still waits on it.
  const answeredAfterFirstLook: AutofillPage = {
    ...host,
    execute: (script, timeout) =>
      script.includes("guardCall")
        ? host.execute(script, timeout).pipe(Effect.tap(() => Effect.sync(release)))
        : host.execute(script, timeout),
  };
  const report = await fill(page, boxesStep, code, { host: answeredAfterFirstLook, settleMs: 5_000 });
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
  expect(maySend(report)).toBe(true);
  expect(sent).toEqual([code]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a widget with no button that sends nothing is filled with no submit once the host's wait ends", async ({
  page,
}) => {
  const { sent } = await serve(page, widget("stays"));
  const started = Date.now();
  const report = await fill(page, boxesStep, code);
  // The host gave the page its settle wait to move on before it said there was no submit.
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "none" });
  expect(maySend(report)).toBe(false);
  await expect(page.locator("#otp-6")).toHaveValue(code.slice(-1));
  expect(sent).toEqual([]);
});

const formStep: AutofillStep = { ...boxesStep, submit: "#verify" };
const form = (script = "") =>
  `<form action="/verify" method="post">${boxes}<button id="verify">Verify</button></form><script>
const boxes = [...document.querySelectorAll(".otp")];
boxes.forEach((box, index) => box.addEventListener("input", () => {
  if (box.value !== "" && boxes[index + 1]) boxes[index + 1].focus();
  if (boxes.every((each) => each.value !== "")) { ${script} }
}));
</script>`;

test("code boxes in a form with a button are filled and the host clicks it", async ({ page }) => {
  const { sent, posted } = await serve(page, form());
  const report = await fill(page, formStep, code);
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "clicked" });
  expect(posted.map((received) => [1, 2, 3, 4, 5, 6].map((box) => received.get(`d${box}`)).join(""))).toEqual([code]);
  expect(sent).toEqual([]);
});

// Guardian's own refusals stay refusals: a page whose last box moves the form off the site is
// refused, even when it also locks the boxes as a widget that sent the code would.
for (const [name, script] of [
  ["moves its form off the site", "boxes[0].form.action = 'https://other.test/receive';"],
  [
    "moves its form off the site and disables its boxes",
    "boxes[0].form.action = 'https://other.test/receive'; boxes.forEach((box) => { box.disabled = true; });",
  ],
] as const)
  test(`code boxes whose last digit ${name} are refused, and the form never goes out`, async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const { posted } = await serve(page, form(script));
    const report = await fill(page, formStep, code);
    expect(report).toMatchObject({
      outcome: "filled",
      fields: filledBoxes,
      submit: "refused",
      failureDetail: { phase: "destination" },
    });
    expect(maySend(report)).toBe(false);
    expect(posted).toEqual([]);
    expect(requested.filter((url) => new URL(url).origin !== site)).toEqual([]);
  });
