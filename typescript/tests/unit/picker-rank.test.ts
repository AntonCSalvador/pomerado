import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { PickOutcome, pickRefusal } from "../../src/browser/picker.js";
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

describe("rankChoices word stems", () => {
  const dentistry = [
    choice("Dentistry"),
    choice("Cosmetic Dentistry"),
    choice("Pediatric Dentistry"),
    choice("Emergency Dentistry"),
    choice("General Dentistry (Dental Assistant)"),
  ];

  test("a word picks the one option whose word shares a long enough start with it", () => {
    expect(rank(dentistry, "Dentist")).toEqual({ status: "picked", index: 0, rank: "stem" });
    expect(rank([choice("Cardiology"), choice("Neurology")], "Cardiologist")).toEqual({ status: "picked", index: 0, rank: "stem" });
    expect(rank([choice("Pediatric Dentistry"), choice("Pediatrics")], "Pediatrician")).toEqual({
      status: "picked",
      index: 1,
      rank: "stem",
    });
    expect(rank([choice("Orthodontics")], "Orthodontist")).toEqual({ status: "picked", index: 0, rank: "stem" });
    expect(rank([choice("Dermatology")], "Dermatologist")).toEqual({ status: "picked", index: 0, rank: "stem" });
    expect(rank([choice("Dentist")], "Dentists")).toEqual({ status: "picked", index: 0, rank: "stem" });
  });

  test("every word of the name must pair, in order", () => {
    expect(rank([choice("Obstetrics & Gynecology")], "Obstetrician Gynecologist")).toEqual({
      status: "picked",
      index: 0,
      rank: "stem",
    });
    expect(rank([choice("Obstetrics & Gynecology")], "Obstetrician")).toEqual({ status: "missing" });
    expect(rank([choice("Sports Dentistry")], "Dentist")).toEqual({ status: "missing" });
  });

  test("two options that pair equally tie", () => {
    expect(rank([choice("Dentistry"), choice("Dentists"), choice("Cosmetic Dentistry")], "Dentist")).toEqual({
      status: "ambiguous",
      indexes: [0, 1],
      rank: "stem",
    });
    expect(rank([choice("Cardiology"), choice("Cardiologists")], "Cardiologist")).toEqual({
      status: "ambiguous",
      indexes: [0, 1],
      rank: "stem",
    });
  });

  test("a match as written, by whole name or by whole word, outranks a stem", () => {
    expect(rank([choice("Dentistry"), choice("Dentist")], "Dentist")).toEqual({ status: "picked", index: 1, rank: "exact" });
    expect(rank([choice("Dentistry"), choice("dentist")], "Dentist")).toEqual({ status: "picked", index: 1, rank: "normalized" });
    expect(rank([choice("Obstetrics"), choice("Obstetrician & Gynecologist")], "Obstetrician")).toEqual({
      status: "picked",
      index: 1,
      rank: "words",
    });
  });

  test("a shared start under five letters or under 70% of the longer word never pairs", () => {
    expect(rank([choice("Physics")], "Physician")).toEqual({ status: "missing" });
    expect(rank([choice("Christy")], "Christian")).toEqual({ status: "missing" });
    expect(rank([choice("Adams")], "Adam")).toEqual({ status: "missing" });
    expect(rank([choice("Ukraine"), choice("United Kingdom")], "UK")).toEqual({ status: "missing" });
    expect(rank([choice("Dental Hygienist")], "Dentist")).toEqual({ status: "missing" });
    expect(rank([choice("Dental")], "Dentist")).toEqual({ status: "missing" });
  });

  test("a word with a digit, or with letters outside Latin, only pairs with itself", () => {
    expect(rank([choice("Suite 12345")], "Suite 1234")).toEqual({ status: "missing" });
    expect(rank([choice("Москвичка")], "Москвич")).toEqual({ status: "missing" });
  });

  test("a stem never matches an option's value", () => {
    expect(rank([choice("General", "dentistry")], "Dentist")).toEqual({ status: "missing" });
  });

  test("a pick by stem decodes and reports its rank", () => {
    const pick = { picked: true, kind: "typeahead", label: "Dentistry", value: "", rank: "stem", refills: 0 };
    expect(Schema.decodeUnknownSync(PickOutcome)(pick)).toEqual(pick);
  });

  test("a disabled stem match is reported, not replaced", () => {
    expect(rank([choice("Dentistry", "", true)], "Dentist")).toEqual({ status: "disabled", index: 0, rank: "stem" });
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
