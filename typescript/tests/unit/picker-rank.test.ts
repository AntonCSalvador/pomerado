import { describe, expect, test } from "vitest";
import { pickRefusal } from "../../src/browser/picker.js";
import { rankChoices, type PickerChoice } from "../../src/browser/picker-rank.js";
import { foldChoiceText } from "../../src/runtime/text.js";

const choice = (names: string | readonly string[], value = "", disabled = false): PickerChoice => {
  const list = typeof names === "string" ? [names] : names;
  return { names: list, value, disabled, key: `${list.join("|")}#${value}` };
};
const rank = (choices: readonly PickerChoice[], ...wanted: string[]) =>
  rankChoices(choices, wanted, foldChoiceText);

describe("rankChoices", () => {
  test("a name as written beats one that matches only once case and spacing are ignored", () => {
    const choices = [choice("Basic"), choice("basic"), choice("Basic  plus")];
    expect(rank(choices, "basic")).toEqual({ status: "picked", index: 1, rank: "exact" });
    expect(rank(choices, "  Basic ")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank(choices, "BASIC")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "normalized" });
    expect(rank(choices, "basic PLUS")).toEqual({ status: "picked", index: 2, rank: "normalized" });
  });

  test("accents and punctuation are folded only after exact and case matches", () => {
    const choices = [choice("Abacá"), choice("St. Louis"), choice("Joe’s Café")];
    expect(rank(choices, "abaca")).toEqual({ status: "picked", index: 0, rank: "folded" });
    expect(rank(choices, "St Louis")).toEqual({ status: "picked", index: 1, rank: "folded" });
    expect(rank(choices, "joes cafe")).toEqual({ status: "picked", index: 2, rank: "folded" });
  });

  test("a name beats a value at the same rank, and a value matches when no name does", () => {
    const choices = [choice("CA", "ca-code"), choice("California", "CA")];
    expect(rank(choices, "CA")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank([choice("California", "CA")], "ca")).toEqual({ status: "picked", index: 0, rank: "normalized" });
  });

  test("whole words of a name match last, and a prefix never does", () => {
    const choices = [choice("Chicago O'Hare (ORD)"), choice("Chicago Midway (MDW)")];
    expect(rank(choices, "ORD")).toEqual({ status: "picked", index: 0, rank: "words" });
    expect(rank(choices, "Chicago")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "words" });
    expect(rank(choices, "Chic")).toEqual({ status: "missing" });
  });

  test("any spelling of the value may match, but two spellings naming two options tie", () => {
    const choices = [choice("California", "CA"), choice("Canada", "CAN")];
    expect(rank(choices, "Calif.", "California")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank(choices, "California", "Canada")).toEqual({ status: "ambiguous", indexes: [0, 1], rank: "exact" });
  });

  test("any of an option's names matches, such as a title or a table cell", () => {
    const row = choice(["C-101 Acme Insurance Group Boston", "C-101", "Acme Insurance Group", "Boston"], "C-101");
    expect(rank([row], "Acme Insurance Group")).toEqual({ status: "picked", index: 0, rank: "exact" });
    expect(rank([choice(["Acme Insur…", "Acme Insurance Group"])], "acme insurance group")).toMatchObject({ status: "picked" });
  });

  test("copies of one option count once and a disabled copy is skipped; a disabled best match is reported", () => {
    const copy = choice("Oslo", "osl");
    expect(rank([{ ...copy, disabled: true }, copy], "Oslo")).toEqual({ status: "picked", index: 1, rank: "exact" });
    // A looser enabled match never replaces a disabled exact one.
    expect(rank([choice("Oslo", "", true), choice("Oslo Airport")], "Oslo")).toEqual({ status: "disabled", index: 0, rank: "exact" });
  });

  test("two options with one label and different values are ambiguous", () => {
    expect(rank([choice("John Smith", "17"), choice("John Smith", "42")], "John Smith")).toEqual({
      status: "ambiguous",
      indexes: [0, 1],
      rank: "exact",
    });
  });

  test("an empty or blank value matches nothing", () => {
    expect(rank([choice("Anything"), choice("")], "")).toEqual({ status: "missing" });
    expect(rank([choice("Anything")], "   ")).toEqual({ status: "missing" });
  });
});

describe("pickRefusal", () => {
  test("a missing value names the field and lists what the picker offered", () => {
    const refusal = pickRefusal(
      { reason: "option_missing", wanted: "Atlantis", available: ["Chile", "China"], matches: [] },
      "country",
    );
    expect(refusal).toMatchObject({
      name: "InvalidInput",
      field: "country",
      available: ["Chile", "China"],
      kind: "option_missing",
    });
    expect(refusal.message).toContain('"Atlantis"');
  });

  test("an ambiguous value lists the options that tie as the choices", () => {
    const refusal = pickRefusal(
      { reason: "option_ambiguous", wanted: "Acme", available: ["Acme A", "Acme B", "Other"], matches: ["Acme A", "Acme B"] },
      "customer",
    );
    expect(refusal).toMatchObject({ field: "customer", available: ["Acme A", "Acme B"], kind: "option_ambiguous" });
  });
});
