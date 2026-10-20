import { Schema } from "effect";
import { defineOperation, sameText, timeoutDefaults } from "../../src/browser/index.js";
import type { KernelOperationContext } from "../../src/browser/index.js";

// Observed contract: /checkout fills item, quantity and a gift-wrap add-on the page offers
// unchecked, Continue opens a review step showing the item and the order total, some accounts
// get a membership offer over the review, and Place order shows "Order ORD-…" on its
// confirmation page. Adapt every selector and condition from your own session's evidence.
// Every on-path option is an input: the add-on is the caller's choice, never kept or cleared
// unasked. An account-specific value (a passenger, saved card or address) would be a free-form
// input, never an enum member, example or default.
export const OrderInput = Schema.Struct({
  item: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({ description: "Item to order, as the site names it" }),
  quantity: Schema.Int.pipe(Schema.between(1, 99)).annotations({
    description: "How many to order, 1 to 99",
  }),
  gift_wrap: Schema.Boolean.annotations({ description: "Whether to add gift wrap" }),
  // Only when the request sets a limit; without one the tool places the order at any total.
  max_total_minor: Schema.optional(
    Schema.Int.pipe(Schema.positive()).annotations({
      description: "Highest order total to accept, in minor units of the site's currency",
    }),
  ),
});
type OrderInput = typeof OrderInput.Type;
const Placed = Schema.Struct({
  order_number: Schema.NonEmptyTrimmedString.annotations({
    description: "Order number from the confirmation",
  }),
});
const Filled = Schema.Union(
  Schema.Struct({ review_shown: Schema.Literal(true) }),
  Schema.Struct({ failure: Schema.Literal("checkout_changed") }),
);
const Review = Schema.Union(
  Schema.Struct({ item: Schema.String, total_minor: Schema.Int }),
  Schema.Struct({ failure: Schema.Literal("review_missing") }),
);
const Confirmed = Schema.Union(
  Schema.Struct({ order_number: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ failure: Schema.Literal("review_missing", "total_changed", "not_confirmed") }),
);
type Context = KernelOperationContext<OrderInput>;

// The act steps and the composed script share these calls, so the published script repeats
// exactly what the session did.

// The membership offer shows only to some accounts, so it is conditional: decline it when it
// shows and go on when it does not. It is outside this tool's purpose, so declining needs no
// input, and the tool never accepts it. Both calls before the commit mark check for it, so an
// offer that opens late is declined too.
const declineOffer = `
  const offer = page.getByRole("dialog", { name: "Membership offer", exact: true });
  if (await offer.isVisible()) {
    await offer.getByRole("button", { name: "No thanks", exact: true }).click({ timeout: 5000 });
    await offer.waitFor({ state: "hidden", timeout: 5000 });
  }
`;

/** From the site origin page: open the checkout, fill it from the input and stop at the review step. */
const fillCheckout = async ({ kernel, sessionId, siteOrigin, input, errors }: Context) => {
  if (siteOrigin === undefined)
    throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      const checkout = ${JSON.stringify(new URL("/checkout", siteOrigin).href)};
      const input = ${JSON.stringify(input)};
      await page.goto(checkout, { waitUntil: "domcontentloaded", timeout: ${timeoutDefaults.navigation} });
      const form = page.getByRole("form", { name: "Checkout", exact: true });
      if ((await form.count()) !== 1) return { failure: "checkout_changed" };
      await form.getByLabel("Item", { exact: true }).fill(input.item, { timeout: 5000 });
      await form.getByLabel("Quantity", { exact: true }).fill(String(input.quantity), { timeout: 5000 });
      await form.getByLabel("Gift wrap", { exact: true }).setChecked(input.gift_wrap, { timeout: 5000 });
      await form.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 5000 });
      const place = page.getByRole("button", { name: "Place order", exact: true });
      await place.or(page.getByRole("dialog", { name: "Membership offer", exact: true })).first().waitFor({ timeout: 10000 });
      ${declineOffer}
      await place.waitFor({ timeout: 10000 });
      return { review_shown: true };
    `,
  });
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  const filled = Schema.decodeUnknownSync(Filled)(answer.result);
  // Filling sends nothing the site keeps: a changed form fails before any commit. That holds
  // only because this site's Continue was seen to open a review step without saving. A
  // Continue, Next or payment button whose next screen you have not seen may save or place
  // the order, so mark it with enteringCommit before the call, as placeAndConfirm does.
  if ("failure" in filled)
    throw new errors.OperationFailure(filled.failure, { dispatch: "not_sent" });
};

// The review's total in minor units, read the same way before the commit mark and inside it.
// This site shows a two-decimal total with a "." separator, such as "$37.50"; parse the format
// your site shows.
const readTotal = `
  const totalText = await page.getByLabel("Order total", { exact: true }).innerText({ timeout: 5000 });
  const total_minor = Math.round(Number(totalText.replace(/[^0-9.]/g, "")) * 100);
`;

/**
 * Every check that can refuse runs here, before the commit mark: the review shows the item asked
 * for, and its total is within the caller's limit. Nothing here changes the site.
 */
export const checkReview = async ({ kernel, sessionId, input, errors }: Context) => {
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 30,
    code: `
      ${declineOffer}
      if ((await page.getByRole("button", { name: "Place order", exact: true }).count()) !== 1)
        return { failure: "review_missing" };
      ${readTotal}
      const item = await page.getByLabel("Item", { exact: true }).innerText({ timeout: 5000 });
      return { item, total_minor };
    `,
  });
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  const review = Schema.decodeUnknownSync(Review)(answer.result);
  if ("failure" in review)
    throw new errors.OperationFailure(review.failure, { dispatch: "not_sent" });
  // The tool filled the item itself, so another one on the review is a page that changed: a
  // failure, never the caller's input.
  if (!sameText(review.item, input.item))
    throw new errors.OperationFailure("review_item_mismatch", { dispatch: "not_sent" });
  // Over the caller's own limit is a refusal: InvalidInput naming the input, a stable kind and
  // both values, thrown before the mark so the run reports that it changed nothing.
  if (input.max_total_minor !== undefined && review.total_minor > input.max_total_minor)
    throw new errors.InvalidInput(
      `The order total is ${review.total_minor}, over max_total_minor ${input.max_total_minor}`,
      { field: "max_total_minor", kind: "over_price_limit" },
    );
  return review.total_minor;
};

/** The one commit, then the confirmation the site shows for it. Never clicked twice. */
export const placeAndConfirm = async (
  { kernel, sessionId, errors, verified, enteringCommit }: Context,
  checkedTotal: number,
) => {
  // The call below can send the order, so its commit step is marked first. It only guards
  // against a total that moved since checkReview, clicks once and confirms.
  enteringCommit("place-order");
  // One call clicks and reads: a confirmation already on the page cannot stand in for this one.
  const answer = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      const place = page.getByRole("button", { name: "Place order", exact: true });
      if ((await place.count()) !== 1) return { failure: "review_missing" };
      ${readTotal}
      if (total_minor !== ${JSON.stringify(checkedTotal)}) return { failure: "total_changed" };
      await place.click({ timeout: 5000 });
      const confirmation = page.getByRole("status", { name: "Order confirmation", exact: true });
      try { await confirmation.waitFor({ timeout: 15000 }); } catch { return { failure: "not_confirmed" }; }
      const number = /^Order (ORD-[0-9]+)/.exec(await confirmation.innerText())?.[1];
      return number === undefined ? { failure: "not_confirmed" } : { order_number: number };
    `,
  });
  // A failure after the click leaves the write uncertain. Nothing here resubmits it.
  if (!answer.success)
    throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
  const result = Schema.decodeUnknownSync(Confirmed)(answer.result);
  if ("failure" in result)
    throw new errors.OperationFailure(result.failure, {
      dispatch: result.failure === "not_confirmed" ? "sent" : "not_sent",
    });
  // The site's own confirmation for this submission, read back: the write landed.
  verified();
  return result;
};

/** Act step 1: fills the checkout on the site origin page and stops before the commit. */
export const fillStep = defineOperation(
  {
    name: "fill_checkout",
    input: OrderInput,
    output: Schema.Struct({
      review_shown: Schema.Boolean.annotations({ description: "True once the review step shows" }),
    }),
  },
  async (context) => {
    await fillCheckout(context);
    return { review_shown: true };
  },
);

/** Act step 2: continues on the page step 1 left, checks it, commits once and confirms. */
export const placeStep = defineOperation(
  { name: "place_order", input: OrderInput, output: Placed },
  async (context) => placeAndConfirm(context, await checkReview(context)),
);

/** The composed script, published without another run: the whole flow from the site origin page. */
export default defineOperation(
  {
    name: "place_order",
    input: OrderInput,
    output: Placed,
    write: { confirmation: "readback", commits: ["place-order"] },
  },
  async (context) => {
    await fillCheckout(context);
    return placeAndConfirm(context, await checkReview(context));
  },
);
