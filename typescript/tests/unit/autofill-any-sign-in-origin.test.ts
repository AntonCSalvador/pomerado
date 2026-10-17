import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import {
  inspectAutofillStep,
  untrustedTarget,
  type AutofillInspection,
  type AutofillStep,
  type FillSlot,
} from "../../src/destinations/autofill-step.js";
import { paymentFrameOrigins } from "../../src/destinations/payment-frames.js";

// A host may trust any sign-in origin for a sign-in (`trustAnySignInOrigin`): a sign-in field
// then goes into a control on any https host with a registrable domain. Unset, only the site and
// its configured sign-in origins count, as before. Card fields, plain http, IP addresses, hosts
// with no registrable domain and addresses that carry credentials stay refused either way, and a
// refusal still names an unjudged origin `other` once anything was typed.

const site = "https://www.shop.example";
const signInHost = "https://login.example.net";
const otherHost = "https://auth.example.org";

const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};

/** A control as the page reports it before typing: in a frame on `frameUrl`. */
const target = (frameUrl: string, actions: readonly string[] = []) => ({
  ownerUrl: frameUrl,
  documentOrigin: URL.parse(frameUrl)?.origin ?? frameUrl,
  actions: [...actions],
  methods: actions.map(() => "post"),
  editable: true,
  control: "text" as const,
});

const described = (name: string) => ({
  tag: "INPUT",
  role: null,
  formMethod: "post",
  type: name === "password" ? "password" : "text",
  name,
  id: name,
  autocomplete: null,
  inputmode: null,
  label: name,
  placeholder: null,
  ariaLabel: null,
  text: null,
});

/** A primary tab whose inspection finds `step`'s fields, and its submit, in a frame on `frameUrl`. */
const pageWith = (
  step: AutofillStep<FillSlot>,
  frameUrl: string,
  actions: readonly string[] = [],
) => ({
  targetId: "primary",
  execute: () =>
    Effect.succeed({
      fields: step.fields.map((field) => ({
        target: target(frameUrl, actions),
        described: described(field.slot),
      })),
      submit:
        step.submit === undefined
          ? null
          : {
              target: { ...target(frameUrl, actions), control: "other" as const },
              described: described("submit"),
            },
      buttons: ["Sign in"],
      url: `${site}/sign-in`,
    }),
});

const inspect = (
  frameUrl: string,
  options: {
    readonly step?: AutofillStep<FillSlot>;
    readonly actions?: readonly string[];
    readonly trustAnySignInOrigin?: boolean;
    readonly authenticationOrigins?: readonly string[];
    readonly judgedBeforeTyping?: readonly string[];
  } = {},
) => {
  const step = options.step ?? signInStep;
  return Effect.runPromise(
    inspectAutofillStep({
      step,
      page: pageWith(step, frameUrl, options.actions),
      siteOrigin: site,
      authenticationOrigins: options.authenticationOrigins ?? [],
      ...(options.trustAnySignInOrigin === undefined
        ? {}
        : { trustAnySignInOrigin: options.trustAnySignInOrigin }),
      ...(options.judgedBeforeTyping === undefined
        ? {}
        : { judgedBeforeTyping: options.judgedBeforeTyping }),
    }),
  );
};

const refusedCheck = (report: object) =>
  "failureDetail" in report &&
  typeof report.failureDetail === "object" &&
  report.failureDetail !== null &&
  "context" in report.failureDetail
    ? report.failureDetail.context
    : undefined;

describe("trusting any sign-in origin", () => {
  it("refuses a sign-in form on another site's host unless the host trusts any sign-in origin", async () => {
    const unset = await inspect(`${signInHost}/u/login`);
    expect(unset).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(refusedCheck(unset)).toMatchObject({ check: "destination", part: "frame" });
    const set = await inspect(`${signInHost}/u/login`, {
      actions: [`${otherHost}/session`],
      trustAnySignInOrigin: true,
    });
    expect(set).not.toHaveProperty("outcome");
    expect(set).toMatchObject({ trustAnySignInOrigin: true, authenticationOrigins: [] });
  });

  it("returns the same inspection as before when the host leaves it unset or false", async () => {
    const before = await inspect(`${site}/sign-in`);
    expect(before).not.toHaveProperty("outcome");
    expect(Object.keys(before)).not.toContain("trustAnySignInOrigin");
    const off = await inspect(`${site}/sign-in`, { trustAnySignInOrigin: false });
    expect(Object.keys(off)).toEqual(Object.keys(before));
    expect(await inspect(`${signInHost}/u/login`, { trustAnySignInOrigin: false })).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
    });
  });

  it.each([
    ["plain http", "http://login.example.net/u/login"],
    ["an IPv4 address", "https://203.0.113.7/u/login"],
    ["an IPv6 address", "https://[2001:db8::1]/u/login"],
    ["localhost", "https://localhost/u/login"],
    ["a bare public suffix", "https://github.io/u/login"],
    ["an address carrying credentials", "https://user:secret@login.example.net/u/login"],
  ])(
    "still refuses a sign-in form on %s when the host trusts any sign-in origin",
    async (_, frameUrl) => {
      expect(await inspect(frameUrl, { trustAnySignInOrigin: true })).toMatchObject({
        outcome: "refused",
        reason: "credential_target_refused",
      });
    },
  );

  it("still refuses a form that posts to plain http when the host trusts any sign-in origin", async () => {
    const report = await inspect(`${signInHost}/u/login`, {
      actions: ["http://plain.example.net/session"],
      trustAnySignInOrigin: true,
    });
    expect(refusedCheck(report)).toMatchObject({ check: "destination", part: "form_action" });
  });

  it("names an unjudged origin other once anything was typed, whatever it trusts", async () => {
    const report = await inspect(`${signInHost}/u/login`, {
      actions: ["http://plain.example.net/session"],
      trustAnySignInOrigin: true,
      judgedBeforeTyping: [],
    });
    expect(refusedCheck(report)).toMatchObject({
      check: "destination",
      part: "form_action",
      frameOrigin: "other",
      documentOrigin: "other",
      actionOrigins: "other",
    });
  });

  it("trusts a sign-in popup on another site's host only when the host trusts any sign-in origin", async () => {
    const popupStep: AutofillStep = {
      ...signInStep,
      popup: { opener: "primary", origin: signInHost },
    };
    const unset = await inspect(`${signInHost}/u/login`, { step: popupStep });
    expect(refusedCheck(unset)).toMatchObject({ check: "destination", part: "popup" });
    const set = await inspect(`${signInHost}/u/login`, {
      step: popupStep,
      trustAnySignInOrigin: true,
    });
    expect(set).not.toHaveProperty("outcome");
  });
});

describe("card fields when the host trusts any sign-in origin", () => {
  const trust = {
    siteOrigin: site,
    authenticationOrigins: [],
    paymentFrameOrigins,
    trustAnySignInOrigin: true,
  };
  const cardStep = (...slots: FillSlot[]): AutofillStep<FillSlot> => ({
    fields: slots.map((slot, index) => ({ selector: `#field-${index}`, slot })),
  });

  it("refuses a card field in a frame off the payment processors' list", () => {
    expect(
      untrustedTarget(
        { fields: [target("https://pay.example.net/card.html")], submit: null },
        cardStep("card_number"),
        trust,
        0,
      ),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
  });

  it("trusts no other field of a card step on another site's host", () => {
    expect(
      untrustedTarget(
        {
          fields: [target(`${site}/checkout`), target(`${signInHost}/u/login`)],
          submit: null,
        },
        cardStep("card_number", "zip"),
        trust,
        0,
      ),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused", target: 1 });
  });

  it("refuses a card step's page off the site, as before", async () => {
    const step = cardStep("card_number");
    expect(
      await Effect.runPromise(
        inspectAutofillStep({
          step,
          page: {
            targetId: "primary",
            execute: () =>
              Effect.succeed({
                fields: [
                  { target: target(paymentFrameOrigins[0] ?? site), described: described("number") },
                ],
                submit: null,
                buttons: [],
                url: `${signInHost}/checkout`,
              }),
          },
          siteOrigin: site,
          authenticationOrigins: [],
          paymentFrameOrigins,
          trustAnySignInOrigin: true,
        }),
      ),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
  });
});

describe("the fill's judgment when a control moves", () => {
  const passwordStep: AutofillStep = { fields: [{ selector: "#password", slot: "password" }] };
  const password = "synthetic-password";

  /**
   * The password field, found on `signInHost`, then moved by the page into a frame on `otherHost`
   * when the fill's first call looks for it: the fill judges it again by the inspection's rule.
   */
  const fillMoved = (
    trust: Pick<AutofillInspection, "authenticationOrigins" | "trustAnySignInOrigin">,
  ) => {
    const typed: string[] = [];
    let calls = 0;
    const inspection: AutofillInspection = {
      page: `${signInHost}/u/login`,
      targets: { fields: [target(`${signInHost}/u/login`)], submit: null },
      siteOrigin: site,
      ...trust,
      screen: { origin: signInHost, fields: [], submit: null, buttons: [] },
    };
    const report = Effect.runPromise(
      fillAutofillStep({
        step: passwordStep,
        values: [password],
        inspection,
        settleMs: 0,
        page: {
          targetId: "primary",
          execute: () =>
            Effect.sync(() => {
              calls += 1;
              if (calls === 1)
                return {
                  changed: { fields: [target(`${otherHost}/password`)], submit: null },
                  url: `${otherHost}/password`,
                };
              return calls === 2
                ? { focused: true, url: `${otherHost}/password` }
                : { submit: "none", url: `${otherHost}/password` };
            }),
        },
        keyboard: {
          insertText: (_target, text) =>
            Effect.sync(() => {
              typed.push(text);
              return "inserted" as const;
            }),
        },
      }),
    );
    return { report, typed };
  };

  it("types into a field the page moved to another site's host when the inspection trusts any sign-in origin", async () => {
    const { report, typed } = fillMoved({ authenticationOrigins: [], trustAnySignInOrigin: true });
    expect(await report).toMatchObject({ outcome: "filled" });
    expect(typed).toEqual([password]);
  });

  it("refuses that field, typing nothing, when the inspection trusts only its configured origins", async () => {
    const { report, typed } = fillMoved({ authenticationOrigins: [signInHost] });
    expect(await report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(typed).toEqual([]);
  });
});
