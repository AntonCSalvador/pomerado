// Failure modes covered: a later step reuses an answer to a question that matches by id alone or
// has another id, to one whose follow-up changed, to a code, secret, login or payment card
// question, no longer valid for the question as asked, or after the owner answered its prompt
// anew; the same question asked again, or long after the owner answered, asks the owner again; a
// reuse changes the answer's shape; a host reading kept answers back decodes one it cannot read,
// or refuses one an earlier release kept with more fields. By decision: a script's question that
// names the agent's earlier question asks the owner again; an answer carries over to an option
// with another label, to another type, to a confirm with a follow-up the owner never saw, or with
// the owner's own words the question does not take; an older answer to the decision wins over a
// newer one; one protected question makes the request ask what the owner already answered.
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  declaredDecisions,
  forgetScriptAnswers,
  KeptScriptAnswer,
  keptScriptAnswers,
  scriptQuestionKeys,
  settledScriptAnswers,
} from "../../src/mint/script-answer-reuse.js";
import type { InputRequest, ValidAnswers } from "../../src/runtime/input-request.js";

const request = (questions: InputRequest["questions"]): InputRequest => ({
  id: "request",
  source: "script",
  questions,
});
const choice = {
  id: "plan",
  type: "choice" as const,
  prompt: "Which plan do you have?",
  options: [
    { id: "gold", label: "Gold" },
    { id: "silver", label: "Silver" },
  ],
};
const plan = request([choice]);
const gold: ValidAnswers = { plan: { type: "choice", value: "gold" } };
const keys = (asked: InputRequest) =>
  Effect.runSync(scriptQuestionKeys(asked, (text) => Effect.succeed(text)));
const kept = (asked: InputRequest, answers: ValidAnswers) =>
  keptScriptAnswers([], keys(asked), answers);
/** The reused answers when nothing is left to ask, else undefined. */
const reuse = (asked: InputRequest, entries: readonly KeptScriptAnswer[]) => {
  const { reused, remaining } = settledScriptAnswers(asked, keys(asked), entries);
  return remaining === undefined ? reused : undefined;
};

describe("a later step's script question", () => {
  it("reuses the owner's answer in a fresh answer's shape, a refusal as a refusal", () => {
    expect(reuse(plan, kept(plan, gold))).toEqual(gold);
    const approve = request([{ id: "approve", type: "confirm", prompt: "Approve the terms?" }]);
    const declined: ValidAnswers = { approve: { type: "confirm", value: { confirmed: false } } };
    expect(reuse(approve, kept(approve, declined))).toEqual(declined);
  });

  it("reuses an answer as often as the question comes back, and keeps it until replaced", () => {
    const entries = kept(plan, gold);
    // Reusing leaves the kept answer in place, so every later ask of the same question reuses it.
    for (let ask = 0; ask < 3; ask++) expect(reuse(plan, entries)).toEqual(gold);
    // A kept answer carries no time and no step, so neither age nor the asking step ends it.
    expect(entries).toEqual([{ question: keys(plan)[0], answer: gold["plan"], decision: "plan" }]);
    // Only a newer answer to the same prompt replaces it; another prompt's answer keeps it.
    expect(keptScriptAnswers(entries, keys(request([])), {})).toEqual(entries);
  });

  it("never keeps or reuses an answer to a code, a secret or a login", () => {
    const secrets = request([
      { id: "code", type: "secret", secretKind: "one_time_code", prompt: "Which code?" },
      { id: "pin", type: "secret", secretKind: "private_text", prompt: "What is your PIN?" },
      {
        id: "login",
        type: "credential",
        prompt: "Sign in to the site",
        fields: "username_password",
        reason: "missing_credentials",
        allowSave: false,
        siteOrigin: "https://example.com",
      },
    ]);
    const answers: ValidAnswers = {
      code: { type: "secret", value: "246810" },
      pin: { type: "secret", value: "1357" },
      login: { type: "credential", value: { username: "a", password: "b", saveLogin: false } },
    };
    expect(keys(secrets)).toEqual([undefined, undefined, undefined]);
    expect(kept(secrets, answers)).toEqual([]);
    expect(reuse(secrets, kept(secrets, answers))).toBeUndefined();
    // Beside a protected question, the plain one is reused and only the code is asked again.
    const mixed = request([choice, ...secrets.questions.slice(0, 1)]);
    const settled = settledScriptAnswers(
      mixed,
      keys(mixed),
      kept(mixed, { ...gold, code: answers["code"]! }),
    );
    expect(settled.reused).toEqual(gold);
    expect(settled.remaining?.questions.map((question) => question.id)).toEqual(["code"]);
  });

  it("never keeps or reuses a part of a payment card, which is asked again every time", () => {
    const card = request([
      { id: "number", type: "secret", secretKind: "card_number", prompt: "Card number?" },
      { id: "expiry", type: "secret", secretKind: "card_expiry", prompt: "Expiry?" },
      { id: "cvc", type: "secret", secretKind: "card_cvc", prompt: "Security code?" },
      { id: "zip", type: "secret", secretKind: "billing_postal_code", prompt: "Billing ZIP?" },
    ]);
    const answers: ValidAnswers = {
      number: { type: "secret", value: "4242424242424242" },
      expiry: { type: "secret", value: "12/34" },
      cvc: { type: "secret", value: "123" },
      zip: { type: "secret", value: "94110" },
    };
    expect(keys(card)).toEqual([undefined, undefined, undefined, undefined]);
    expect(kept(card, answers)).toEqual([]);
    expect(reuse(card, kept(card, answers))).toBeUndefined();
  });

  it("matches the id, type, prompt, options and a confirm's follow-up", () => {
    const entries = kept(plan, gold);
    for (const changed of [
      { ...choice, id: "tier" },
      { ...choice, type: "multi_choice" as const, minSelections: 1, maxSelections: 1 },
      { ...choice, prompt: "Which plan should the booking use?" },
      { ...choice, options: [...choice.options, { id: "bronze", label: "Bronze" }] },
      {
        ...choice,
        options: [
          { id: "gold", label: "Gold plan" },
          { id: "silver", label: "Silver" },
        ],
      },
    ])
      expect(reuse(request([changed]), entries)).toBeUndefined();
    const confirm = { id: "approve", type: "confirm" as const, prompt: "Approve the terms?" };
    const withNote = { ...confirm, followUp: { prompt: "Anything to add?" } };
    const yes: ValidAnswers = { approve: { type: "confirm", value: { confirmed: true } } };
    expect(reuse(request([withNote]), kept(request([confirm]), yes))).toBeUndefined();
    expect(reuse(request([withNote]), kept(request([withNote]), yes))).toEqual(yes);
  });

  it("asks again when the kept answer is not valid for the question as asked now", () => {
    const extras = {
      id: "extras",
      type: "multi_choice" as const,
      prompt: "Which extras?",
      options: [
        { id: "bag", label: "Bag" },
        { id: "seat", label: "Seat" },
      ],
      minSelections: 0,
      maxSelections: 2,
    };
    const both: ValidAnswers = { extras: { type: "multi_choice", value: ["bag", "seat"] } };
    const entries = kept(request([extras]), both);
    expect(reuse(request([extras]), entries)).toEqual(both);
    expect(reuse(request([{ ...extras, maxSelections: 1 }]), entries)).toBeUndefined();
  });

  it("keeps only the owner's latest answer to a prompt", () => {
    const entries = kept(plan, gold);
    expect(reuse(plan, forgetScriptAnswers(entries, [choice.prompt]))).toBeUndefined();
    expect(reuse(plan, forgetScriptAnswers(entries, ["Which seat?"]))).toEqual(gold);
    const wider = request([
      { ...choice, options: [...choice.options, { id: "bronze", label: "Bronze" }] },
    ]);
    const bronze: ValidAnswers = { plan: { type: "choice", value: "bronze" } };
    const newer = keptScriptAnswers(entries, keys(wider), bronze);
    expect(reuse(plan, newer)).toBeUndefined();
    expect(reuse(wider, newer)).toEqual(bronze);
  });

  it("decodes only the kept answers this release reads, when a host reads them back", () => {
    const [entry] = kept(plan, gold);
    // An earlier release also kept when and in which run the owner answered; neither matters now.
    const earlier = { ...entry, executionId: "first", answeredAtMs: 0 };
    expect(
      [entry, earlier, { question: { id: "plan" } }].flatMap((candidate) =>
        Option.toArray(Schema.decodeUnknownOption(KeptScriptAnswer)(candidate)),
      ),
    ).toEqual([entry, entry]);
  });
});

/** The minter's own question, answered by the owner earlier in the build. */
const agentAsked = (questions: InputRequest["questions"]): InputRequest => ({
  id: "agent",
  source: "agent",
  questions,
});
const agentKept = (asked: InputRequest, answers: ValidAnswers) =>
  keptScriptAnswers([], keys(asked), answers);
/** What a script's request reuses and leaves to ask, each question naming its decision. */
const settle = (
  asked: InputRequest,
  entries: readonly KeptScriptAnswer[],
  decisions: readonly (string | undefined)[],
) => settledScriptAnswers(asked, keys(asked), entries, decisions);
const cabin = agentAsked([
  {
    id: "cabin",
    type: "choice",
    prompt: "Which cabin should the booking use?",
    options: [
      { id: "economy", label: "Economy" },
      { id: "business", label: "Business" },
    ],
    allowOther: true,
    allowNote: true,
  },
]);
/** The script's own wording of the same decision, with the page's options at ask time. */
const pageCabinQuestion = {
  id: "seat_class",
  type: "choice" as const,
  prompt: "Which cabin?",
  options: [
    { id: "o1", label: "business" },
    { id: "o2", label: "Économy " },
  ],
};
const pageCabin = request([pageCabinQuestion]);

describe("a script's question that names an earlier decision", () => {
  it("takes the owner's answer to the agent's question, picking the page's option by its label", () => {
    const entries = agentKept(cabin, {
      cabin: { type: "choice", value: { option: "economy", note: "the cheapest fare" } },
    });
    // The note went to the agent with the answer; the script's question takes none.
    expect(settle(pageCabin, entries, ["cabin"])).toEqual({
      reused: { seat_class: { type: "choice", value: "o2" } },
      remaining: undefined,
    });
    // Without a decision, a different question is never matched to it.
    expect(settle(pageCabin, entries, [undefined]).remaining).toEqual(pageCabin);
    expect(settle(pageCabin, entries, ["plan"]).remaining).toEqual(pageCabin);
  });

  it("asks again when the page offers no single option for the owner's pick or words", () => {
    const other = (text: string) =>
      agentKept(cabin, { cabin: { type: "choice", value: { other: text } } });
    expect(settle(pageCabin, other("business"), ["cabin"]).reused).toEqual({
      seat_class: { type: "choice", value: "o1" },
    });
    // The owner's own words reach a script's choice only where it takes them.
    expect(settle(pageCabin, other("Premium economy"), ["cabin"]).remaining).toEqual(pageCabin);
    const ownWords = request([{ ...pageCabinQuestion, allowOther: true }]);
    expect(settle(ownWords, other("Premium economy"), ["cabin"]).reused).toEqual({
      seat_class: { type: "choice", value: { other: "Premium economy" } },
    });
    const first = request([
      {
        id: "seat_class",
        type: "choice",
        prompt: "Which cabin?",
        options: [{ id: "o1", label: "First" }],
      },
    ]);
    const economy = agentKept(cabin, { cabin: { type: "choice", value: "economy" } });
    expect(settle(first, economy, ["cabin"]).remaining).toEqual(first);
  });

  it("maps every pick of a multiple choice, or asks again", () => {
    const extras = agentAsked([
      {
        id: "extras",
        type: "multi_choice",
        prompt: "Which extras should the booking add?",
        options: [
          { id: "bag", label: "Checked bag" },
          { id: "seat", label: "Seat selection" },
        ],
        minSelections: 0,
        maxSelections: 2,
      },
    ]);
    const page = (labels: readonly string[]) =>
      request([
        {
          id: "add_ons",
          type: "multi_choice",
          prompt: "Which add-ons?",
          options: labels.map((label, index) => ({ id: `o${index + 1}`, label })),
          minSelections: 0,
          maxSelections: labels.length,
        },
      ]);
    const both = agentKept(extras, {
      extras: { type: "multi_choice", value: ["bag", "seat"] },
    });
    expect(settle(page(["Seat selection", "Checked bag", "Insurance"]), both, ["extras"]).reused)
      .toEqual({ add_ons: { type: "multi_choice", value: ["o2", "o1"] } });
    expect(settle(page(["Checked bag"]), both, ["extras"]).reused).toEqual({});
    // Nothing picked carries over as nothing picked.
    const none = agentKept(extras, { extras: { type: "multi_choice", value: [] } });
    expect(settle(page(["Checked bag"]), none, ["extras"]).reused).toEqual({
      add_ons: { type: "multi_choice", value: [] },
    });
  });

  it("carries a confirm over only to a confirm whose follow-up the owner saw", () => {
    const terms = agentAsked([{ id: "terms", type: "confirm", prompt: "Accept the site terms?" }]);
    const yes = agentKept(terms, { terms: { type: "confirm", value: { confirmed: true } } });
    const accept = request([{ id: "accept", type: "confirm", prompt: "Accept?" }]);
    expect(settle(accept, yes, ["terms"]).reused).toEqual({
      accept: { type: "confirm", value: { confirmed: true } },
    });
    const dialog = request([
      { id: "accept", type: "confirm", prompt: "Accept?", followUp: { prompt: "Your name?" } },
    ]);
    expect(settle(dialog, yes, ["terms"]).remaining).toEqual(dialog);
    // Another type of question is another decision's shape: asked again.
    const text = request([{ id: "accept", type: "text", prompt: "Accept?" }]);
    expect(settle(text, yes, ["terms"]).remaining).toEqual(text);
  });

  it("takes the owner's latest answer to the decision, from the agent or a script", () => {
    const economy = agentKept(cabin, { cabin: { type: "choice", value: "economy" } });
    // A script's answer to the same decision replaces the agent's.
    const scriptBusiness = keptScriptAnswers(
      economy,
      keys(pageCabin),
      { seat_class: { type: "choice", value: "o1" } },
      ["cabin"],
    );
    expect(scriptBusiness).toHaveLength(1);
    expect(settle(pageCabin, scriptBusiness, ["cabin"]).reused).toEqual({
      seat_class: { type: "choice", value: "o1" },
    });
    // And the agent's newer answer replaces the script's.
    const again = keptScriptAnswers(scriptBusiness, keys(cabin), {
      cabin: { type: "choice", value: "economy" },
    });
    expect(settle(pageCabin, again, ["cabin"]).reused).toEqual({
      seat_class: { type: "choice", value: "o2" },
    });
  });

  it("takes the answer to an earlier script question it names by id, reworded", () => {
    const entries = kept(plan, gold);
    const reworded = request([{ ...choice, id: "tier", prompt: "Which plan is on the account?" }]);
    expect(settle(reworded, entries, ["plan"]).reused).toEqual({
      tier: { type: "choice", value: "gold" },
    });
    // A question that names no decision is never matched by id alone.
    expect(settle(request([{ ...choice, prompt: "Which plan?" }]), entries, []).reused).toEqual(
      {},
    );
  });

  it("asks only what the owner has not answered", () => {
    const economy = agentKept(cabin, { cabin: { type: "choice", value: "economy" } });
    const both = request([pageCabinQuestion, { id: "meal", type: "text", prompt: "Which meal?" }]);
    const settled = settle(both, economy, ["cabin", undefined]);
    expect(settled.reused).toEqual({ seat_class: { type: "choice", value: "o2" } });
    expect(settled.remaining).toEqual({ ...both, questions: [both.questions[1]] });
  });

  it("reads each question's decision from its declaration, never a secret's or an undeclared one", () => {
    const asked = request([
      pageCabinQuestion,
      { id: "meal", type: "text", prompt: "Which meal?" },
      { id: "pin", type: "secret", secretKind: "private_text", prompt: "PIN?" },
    ]);
    expect(
      declaredDecisions(asked, {
        seat_class: { type: "choice", prompt: "Which cabin?", decision: "cabin" },
        pin: { type: "secret", secretKind: "private_text", prompt: "PIN?" },
      }),
    ).toEqual(["cabin", undefined, undefined]);
    expect(declaredDecisions(asked, undefined)).toEqual([undefined, undefined, undefined]);
  });
});
