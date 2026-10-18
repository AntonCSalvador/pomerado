import { describe, expect, it } from "vitest";
import {
  countsAsCarried,
  findKnownValues,
  formDecoded,
  observedForms,
  scanKnownValues,
  shownForms,
} from "../../src/privacy/known-values.js";

/*
 * findKnownValues is how screening finds registered values in megabyte bodies. It must return
 * the reference per-form scan's occurrences in the same order, including overlapping forms,
 * forms shared between values, forms shorter than its hashed prefix and repeated text.
 */

let seed = 11;
const random = (limit: number) => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed % limit;
};
const alphabet = Array.from("abAB01-_%=é😀");
const word = (length: number) =>
  Array.from({ length }, () => alphabet[random(alphabet.length)]).join("");

describe("known value occurrences", () => {
  it("equal the per-form scan on long texts with many values", () => {
    for (let round = 0; round < 20; round++) {
      const values = Array.from({ length: 5 + random(40) }, () => {
        const value = word(1 + random(9));
        return { value, forms: [value, encodeURIComponent(value), value + value.slice(0, 2)] };
      });
      // Shared forms between values, and a form that is a prefix of another.
      values.push({ value: "abab", forms: ["abab", "aba", "ab", ""] });
      values.push({ value: "abab2", forms: ["abab"] });
      let text = "";
      while (text.length < 5_000 + random(7_000))
        text +=
          random(3) === 0 ? (values[random(values.length)]?.forms[0] ?? "") : word(1 + random(12));
      text += "abababababab";
      const fast = findKnownValues(text, values);
      expect(fast).toEqual(scanKnownValues(text, values));
    }
  });

  it("finds every occurrence of hundreds of values in a long body", () => {
    const values = Array.from({ length: 300 }, (_, index) => {
      const value = `ck${index}-${(index * 7919).toString(36)}Zq${index * 31}`;
      return {
        value,
        forms: [value, Buffer.from(value).toString("base64")],
      };
    });
    const filler = "x".repeat(400_000) + "\n";
    const text = [
      filler,
      values[7]?.value,
      filler,
      values[299]?.forms[1],
      filler,
      values[7]?.value,
    ].join("");
    const found = findKnownValues(text, values);
    expect(
      found.map((occurrence) => [
        occurrence.value.value,
        text.slice(occurrence.start, occurrence.end),
      ]),
    ).toEqual([
      [values[7]?.value, values[7]?.value],
      [values[7]?.value, values[7]?.value],
      [values[299]?.value, values[299]?.forms[1]],
    ]);
    expect(found).toEqual(scanKnownValues(text, values));
  });
});

describe("forms of a value", () => {
  const value = 'p a+ss"w\\rd';
  const forms = observedForms(value);

  it("lists the form, percent, query and base64 encodings and JSON escape first, in that order", () => {
    expect(forms.slice(0, 5)).toEqual([
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      Buffer.from(value).toString("base64"),
      JSON.stringify(value).slice(1, -1),
    ]);
  });

  it.each([
    ["as Chromium writes it into a URL's query", 'p%20a+ss%22w\\rd'],
    ["as Chromium writes it into a URL's path", "p%20a+ss%22w/rd"],
    ["percent-encoded in lowercase hex", "p%20a%2bss%22w%5crd"],
  ])("adds the value %s", (_, shown) => {
    expect(forms).toContain(shown);
  });

  it("adds a snapshot's quoted value and key, and its collapsed whitespace", () => {
    expect(observedForms("o'brien \"x\"")).toEqual(
      expect.arrayContaining(['o\'brien \\"x\\"', "o''brien \"x\""]),
    );
    expect(observedForms("  two   words ")).toContain("two words");
  });

  it("lists each form once", () => {
    expect(new Set(forms).size).toBe(forms.length);
  });

  it("counts a short value's base64 form as short, as its other forms", () => {
    expect(shownForms("red")).toContainEqual([Buffer.from("red").toString("base64"), true]);
    expect(shownForms("correct horse")).toContainEqual([
      Buffer.from("correct horse").toString("base64"),
      false,
    ]);
  });

  it("keeps every other form of a value a URL cannot encode", () => {
    const lone = "pass\ud800word";
    expect(shownForms(lone).map(([form]) => form)).toContain(lone);
    expect(() => observedForms(lone)).toThrow(URIError);
  });
});

describe("formDecoded", () => {
  it("decodes + and each valid run of escapes, leaving an invalid run as written", () => {
    expect(formDecoded("pw=%70%40ss+word&bad=%E0")).toBe("pw=p@ss word&bad=%E0");
  });

  it("is undefined when there is nothing to decode", () => {
    expect(formDecoded("plain text")).toBeUndefined();
    expect(formDecoded("50%")).toBeUndefined();
  });
});

describe("countsAsCarried", () => {
  const answer = { entity: "SECURITY_ANSWER", value: "red" };

  it("counts a short security answer only as a whole token", () => {
    expect(countsAsCarried("a red car", 2, 5, answer)).toBe(true);
    expect(countsAsCarried("required", 0, 3, answer)).toBe(false);
  });

  it("counts every other secret anywhere", () => {
    expect(countsAsCarried("required", 0, 3, { entity: "PASSWORD", value: "red" })).toBe(true);
  });
});
