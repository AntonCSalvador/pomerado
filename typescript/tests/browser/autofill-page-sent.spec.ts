import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  checkAutofillSignedIn,
  inspectAutofillStep,
  type AutofillPage,
  type AutofillStep,
} from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { maySend } from "../../src/destinations/autofill-refusal.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

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

/**
 * The host's inspection and fill of `step` with `values`, its calls made through `wrap` when
 * given. No call's script or answer holds a value, nor a code typed one digit per box as a whole.
 */
const fill = async (
  page: Page,
  step: AutofillStep,
  values: readonly string[],
  {
    wrap = (host) => host,
    settleMs = 500,
  }: { readonly wrap?: (host: AutofillPage) => AutofillPage; readonly settleMs?: number } = {},
) => {
  const host = await hostPage(page);
  const calls = wrap(host);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: calls, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: calls,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs,
    }),
  );
  for (const value of new Set([values.join(""), ...values.filter((each) => each.length > 1)]))
    expectNotCarried(host.calls, value);
  return report;
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
      const report = await fill(page, boxesStep, [...code]);
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
  // The host's submit call waits until the site refused the code and the widget drew its boxes
  // again, empty, so the call finds them back where they were.
  const redrawnFirst = (host: AutofillPage): AutofillPage => ({
    ...host,
    execute: (script, timeout) =>
      script.includes("guardCall")
        ? Effect.promise(async () => {
            release();
            await expect(page.locator("#error")).toHaveText("Wrong code");
          }).pipe(Effect.zipRight(host.execute(script, timeout)))
        : host.execute(script, timeout),
  });
  const refused = await fill(page, boxesStep, [..."135790"], { wrap: redrawnFirst });
  expect(refused).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
  expect(maySend(refused)).toBe(true);
  for (const box of boxesStep.fields) await expect(page.locator(box.selector)).toHaveValue("");
  // The code screen is back, so a new code is filled into it as the first was.
  expect(await fill(page, boxesStep, [...code])).toMatchObject({ submit: "page" });
  expect(sent).toEqual(["135790", code]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a refused code whose widget disabled its boxes while it waited is reported sent by the page, and its boxes come back empty", async ({
  page,
}) => {
  const { sent, release } = await serve(page, widget("disables"));
  const report = await fill(page, boxesStep, [..."135790"]).finally(release);
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
  // The site answers only once the host's first submit call found the boxes as they were, so the
  // page loads the account while the host still waits on it.
  const answeredAfterFirstLook = (host: AutofillPage): AutofillPage => ({
    ...host,
    execute: (script, timeout) =>
      script.includes("guardCall")
        ? host.execute(script, timeout).pipe(Effect.tap(() => Effect.sync(release)))
        : host.execute(script, timeout),
  });
  const report = await fill(page, boxesStep, [...code], {
    wrap: answeredAfterFirstLook,
    settleMs: 5_000,
  });
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
  const report = await fill(page, boxesStep, [...code]);
  // The host gave the page its settle wait to move on before it said there was no submit.
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "none" });
  expect(maySend(report)).toBe(false);
  await expect(page.locator("#otp-6")).toHaveValue(code.slice(-1));
  expect(sent).toEqual([]);
});

/**
 * A widget with no button that moves on while one of the host's submit calls reads it, so the call
 * fails. It sends the code on its last digit, then waits for the host's next read of its first box,
 * the first box a call reads, and moves on right then. The host's test page marks each element it
 * reads with a `data-fixture-` attribute (`isolatedLocatorPage`), which the widget sees. On
 * `navigates`, 1.5 s after the last digit, the widget loads the account page. It holds its old page
 * for a moment, so the new page replaces it before the call reads on. On `redraws`, once the site
 * refused the code, it draws its boxes again, empty, under an error.
 */
type InCallMove = "navigates" | "redraws";
const inCallWidget = (move: InCallMove) => `<main id="view">${boxes}</main><p id="error"></p>
<script>
const view = document.getElementById("view");
const boxes = () => [...document.querySelectorAll(".otp")];
let moveOn = null;
new MutationObserver((records) => {
  const read = records.some((record) => record.target.id === "otp-1" && record.attributeName.startsWith("data-fixture-"));
  if (moveOn === null || !read) return;
  const move = moveOn;
  moveOn = null;
  move();
}).observe(view, { attributes: true, subtree: true });
boxes().forEach((box, index) => box.addEventListener("input", () => {
  const next = boxes()[index + 1];
  if (box.value !== "" && next) next.focus();
  const typed = boxes().map((each) => each.value).join("");
  if (!/^[0-9]{6}$/.test(typed)) return;
  const sending = fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: typed }) });
  ${
    move === "navigates"
      ? `setTimeout(() => {
    moveOn = () => {
      location.assign("/account");
      const until = Date.now() + 1000;
      while (Date.now() < until);
    };
  }, 1500);`
      : `sending.then((response) => {
    if (response.ok) return;
    moveOn = () => {
      view.innerHTML = ${JSON.stringify(boxes)};
      document.getElementById("error").textContent = "Wrong code";
    };
  });`
  }
}));
</script>`;

test("a widget with no button that loads the next page 1.5 s after its last digit, while a submit call of the host reads it, is reported sent by the page", async ({
  page,
}) => {
  const { sent, release } = await serve(page, inCallWidget("navigates"));
  release();
  const report = await fill(page, boxesStep, [...code], { settleMs: 5_000 });
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
  expect(maySend(report)).toBe(true);
  expect(report).not.toHaveProperty("clicked");
  expect(report).not.toHaveProperty("failureDetail");
  expect(sent).toEqual([code]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a refused code whose widget draws its boxes again while a submit call of the host reads them is reported sent by the page", async ({
  page,
}) => {
  const { sent, release } = await serve(page, inCallWidget("redraws"));
  release();
  const report = await fill(page, boxesStep, [..."135790"], { settleMs: 5_000 });
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
  expect(maySend(report)).toBe(true);
  expect(report).not.toHaveProperty("failureDetail");
  await expect(page.locator("#error")).toHaveText("Wrong code");
  for (const box of boxesStep.fields) await expect(page.locator(box.selector)).toHaveValue("");
  expect(sent).toEqual(["135790"]);
});

/**
 * A widget with no button that sends the code on its last digit and, once the site took it, puts
 * the account in place of its boxes while one of the host's looks reads them. A look reads the
 * boxes in order, then the box the host typed last once more; the widget takes them away at the
 * `read`-th read of its last box since the look's first read of its first box, as each read
 * starts. The host's test page marks each element it reads with a `data-fixture-` attribute
 * (`isolatedLocatorPage`), which the widget sees.
 */
const takenWhileReadWidget = (read: number) => `<main id="view">${boxes}</main>
<script>
const view = document.getElementById("view");
const boxes = () => [...document.querySelectorAll(".otp")];
let taken = false;
let lastBoxReads = null;
new MutationObserver((records) => {
  for (const record of records) {
    const starts = record.attributeName.startsWith("data-fixture-") && record.oldValue === null;
    if (!taken || !starts) continue;
    if (record.target.id === "otp-1") lastBoxReads = 0;
    else if (record.target.id === "otp-6" && lastBoxReads !== null && ++lastBoxReads === ${read}) {
      view.innerHTML = '<p id="account">Signed in</p>';
      return;
    }
  }
}).observe(view, { attributes: true, attributeOldValue: true, subtree: true });
boxes().forEach((box, index) => box.addEventListener("input", () => {
  const next = boxes()[index + 1];
  if (box.value !== "" && next) next.focus();
  const typed = boxes().map((each) => each.value).join("");
  if (!/^[0-9]{6}$/.test(typed)) return;
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: typed }) })
    .then((response) => { taken = response.ok; });
}));
</script>`;

for (const read of [1, 2, 3])
  test(`a widget with no button that takes its boxes away at read ${read} of its last box by a submit call of the host is reported sent by the page`, async ({
    page,
  }) => {
    const { sent, release } = await serve(page, takenWhileReadWidget(read));
    release();
    const report = await fill(page, boxesStep, [...code], { settleMs: 5_000 });
    expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "page" });
    expect(maySend(report)).toBe(true);
    expect(report).not.toHaveProperty("failureDetail");
    expect(sent).toEqual([code]);
    await expect(page.locator("#account")).toBeVisible();
  });

/**
 * A code screen of one box and no button that sends the code once the box holds six digits, then
 * puts the account in place of the box as the third read of it after that starts. A look of the
 * host reads the box twice as it finds it, then once more to check it holds what was typed. A step
 * of one field has no emptiness read, so that check alone decides whether the look reads the box
 * as empty.
 */
const oneBoxTakenAtCheck = `<main id="view"><input id="otp" name="otp" maxlength="6" inputmode="numeric" aria-label="Code" autocomplete="one-time-code"></main>
<script>
const view = document.getElementById("view");
const box = document.getElementById("otp");
let reads = null;
new MutationObserver((records) => {
  for (const record of records) {
    const starts = record.attributeName.startsWith("data-fixture-") && record.oldValue === null;
    if (reads === null || !starts || record.target !== box || ++reads !== 3) continue;
    view.innerHTML = '<p id="account">Signed in</p>';
    return;
  }
}).observe(view, { attributes: true, attributeOldValue: true, subtree: true });
box.addEventListener("input", () => {
  if (reads !== null || !/^[0-9]{6}$/.test(box.value)) return;
  reads = 0;
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: box.value }) });
});
</script>`;

test("a one-box code screen with no button that takes its box away as a submit call of the host checks it is reported sent by the page", async ({
  page,
}) => {
  const { sent, release } = await serve(page, oneBoxTakenAtCheck);
  release();
  const oneBoxStep: AutofillStep = { fields: [{ selector: "#otp", slot: "code" }] };
  const report = await fill(page, oneBoxStep, [code], { settleMs: 5_000 });
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "page",
  });
  expect(maySend(report)).toBe(true);
  expect(report).not.toHaveProperty("failureDetail");
  expect(sent).toEqual([code]);
  await expect(page.locator("#account")).toBeVisible();
});

/** The host's calls, its first submit call failing as a call that never reached the page does. */
const firstSubmitFails =
  (submits: { count: number }) =>
  (host: AutofillPage): AutofillPage => ({
    ...host,
    execute: (script, timeout) => {
      if (!script.includes("guardCall")) return host.execute(script, timeout);
      submits.count++;
      return submits.count === 1
        ? Effect.fail(new Error("Browser call failed"))
        : host.execute(script, timeout);
    },
  });

test("a widget with no button whose submit call fails while the page stays as it was reports the failed call", async ({
  page,
}) => {
  const { sent } = await serve(page, widget("stays"));
  const submits = { count: 0 };
  const report = await fill(page, boxesStep, [...code], { wrap: firstSubmitFails(submits) });
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed", typed: true });
  // The host looked again and found the page as it was, so the failed call stands.
  expect(submits.count).toBeGreaterThan(1);
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
  const report = await fill(page, formStep, [...code]);
  expect(report).toMatchObject({ outcome: "filled", fields: filledBoxes, submit: "clicked" });
  expect(posted.map((received) => [1, 2, 3, 4, 5, 6].map((box) => received.get(`d${box}`)).join(""))).toEqual([code]);
  expect(sent).toEqual([]);
});

test("code boxes in a form with a button whose submit call fails report the failed call after that one call", async ({
  page,
}) => {
  const { sent, posted } = await serve(page, form());
  const submits = { count: 0 };
  const report = await fill(page, formStep, [...code], { wrap: firstSubmitFails(submits) });
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed", typed: true });
  expect(submits.count).toBe(1);
  expect(posted).toEqual([]);
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
    const report = await fill(page, formStep, [...code]);
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

// A step with a submit is the host's to click, whatever its page does while it checks what was
// typed: a form that locks every control for a moment, puts a new path in the address or draws
// itself again has sent nothing, so none of that is the page sending it.
const username = "synthetic-user";
const password = "synthetic-pass-1";
const loginStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const login = (onPassword: string) =>
  `<form action="/session" method="post"><label>Username<input id="username" name="username" autocomplete="username"></label><label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label><button id="sign-in">Sign in</button></form><script>
const form = document.forms[0];
document.getElementById("password").addEventListener("input", () => { ${onPassword} }, { once: true });
</script>`;

for (const [name, onPassword] of [
  [
    // Long enough to outlast the host's first two submit calls on a busy machine, and within the
    // 5 s it waits for a disabled submit.
    "locks every field and its button for 3 s while it checks the password",
    "const controls = [...form.elements]; controls.forEach((control) => { control.disabled = true; }); setTimeout(() => controls.forEach((control) => { control.disabled = false; }), 3000);",
  ],
  ["puts a new path in the address as the password is typed", 'history.pushState(null, "", "/verify/checked");'],
] as const)
  test(`a sign-in form with a button that ${name} is clicked once`, async ({ page }) => {
    const { posted } = await serve(page, login(onPassword));
    const report = await fill(page, loginStep, [username, password]);
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [
        { slot: "username", status: "filled" },
        { slot: "password", status: "filled" },
      ],
      submit: "clicked",
    });
    expect(posted.map((received) => Object.fromEntries(received))).toEqual([{ username, password }]);
  });

test("a sign-in form with a button that draws itself again, empty, once the password is typed is never clicked nor taken as sent by the page", async ({
  page,
}) => {
  const { posted } = await serve(page, login("form.innerHTML = form.innerHTML;"));
  const report = await fill(page, loginStep, [username, password]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "failed" },
    ],
    submit: "not_attempted",
  });
  expect(maySend(report)).toBe(false);
  expect(posted).toEqual([]);
});

/**
 * A code screen of one field and a "Continue" button whose own script submits its form once the
 * field holds six digits, so the page leaves for the site's answer before the host clicks. `leaves`
 * names what the page does then: `submits` loads the answer as a new document; `pushes` puts a new
 * path in the address with pushState and draws a "Verifying" line in place of the form, and
 * `redraws` only draws that line, so neither loads a new document or sends anything.
 */
type Leaves = "submits" | "pushes" | "redraws";
const leaving: Record<Leaves, string> = {
  submits: "form.submit();",
  pushes: `history.pushState(null, "", "/verify/sent"); form.replaceWith(Object.assign(document.createElement("p"), { id: "verifying", textContent: "Verifying" }));`,
  redraws: `form.replaceWith(Object.assign(document.createElement("p"), { id: "verifying", textContent: "Verifying" }));`,
};
const selfSubmitting = (leaves: Leaves) =>
  `<form id="code-form" action="/verify/code" method="post"><label>Code<input id="code" name="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code"></label><button id="continue">Continue</button></form><script>
const form = document.getElementById("code-form");
document.getElementById("code").addEventListener("input", (event) => {
  if (/^[0-9]{6}$/.test(event.target.value)) { ${leaving[leaves]} }
});
</script>`;
const continueStep: AutofillStep = { fields: [{ selector: "#code", slot: "code" }], submit: "#continue" };

/** The host's calls, its submit call made only once the page shows `shown`. */
const submitOnceShown =
  (page: Page, shown: string) =>
  (host: AutofillPage): AutofillPage => ({
    ...host,
    execute: (script, timeout) =>
      script.includes("guardCall")
        ? Effect.promise(() => expect(page.locator(shown)).toBeVisible()).pipe(
            Effect.zipRight(host.execute(script, timeout)),
          )
        : host.execute(script, timeout),
  });

test("a code screen with a button whose form submits itself on its last input is reported sent by the page, never clicked, and signs in", async ({
  page,
}) => {
  const { sent, posted } = await serve(page, selfSubmitting("submits"));
  const report = await fill(page, continueStep, [code], { wrap: submitOnceShown(page, "#account") });
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "page",
  });
  expect(maySend(report)).toBe(true);
  expect(report).not.toHaveProperty("clicked");
  expect(report).not.toHaveProperty("failureDetail");
  expect(posted.map((received) => received.get("code"))).toEqual([code]);
  expect(sent).toEqual([]);
  const signedIn = await Effect.runPromise(
    checkAutofillSignedIn({
      indicator: { selector: "#account" },
      page: await hostPage(page),
      siteOrigin: site,
      screens: [continueStep],
    }),
  );
  expect(signedIn).toMatchObject({ signedIn: true });
});

for (const leaves of ["pushes", "redraws"] as const)
  test(`a code screen with a button whose script ${leaves === "pushes" ? "puts a new path in the address and takes" : "takes"} its form away on its last input, with no new document, is refused`, async ({
    page,
  }) => {
    const { sent, posted } = await serve(page, selfSubmitting(leaves));
    const report = await fill(page, continueStep, [code], {
      wrap: submitOnceShown(page, "#verifying"),
    });
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [{ slot: "code", status: "filled" }],
      submit: "refused",
    });
    expect(maySend(report)).toBe(false);
    expect(posted).toEqual([]);
    expect(sent).toEqual([]);
  });
