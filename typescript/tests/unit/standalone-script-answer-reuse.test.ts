// Failure modes covered: a later step asks the owner again for an answer it may reuse, or changes
// its shape; a step reuses an answer twice, too old, to another question, no longer valid for the
// question as asked, to a code, secret or login, after the owner answered its prompt anew, or
// after an earlier step entered a commit or may have.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { InputRequest, ValidAnswers } from "../../src/runtime/input-request.js";
import {
  forgetScriptAnswers,
  keptScriptAnswers,
  reusedScriptAnswers,
  scriptAnswerReuseMs,
  scriptCommitsUnsent,
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
const kept = (asked: InputRequest, answers: ValidAnswers, nowMs = 0) =>
  keptScriptAnswers([], keys(asked), answers, { executionId: "first", nowMs });
const later = (asked: InputRequest, entries: readonly KeptScriptAnswer[], nowMs = 1) =>
  reusedScriptAnswers(asked, keys(asked), entries, { executionId: "later", nowMs })?.answers;

describe("a later step's script question", () => {
  it("reuses the owner's answer to the same question in a fresh answer's shape", () => {
    expect(later(plan, kept(plan, answered))).toEqual(answered);
    // A declined confirm is reused as the same refusal.
    const approve = request([{ id: "approve", type: "confirm", prompt: "Approve the terms?" }]);
    const declined: ValidAnswers = { approve: { type: "confirm", value: { confirmed: false } } };
    expect(later(approve, kept(approve, declined))).toEqual(declined);
  });

  it("asks again within the step that asked, and once the answer is as old as the window", () => {
    const entries = kept(plan, answered);
    expect(
      reusedScriptAnswers(plan, keys(plan), entries, { executionId: "first", nowMs: 1 }),
    ).toBeUndefined();
    // A step reuses an answer once: asking again, as before a second try at its commit, asks.
    const reused = reusedScriptAnswers(plan, keys(plan), entries, { executionId: "two", nowMs: 1 });
    expect(reused?.answers).toEqual(answered);
    const after = reused?.kept ?? [];
    expect(reusedScriptAnswers(plan, keys(plan), after, { executionId: "two", nowMs: 2 })).toBe(
      undefined,
    );
    expect(
      reusedScriptAnswers(plan, keys(plan), after, { executionId: "three", nowMs: 2 })?.answers,
    ).toEqual(answered);
    expect(later(plan, entries, scriptAnswerReuseMs - 1)).toEqual(answered);
    expect(later(plan, entries, scriptAnswerReuseMs)).toBeUndefined();
    // A later answer drops the expired one.
    const late = { executionId: "late", nowMs: scriptAnswerReuseMs };
    expect(keptScriptAnswers(entries, keys(request([])), {}, late)).toEqual([]);
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
    const step = { executionId: "second", nowMs: 1 };
    const newer = keptScriptAnswers(entries, keys(wider), bronze, step);
    expect(later(plan, newer, 2)).toBeUndefined();
    expect(later(wider, newer, 2)).toEqual(bronze);
  });
});

describe("whether a build's commits are still unsent", () => {
  const act = (commit: "not_entered" | "entered" | "undeclared" | "unreported") => ({
    executionId: "act",
    commit,
  });

  it("holds while every finished act step entered none of its declared commits", () => {
    expect(scriptCommitsUnsent({ actSteps: [], writeSteps: [] })).toBe(true);
    expect(scriptCommitsUnsent({ actSteps: [act("not_entered")], writeSteps: ["act"] })).toBe(true);
  });

  it("fails once an earlier step entered a commit or may have", () => {
    for (const commit of ["entered", "undeclared", "unreported"] as const)
      expect(scriptCommitsUnsent({ actSteps: [act(commit)], writeSteps: [] })).toBe(false);
    // A step Guardian labelled a write that is no act step has no commit report to rely on.
    expect(scriptCommitsUnsent({ actSteps: [act("not_entered")], writeSteps: ["example"] })).toBe(
      false,
    );
  });
});
