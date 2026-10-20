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

it("reads an amount of seven digits or more as its number, written bare or formatted", () => {
  expect(readBackMatches("¥1,500,000", "1500000")).toBe(true);
  expect(readBackMatches("1500000", "$1,500,000.00")).toBe(true);
  expect(readBackMatches("1500000.00", "€1,500,000")).toBe(true);
  expect(readBackMatches("Total 1500000", "1,500,000")).toBe(true);
  expect(rankByWords("1500000", ["¥1,500,000", "1,500,001", "15,000,000"])).toEqual([1, 0, 0]);
  // A phone or account number still matches however it is spaced, and only its own digits.
  expect(readBackMatches("5550100199", "(555) 010-0199")).toBe(true);
  expect(readBackMatches("+1 555 010 0199", "15550100199")).toBe(true);
  expect(readBackMatches("555 010 0198", "5550100199")).toBe(false);
});

it("ignores characters that never show, and reads a combining accent as the letter's", () => {
  expect(rankByWords("Exemple Bay", ["Exem\u200Bple Bay", "Ex\u00ADemple Bay", "Exemple\u2060 Bay", "\uFEFFExemple Bay"])).toEqual([
    1, 1, 1, 1,
  ]);
  expect(rankByWords("Café", ["Cafe\u0301", "cafe"])).toEqual([1, 1]);
  expect(rankByWords("Exem\u200Bple", ["Exemple", "Exem ple"])).toEqual([1, 0]);
});

it("keeps a number, an email, a domain or a file name as one word", () => {
  expect(rankByWords("Order 1250", ["Order 1251"])).toEqual([0]);
  expect(rankByWords("12", ["123", "1.2", "12"])).toEqual([0, 0, 1]);
  expect(rankByWords("-5", ["5", "+5", "-5"])).toEqual([0, 0, 1]);
  expect(rankByWords("5-", ["5", "5-"])).toEqual([0, 1]);
  expect(rankByWords("jo.smith@example.com", ["j.smith@example.com", "jo smith example com"])).toEqual([0, 0]);
  expect(rankByWords("report-2024.pdf", ["report 2024 pdf"])).toEqual([0]);
});

it("scores 0 a text that lacks any number the query holds, reading numbers as above", () => {
  expect(rankByWords("7:30 PM", ["7:00 PM", "7:30 PM", "Sat 7:30 PM"])).toEqual([0, 1, expect.any(Number)]);
  expect(rankByWords("7:30 PM", ["Sat 7:30 PM"])[0]).toBeGreaterThan(0);
  expect(rankByWords("Order 1250", ["Order 1251", "Order 1250"])).toEqual([0, 1]);
  expect(rankByWords("Room 102", ["Room 101", "Room 102 Floor 1"])[0]).toBe(0);
  expect(rankByWords("Room 102", ["Room 102 Floor 1"])[0]).toBeGreaterThan(0);
  // A date, a phone or account number and an amount count as one number however they are written,
  // and a sign stays with its number.
  expect(rankByWords("2026-11-05", ["Thu, Nov 5, 2026", "Thu, Nov 12, 2026"])).toEqual([1, 0]);
  expect(rankByWords("(555) 010-0199", ["+1 555 010 0199", "555 010 0198"])).toEqual([1, 0]);
  expect(rankByWords("Refund $1,250.00", ["Refund 1250", "Refund 1,251"])).toEqual([1, 0]);
  expect(rankByWords("-5 degrees", ["5 degrees", "-5 degrees"])).toEqual([0, 1]);
});

it("refuses a read-back that changes one number, however many other words match", () => {
  const wanted = "Order 1250 for Exemple Supply Company shipped to the Exemple Street warehouse dock";
  expect(readBackMatches(wanted.replace("1250", "1251"), wanted)).toBe(false);
  const room = "Exemple Grand Hotel King Room 102 with ocean view and late checkout on the top floor";
  expect(readBackMatches(room.replace("102", "101"), room)).toBe(false);
  expect(readBackMatches(room, room.replace("Room 102 ", ""))).toBe(true);
});

it("leaves a write's check before it saves to sameText, which refuses a word added or dropped", () => {
  // readBackMatches is for reads: it accepts the wanted words among other words. A write checks
  // with sameText, so a page that shows another fare or another policy refuses.
  expect(sameText("Premium Economy", "Economy")).toBe(false);
  expect(sameText("Non-refundable", "Refundable")).toBe(false);
  expect(sameText("Economy", "Premium Economy")).toBe(false);
  expect(sameText("Refundable", "Non-refundable")).toBe(false);
  expect(readBackMatches("Premium Economy", "Economy")).toBe(true);
  // A read never confirms a value against its negation, either way round.
  expect(readBackMatches("Non-refundable", "Refundable")).toBe(false);
  // A read still confirms a name in another order or written short.
  expect(readBackMatches("Lopez, Catherine", "Catherine Lopez")).toBe(true);
  expect(sameText("Lopez, Catherine", "Catherine Lopez")).toBe(false);
  expect(readBackMatches("St-Exemple-sur-Lac", "Saint-Exemple-sur-Lac")).toBe(true);
});

it("reads a clock time as one value, where AM or PM counts", () => {
  // The same time written five ways.
  for (const shown of ["7:30 PM", "7:30PM", "7:30 pm", "19:30", "7:30 p.m."])
    expect(readBackMatches(shown, "7:30 PM"), shown).toBe(true);
  for (const shown of ["7 PM", "7:00 PM", "19:00", "7:00pm", "7pm"]) expect(readBackMatches(shown, "7 PM"), shown).toBe(true);
  // Another minute or the other half of the day never matches.
  expect(readBackMatches("7 PM", "7:30 PM")).toBe(false);
  expect(readBackMatches("7:30 PM", "7 PM")).toBe(false);
  expect(readBackMatches("7:30 AM", "7:30 PM")).toBe(false);
  expect(readBackMatches("19:30", "7:30 AM")).toBe(false);
  expect(rankByWords("7:30 PM", ["7:30 AM", "7 PM", "19:30", "Sat 7:30PM"])).toEqual([0, 0, 1, expect.any(Number)]);
  expect(rankByWords("7:30 PM", ["Sat 7:30PM"])[0]).toBeGreaterThan(0);
  // A time without AM or PM, and an hour up to 12, matches either half of the day.
  expect(readBackMatches("7:30 PM", "7:30")).toBe(true);
  expect(readBackMatches("7:30 AM", "7:30")).toBe(true);
  expect(readBackMatches("07:30", "7:30")).toBe(true);
  const [morning, evening] = rankByWords("7:30", ["7:30 AM", "7:30 PM"]);
  expect(morning).toBeGreaterThan(0);
  expect(morning).toBe(evening);
});

it("never confirms a value against its negation, with no, not, non or without", () => {
  for (const [shown, wanted] of [
    ["Non-refundable", "Refundable"],
    ["Refundable", "Non-refundable"],
    ["Not refundable", "Refundable"],
    ["Refundable", "Not refundable"],
    ["No free cancellation", "Free cancellation"],
    ["Free cancellation", "No free cancellation"],
    ["Without breakfast", "Breakfast"],
    ["Breakfast", "Without breakfast"],
  ] as const) {
    expect(readBackMatches(shown, wanted), `${shown} | ${wanted}`).toBe(false);
    expect(rankByWords(wanted, [shown]), `${shown} | ${wanted}`).toEqual([0]);
  }
  // Both negated, the words still count, and "No." before a number is no negation.
  expect(readBackMatches("Fare: non-refundable", "Non-refundable")).toBe(true);
  expect(readBackMatches("Order No. 1250", "Order 1250")).toBe(true);
});

it("reads a # before a number as part of no word", () => {
  expect(readBackMatches("Order #1250", "Order 1250")).toBe(true);
  expect(readBackMatches("Order 1250", "Order #1250")).toBe(true);
  expect(rankByWords("1250", ["Order #1250", "Order #1251"])[1]).toBe(0);
  expect(rankByWords("1250", ["Order #1250"])[0]).toBeGreaterThan(0);
  expect(readBackMatches("Order #1251", "Order 1250")).toBe(false);
});

it("keeps some limits: numbers in another order match, and part of a date or phone number does not", () => {
  // Every number is there, so swapped counts confirm.
  expect(readBackMatches("3 adults, 2 children", "2 adults, 3 children")).toBe(true);
  // A date without its year, or a phone number without its area code, is refused loudly.
  expect(readBackMatches("Thu, Nov 5, 2026", "Nov 5")).toBe(false);
  expect(readBackMatches("(415) 555-1234", "555-1234")).toBe(false);
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
