// Failure modes covered: a script's ask asks the owner again for an answer it may reuse, whether in
// the step that got it, again in one run or long after the owner gave it, or changes its shape; a
// step reuses an answer to another question, no longer valid for the question as asked, to a code,
// secret or login, or after the owner answered its prompt anew.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { InputRequest, ValidAnswers } from "../../src/runtime/input-request.js";
import {
  forgetScriptAnswers,
  keptScriptAnswers,
  reusedScriptAnswers,
  scriptQuestionKeys,
  type KeptScriptAnswer,
} from "../../src/standalone/script-answer-reuse.js";

const request = (questions: InputRequest["questions"]): InputRequest => ({
  id: "request",
  source: "script",
  questions,
});
const plan = request([
  {
    id: "plan",
    type: "choice",
    prompt: "Which plan do you have?",
    options: [
      { id: "gold", label: "Gold" },
      { id: "silver", label: "Silver" },
    ],
  },
]);
const answered: ValidAnswers = { plan: { type: "choice", value: "gold" } };
const keys = (asked: InputRequest) =>
  Effect.runSync(scriptQuestionKeys(asked, (text) => Effect.succeed(text)));
const kept = (asked: InputRequest, answers: ValidAnswers) =>
  keptScriptAnswers([], keys(asked), answers);
const later = (asked: InputRequest, entries: readonly KeptScriptAnswer[]) =>
  reusedScriptAnswers(asked, keys(asked), entries);

describe("a later step's script question", () => {
  it("reuses the owner's answer to the same question in a fresh answer's shape", () => {
    expect(later(plan, kept(plan, answered))).toEqual(answered);
    // A declined confirm is reused as the same refusal.
    const approve = request([{ id: "approve", type: "confirm", prompt: "Approve the terms?" }]);
    const declined: ValidAnswers = { approve: { type: "confirm", value: { confirmed: false } } };
    expect(later(approve, kept(approve, declined))).toEqual(declined);
  });

  it("reuses an answer as often as the question comes back, and keeps it until replaced", () => {
    const entries = kept(plan, answered);
    // Reusing leaves the kept answer in place, so every later ask of the same question reuses it.
    for (let ask = 0; ask < 3; ask++) expect(later(plan, entries)).toEqual(answered);
    // A kept answer carries no time and no step, so neither age nor the asking step ends it.
    expect(entries).toEqual([{ question: keys(plan)[0], answer: answered["plan"] }]);
    // Only a newer answer to the same prompt replaces it; another prompt's answer keeps it.
    expect(keptScriptAnswers(entries, keys(request([])), {})).toEqual(entries);
  });

  it("asks again when the question's id, type, prompt, options or follow-up changed", () => {
    const entries = kept(plan, answered);
    const [question] = plan.questions;
    if (question?.type !== "choice") throw new Error("The fixture asks a choice");
    for (const changed of [
      { ...question, id: "tier" },
      { ...question, type: "multi_choice" as const, minSelections: 1, maxSelections: 1 },
      { ...question, prompt: "Which plan should the booking use?" },
      { ...question, options: [...question.options, { id: "bronze", label: "Bronze" }] },
      { ...question, options: [{ id: "gold", label: "Gold plan" }, question.options[1]!] },
    ])
      expect(later(request([changed]), entries)).toBeUndefined();
    const confirm = { id: "approve", type: "confirm" as const, prompt: "Approve the terms?" };
    const withNote = { ...confirm, followUp: { prompt: "Anything to add?" } };
    const yes: ValidAnswers = { approve: { type: "confirm", value: { confirmed: true } } };
    expect(later(request([withNote]), kept(request([confirm]), yes))).toBeUndefined();
    expect(later(request([withNote]), kept(request([withNote]), yes))).toEqual(yes);
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
    expect(later(request([extras]), kept(request([extras]), both))).toEqual(both);
    // Same id, type, prompt and options, but now at most one pick.
    expect(later(request([{ ...extras, maxSelections: 1 }]), kept(request([extras]), both))).toBe(
      undefined,
    );
  });

  it("never keeps or reuses a code, a secret or a login answer", () => {
    const code = request([
      {
        id: "code",
        type: "secret",
        secretKind: "one_time_code",
        prompt: "Which code did the site send?",
      },
    ]);
    const codeAnswer: ValidAnswers = { code: { type: "secret", value: "{{secret.s1}}" } };
    expect(kept(code, codeAnswer)).toEqual([]);
    const protectedOnes = request([
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
    expect(keys(protectedOnes)).toEqual([undefined, undefined]);
    const protectedAnswers: ValidAnswers = {
      pin: { type: "secret", value: "{{secret.s2}}" },
      login: { type: "credential", value: { username: "a", password: "b", saveLogin: false } },
    };
    expect(kept(protectedOnes, protectedAnswers)).toEqual([]);
    // One protected question in a request asks the whole request again.
    const both = request([...plan.questions, ...code.questions]);
    expect(later(both, kept(both, { ...answered, ...codeAnswer }))).toBeUndefined();
  });

  it("keeps only the owner's latest answer to a prompt", () => {
    const entries = kept(plan, answered);
    // The owner answered the same prompt since, to a question the minter asked.
    expect(later(plan, forgetScriptAnswers(entries, ["Which plan do you have?"]))).toBeUndefined();
    expect(later(plan, forgetScriptAnswers(entries, ["Which seat?"]))).toEqual(answered);
    // Or to a script question with the same prompt and other options.
    const [question] = plan.questions;
    if (question?.type !== "choice") throw new Error("The fixture asks a choice");
    const wider = request([
      { ...question, options: [...question.options, { id: "bronze", label: "Bronze" }] },
    ]);
    const bronze: ValidAnswers = { plan: { type: "choice", value: "bronze" } };
    const newer = keptScriptAnswers(entries, keys(wider), bronze);
    expect(later(plan, newer)).toBeUndefined();
    expect(later(wider, newer)).toEqual(bronze);
  });
});
