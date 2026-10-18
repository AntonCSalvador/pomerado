import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import type { InputAnswers, InputRequest } from "../../src/runtime/input-request.js";
import {
  makeScriptInput,
  type ScriptOption,
  type ScriptQuestionDeclarations,
} from "../../src/runtime/script-input.js";

const questions: ScriptQuestionDeclarations = {
  pick: { type: "choice", prompt: "Which entry?" },
  picks: { type: "multi_choice", prompt: "Which entries?" },
};

/** Asks one choice with `options`, answers it with `answer`, and returns what each side saw. */
const ask = (
  options: ReadonlyArray<ScriptOption>,
  answer: (request: InputRequest) => InputAnswers = (request) => {
    const first = request.questions[0];
    return { pick: first?.type === "choice" ? (first.options[0]?.id ?? "") : "" };
  },
  id: "pick" | "picks" = "pick",
) => {
  const sent: InputRequest[] = [];
  const result = Effect.runSync(
    Effect.either(
      makeScriptInput(questions, (request) =>
        Effect.sync(() => {
          sent.push(request);
          return answer(request);
        }),
      ).ask({ [id]: { options } }),
    ),
  );
  const question = sent[0]?.questions[0];
  const offered =
    question?.type === "choice" || question?.type === "multi_choice" ? question.options : undefined;
  return { result, offered };
};

const picked = (optionId: string) => () => ({ pick: optionId });

describe("a script question's options", () => {
  it("accepts a long value and returns it unchanged", () => {
    const value = `entry:${"v".repeat(994)}`;
    const { result, offered } = ask([
      { value, label: "First" },
      { value: "second", label: "Second" },
    ]);
    expect(value).toHaveLength(1000);
    expect(offered?.map((option) => option.label)).toEqual(["First", "Second"]);
    expect(result).toEqual(Either.right({ pick: value }));
  });

  it("shortens a long label to 255 characters and an ellipsis", () => {
    const label = "Synthetic note ".repeat(20);
    const { result, offered } = ask([{ value: "first", label }]);
    expect(label).toHaveLength(300);
    expect(offered?.[0]?.label).toBe(`${label.slice(0, 255)}…`);
    expect(offered?.[0]?.label).toHaveLength(256);
    expect(result).toEqual(Either.right({ pick: "first" }));
  });

  it("keeps a label of exactly 256 characters as it is", () => {
    const label = "x".repeat(256);
    expect(ask([{ value: "first", label }]).offered?.[0]?.label).toBe(label);
  });

  it("never splits a character written as a surrogate pair", () => {
    // 254 letters put the pair at code units 254 and 255, across the 255 cut.
    const label = `${"a".repeat(254)}😀${"b".repeat(50)}`;
    const shown = ask([{ value: "first", label }]).offered?.[0]?.label;
    expect(shown).toBe(`${"a".repeat(254)}…`);
    expect(shown?.isWellFormed()).toBe(true);
  });

  it("shortens long labels of a multiple choice too", () => {
    const label = "y".repeat(400);
    const { result, offered } = ask(
      [
        { value: "first", label },
        { value: "second", label: "Second" },
      ],
      () => ({ picks: ["o1", "o2"] }),
      "picks",
    );
    expect(offered?.map((option) => option.label)).toEqual([`${"y".repeat(255)}…`, "Second"]);
    expect(result).toEqual(Either.right({ picks: ["first", "second"] }));
  });

  it("tells apart two labels that read the same once shortened, by the value behind each", () => {
    const shared = "Same opening words ".repeat(14);
    const options = [
      { value: "first", label: `${shared} then the first ending` },
      { value: "second", label: `${shared} then the second ending` },
    ];
    const { result, offered } = ask(options, picked("o2"));
    expect(offered).toEqual([
      { id: "o1", label: `${shared.slice(0, 255)}…` },
      { id: "o2", label: `${shared.slice(0, 255)}…` },
    ]);
    expect(result).toEqual(Either.right({ pick: "second" }));
  });

  it("still refuses an empty value or label, a repeated value, and a field options don't take", () => {
    const refused = Either.left(expect.objectContaining({ code: "InvalidOptions" }));
    const long = "z".repeat(300);
    expect(ask([{ value: "", label: "Empty value" }]).result).toEqual(refused);
    expect(ask([{ value: "first", label: "" }]).result).toEqual(refused);
    expect(
      ask([
        { value: "same", label: "First" },
        { value: "same", label: "Second" },
      ]).result,
    ).toEqual(refused);
    expect(
      ask([
        { value: long, label: "First" },
        { value: long, label: "Second" },
      ]).result,
    ).toEqual(refused);
    expect(
      ask([{ value: "first", label: "First", note: "extra" } as unknown as ScriptOption]).result,
    ).toEqual(refused);
  });
});
