import { expect, it } from "vitest";
import { rankByWords, readBackMatches, sameText } from "../../src/runtime/text.js";

it("scores 1 for text holding every word of the query, and 0 for text sharing none", () => {
  expect(rankByWords("Exemple Bay", ["Exemple Bay", "Bay Exemple", "Hillcrest"])).toEqual([1, 1, 0]);
  expect(rankByWords("Exemple Bay", [])).toEqual([]);
  expect(rankByWords("", ["Exemple Bay"])).toEqual([0]);
  expect(rankByWords("Exemple Bay", [""])).toEqual([0]);
});

it("ranks the text that shares the most words above one that shares fewer or adds more", () => {
  const [marina, exemple] = rankByWords("Exemple Bay", ["Exemple Bay Marina", "Exemple"]);
  expect(marina).toBeCloseTo(0.8302, 4);
  expect(exemple).toBeCloseTo(0.2618, 4);
  // A word few texts hold counts for more than one every text holds.
  const [north, road] = rankByWords("Lakeside Park", ["North Lakeside", "Lakeside Park Road"]);
  expect(road ?? 0).toBeGreaterThan(north ?? 0);
});

it("reads words ignoring case, accents and punctuation between letters", () => {
  expect(rankByWords("ACME Café", ["acme cafe", "Acme-Cafe", "acme, café"])).toEqual([1, 1, 1]);
  expect(rankByWords("U.S.A.", ["USA"])).toEqual([1]);
  expect(rankByWords("Joe’s Diner", ["joes diner"])).toEqual([1]);
});

it("reads one date, one phone number or one amount however the page writes it", () => {
  expect(rankByWords("2026-11-05", ["Wed, Nov 4, 2026", "Thu, Nov 5, 2026", "5 November 2026", "Nov. 5th 2026"])).toEqual([
    0, 1, 1, 1,
  ]);
  expect(rankByWords("2026-11-25", ["11/25/2026", "25/11/2026", "25.11.2026"])).toEqual([1, 1, 1]);
  expect(rankByWords("(555) 010-0199", ["555.010.0199", "+1 555 010 0199", "555 010 0198"])).toEqual([1, 1, 0]);
  expect(rankByWords("$1,250.00", ["1250", "1,250", "125"])).toEqual([1, 1, 0]);
  // A day and month order the text leaves open is no date, so it matches only as written.
  expect(rankByWords("03/04/2026", ["2026-03-04", "2026-04-03", "03/04/2026"])).toEqual([0, 0, 1]);
});

it("keeps a number, an email, a domain or a file name as one word", () => {
  expect(rankByWords("Order 1250", ["Order 1251"])[0]).toBeLessThan(0.7);
  expect(rankByWords("12", ["123", "1.2", "12"])).toEqual([0, 0, 1]);
  expect(rankByWords("-5", ["5", "+5", "-5"])).toEqual([0, 0, 1]);
  expect(rankByWords("5-", ["5", "5-"])).toEqual([0, 1]);
  expect(rankByWords("jo.smith@example.com", ["j.smith@example.com", "jo smith example com"])).toEqual([0, 0]);
  expect(rankByWords("report-2024.pdf", ["report 2024 pdf"])).toEqual([0]);
});

it("embeds as self-contained source, so page code can use it", () => {
  const embedded = new Function(`return ${String(rankByWords)};`)() as typeof rankByWords;
  expect(embedded("Exemple Bay", ["Exemple Bay Marina", "Hillcrest"])).toEqual(
    rankByWords("Exemple Bay", ["Exemple Bay Marina", "Hillcrest"]),
  );
});

it("confirms whatever sameText confirms, the short-word rule included", () => {
  for (const [shown, wanted] of [
    ["St-Exemple-sur-Lac", "Saint-Exemple-sur-Lac"],
    ["Joe’s Café", "joes cafe"],
    ["Blvd Exemple", "Boulevard Exemple"],
  ] as const) {
    expect(sameText(shown, wanted), `${shown} | ${wanted}`).toBe(true);
    expect(readBackMatches(shown, wanted), `${shown} | ${wanted}`).toBe(true);
  }
  // BM25 alone misses this one, since St and Saint are different words.
  expect(rankByWords("Saint-Exemple-sur-Lac", ["St-Exemple-sur-Lac"])[0]).toBeLessThan(0.7);
});

it("confirms text holding the wanted words in another order or among other words", () => {
  expect(readBackMatches("Bay Exemple", "Exemple Bay")).toBe(true);
  expect(readBackMatches("Exemple Bay Marina", "Exemple Bay")).toBe(true);
  expect(readBackMatches("Thu, Nov 5, 2026", "2026-11-05")).toBe(true);
  expect(readBackMatches("+1 (555) 010-0199", "555.010.0199")).toBe(true);
  expect(readBackMatches("$1,250.00", "1250")).toBe(true);
  // A wanted name inside a longer one is a known limit: it confirms.
  expect(readBackMatches("North Lakeside", "Lakeside")).toBe(true);
});

it("ignores case on both of its steps", () => {
  expect(readBackMatches("EXEMPLE BAY", "exemple bay")).toBe(true);
  // sameText refuses a word added, so only the BM25 step can confirm these.
  expect(sameText("ACME INSURANCE GROUP", "acme")).toBe(false);
  expect(readBackMatches("ACME INSURANCE GROUP", "acme")).toBe(true);
  expect(readBackMatches("acme insurance group", "ACME")).toBe(true);
  expect(readBackMatches("BAY EXEMPLE", "exemple bay")).toBe(true);
});

it("confirms from a BM25 score of 0.7 up, and refuses below it", () => {
  // One wanted word on a page that adds two words scores 0.727, and with three added 0.693.
  expect(rankByWords("Acme", ["Acme Insurance Group"])[0]).toBeCloseTo(0.7273, 4);
  expect(readBackMatches("Acme Insurance Group", "Acme")).toBe(true);
  expect(rankByWords("Acme", ["Acme Insurance Group Ltd"])[0]).toBeCloseTo(0.6932, 4);
  expect(readBackMatches("Acme Insurance Group Ltd", "Acme")).toBe(false);
  // Four wanted words among eleven more score 0.7, and among twelve 0.693.
  const words = (count: number) => Array.from({ length: count }, (_, index) => `extra${index}`).join(" ");
  const wanted = "alpha beta gamma delta";
  expect(rankByWords(wanted, [`${wanted} ${words(11)}`])[0]).toBeCloseTo(0.7, 10);
  expect(readBackMatches(`${wanted} ${words(11)}`, wanted)).toBe(true);
  expect(rankByWords(wanted, [`${wanted} ${words(12)}`])[0]).toBeCloseTo(0.6932, 4);
  expect(readBackMatches(`${wanted} ${words(12)}`, wanted)).toBe(false);
});

it("refuses text that drops a wanted word or changes a number", () => {
  expect(readBackMatches("Lakeside", "North Lakeside")).toBe(false);
  expect(readBackMatches("Order 1251", "Order 1250")).toBe(false);
  expect(readBackMatches("12", "123")).toBe(false);
  expect(readBackMatches("Wed, Nov 4, 2026", "2026-11-05")).toBe(false);
  expect(readBackMatches("j.smith@example.com", "jo.smith@example.com")).toBe(false);
});
