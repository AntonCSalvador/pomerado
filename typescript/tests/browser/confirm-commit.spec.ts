import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// `confirmCommit` judges a write's final commit from the `{ response }` answer of the click's
// `waitForOutcomeResult` and the page, as a Kernel call body runs it (`page` in scope). Each case
// is a synthetic record form whose Save posts to the site and then draws what the site drew. The
// page must render: visibility and the field marks are what the page check reads.
const origin = "https://records.example.test";

interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

interface Case {
  readonly name: string;
  readonly reply: Reply;
  /** Page script run once the commit request answered, with `reply` the fetch Response. */
  readonly after?: string;
  readonly expected: Record<string, unknown>;
}

const page = (after: string, click?: string) => `
  <form id="record" aria-label="Edit record" novalidate>
    <label for="email">Email</label>
    <input id="email" name="email" value="a@example.test" aria-describedby="email-help">
    <span id="email-help"></span>
    <button type="button" id="save">Save</button>
  </form>
  <div id="messages"></div>
  <script>
    const say = (html) => document.querySelector("#messages").insertAdjacentHTML("beforeend", html);
    document.querySelector("#save").onclick = async () => {
      ${click ?? `const reply = await fetch("/api/records", { method: "POST", body: JSON.stringify({ email: "a@example.test" }) });
      ${after}`}
    };
  </script>`;

/**
 * Serves the form at `/`, answers the commit with `reply`, and returns the outcome that won and
 * what `confirmCommit` said. `click` replaces Save's whole handler.
 */
const confirm = async (browserPage: Page, reply: Reply, after = "", click?: string) => {
  await browserPage.context().route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ status: 200, contentType: "text/html", body: page(after, click) });
    return route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: reply.body ?? "",
      ...(reply.headers === undefined ? {} : { headers: reply.headers }),
    });
  });
  await browserPage.goto(`${origin}/`);
  const answer = await makeLocalKernel(browserPage).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${waitCode}
      const form = page.getByRole("form", { name: "Edit record" });
      const answer = await waitForOutcomeResult({
        invalid: { invalid: form },
        saved: { response: { method: "POST", url: "/api/records" } },
      }, { action: () => page.locator("#save").click(), noProgressMs: 600, timeout: 4000, unchangedMs: 300 });
      return { outcome: answer.outcome, confirmed: await confirmCommit(answer, page) };`,
  });
  if (!answer.success) throw new Error(String(answer.error));
  return answer.result as { outcome: string; confirmed: Record<string, unknown> };
};

const json = (value: unknown) => JSON.stringify(value);

const cases: readonly Case[] = [
  {
    name: "a 200 whose body reports success true is done",
    reply: { status: 200, body: json({ success: true, id: "r-7" }) },
    expected: { state: "done", status: "completed" },
  },
  {
    name: "a 200 whose body reports success false is not done",
    reply: { status: 200, body: json({ success: false }) },
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "a 200 whose body reports success as an error word is not done",
    reply: { status: 200, body: json({ success: "error" }) },
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "a 202 whose body says the work is queued is done, with the site's word",
    reply: { status: 202, body: json({ status: "Queued" }) },
    expected: { state: "done", status: "queued", statusLabel: "Queued" },
  },
  {
    name: "a 200 whose body lists errors is not done",
    reply: { status: 200, body: json({ data: null, errors: [{ message: "Email is already in use" }] }) },
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "a 422 is not done",
    reply: { status: 422, body: json({ message: "Email is not valid" }) },
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "a 200 followed by the page marking a field invalid is not done",
    reply: { status: 200, body: json({ success: true }) },
    // Drawn a moment after the response wins the wait, as a page that renders its answer late.
    after: `setTimeout(() => {
        document.querySelector("#email").setAttribute("aria-invalid", "true");
        document.querySelector("#email-help").textContent = "Enter a valid email";
      }, 200);`,
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "a page alert whose text equals the body's message is still not done",
    reply: { status: 200, body: json({ success: true, message: "The start date must be after today." }) },
    after: `const body = await reply.json();
      say('<div role="alert" class="alert alert-danger">' + body.message + '</div>');`,
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "a 200 followed by a message styled as an error is not done",
    reply: { status: 200, body: json({ id: "r-7" }) },
    after: `say('<span class="field-validation-error">Start date is required</span>');`,
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "a body that wraps its JSON in a string still reports its failure",
    reply: { status: 200, body: json({ d: json({ Success: false, Message: "Rate unavailable" }) }) },
    expected: { state: "not_done", status: "failed" },
  },
  {
    name: "an announcement only a screen reader hears leaves the commit done",
    reply: { status: 200, body: json({ Success: "True" }) },
    after: `say('<p role="alert" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Record r-7</p>');`,
    expected: { state: "done", status: "completed" },
  },
  {
    name: "a 201 whose Location names the new record is done at once",
    reply: { status: 201, body: "", headers: { location: "/records/r-7" } },
    expected: { state: "done", status: "completed" },
  },
  {
    name: "a success toast drawn with the alert role leaves the commit done",
    reply: { status: 200, body: json({ success: true, message: "Record saved with no errors" }) },
    after: `say('<div role="alert" class="alert alert-success">Record saved</div>');`,
    expected: { state: "done", status: "completed" },
  },
  {
    name: "a success value the body leaves ambiguous is unclear",
    reply: { status: 200, body: json({ success: "maybe" }) },
    expected: { state: "unclear", status: "unconfirmed" },
  },
  {
    name: "an alert with neither error nor success styling or words is unclear",
    reply: { status: 200, body: json({ success: true }) },
    after: `say('<div role="alert">Your changes were sent to the reviewer.</div>');`,
    expected: { state: "unclear", status: "unconfirmed" },
  },
];

test.describe("confirmCommit", () => {
  for (const each of cases)
    test(each.name, async ({ page: browserPage }) => {
      const { outcome, confirmed } = await confirm(browserPage, each.reply, each.after);
      expect(outcome).toBe("saved");
      expect(confirmed).toMatchObject(each.expected);
      expect(confirmed["reason"]).toEqual(expect.any(String));
      if (each.expected["statusLabel"] === undefined) expect(confirmed).not.toHaveProperty("statusLabel");
    });

  test("a form post answered with a redirect to the saved record is done", async ({ page: browserPage }) => {
    await browserPage.context().route(`${origin}/**`, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST")
        return route.fulfill({ status: 302, headers: { location: "/records/r-7" }, body: "" });
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body:
          path === "/records/r-7"
            ? "<h1>Record r-7</h1>"
            : `<form method="post" action="/records" aria-label="Edit record">
                 <label for="email">Email</label><input id="email" name="email" value="a@example.test">
                 <button id="save">Save</button>
               </form>`,
      });
    });
    await browserPage.goto(`${origin}/`);
    const answer = await makeLocalKernel(browserPage).browsers.playwright.execute("session-1", {
      timeout_sec: 10,
      code: `${waitCode}
        const answer = await waitForOutcomeResult({
          saved: { response: { method: "POST", url: "/records" } },
        }, { action: () => page.locator("#save").click({ noWaitAfter: true }), noProgressMs: 600, timeout: 4000 });
        return await confirmCommit(answer, page);`,
    });
    if (!answer.success) throw new Error(String(answer.error));
    expect(answer.result).toMatchObject({ state: "done", status: "completed" });
  });

  test("an answer with no commit response, where the form marked a field invalid, is not done", async ({
    page: browserPage,
  }) => {
    const { outcome, confirmed } = await confirm(
      browserPage,
      { status: 200, body: json({ success: true }) },
      "",
      `document.querySelector("#email").setAttribute("aria-invalid", "true");
      document.querySelector("#email-help").textContent = "Enter a valid email";`,
    );
    expect(outcome).toBe("invalid");
    expect(confirmed).toMatchObject({ state: "not_done", status: "failed" });
  });
});
