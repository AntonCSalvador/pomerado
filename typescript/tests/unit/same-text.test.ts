import { expect, it } from "vitest";
import { sameText } from "../../src/runtime/text.js";

type Pairs = readonly (readonly [string, string])[];

/** Each pair gives the same answer in either order. */
const expectEach = (pairs: Pairs, same: boolean) => {
  for (const [shown, wanted] of pairs) {
    expect(sameText(shown, wanted), `${shown} | ${wanted}`).toBe(same);
    expect(sameText(wanted, shown), `${wanted} | ${shown}`).toBe(same);
  }
};

it("ignores case, accents and other marks, spacing and punctuation between letters", () => {
  expectEach(
    [
      ["Joe’s Café", "joes cafe"],
      ["  ABACÁ ", "abaca"],
      ["St. Louis", "St Louis"],
      ["Saint-Denis", "saint denis"],
      ["Cœur", "Coeur"],
      ["Straße", "Strasse"],
      ["Øster", "Oster"],
      ["Łódź", "Lodz"],
    ],
    true,
  );
});

it("matches a word written short that starts with the same letter, keeps its letters in order and is at most half as long", () => {
  expectEach(
    [
      ["St-Jean", "Saint-Jean"],
      ["Ste-Marie", "Sainte-Marie"],
      ["ST-ÉTIENNE", "Saint-Etienne"],
      ["St. Louis", "Saint Louis"],
      ["12 Main St", "12 Main Street"],
      ["Apt 4B", "Apartment 4b"],
      ["Bd", "Boulevard"],
      ["Blvd", "Boulevard"],
      ["Mt", "Mount"],
      ["Ft", "Fort"],
      ["Ln", "Lane"],
      ["Hwy 1", "Highway 1"],
      ["Str", "Strasse"],
      ["TX", "Texas"],
      ["J Smith", "John Smith"],
      ["Wm", "William"],
    ],
    true,
  );
});

it("needs the same number of words in the same order", () => {
  expectEach(
    [
      ["St-Jean", "St-Jean-de-Luz"],
      ["Smith John", "John Smith"],
      ["NY", "New York"],
      ["Le Mans", "Mans"],
      ["McDonald", "Mc Donald"],
    ],
    false,
  );
});

it("refuses a short word with a letter the full word lacks", () => {
  expectEach(
    [
      ["Ste-Foy", "Saint-Foy"],
      ["Ste", "St"],
    ],
    false,
  );
});

it("refuses a short word more than half as long, so similar names never match", () => {
  expectEach(
    [
      ["Jan", "Jean"],
      ["Jean", "Jeanne"],
      ["Dan", "Diane"],
      ["Bern", "Bergen"],
      ["Main St", "Martin St"],
      ["Lyon", "Lyons"],
      ["Paul", "Paula"],
      // Misses the guard costs: each fails loudly.
      ["Pkwy", "Parkway"],
      ["Ste", "Suite"],
      ["Robt", "Robert"],
      ["Hauptstr", "Hauptstraße"],
    ],
    false,
  );
});

it("needs a word holding a digit or symbol to be the same word", () => {
  expectEach(
    [
      ["12 Main St", "123 Main Street"],
      ["10/04/2026", "10/14/2026"],
      ["$1,200", "$1,200.00"],
      ["1200", "1,200"],
      ["5", "-5"],
      ["1.5", "1-5"],
      ["5'10", "510"],
      ["5-", "5"],
      ["C++", "C"],
      ["C#", "C"],
      ["+", "&"],
    ],
    false,
  );
  expectEach(
    [
      ["Apt 4B", "apt 4b"],
      ["$1,200", "$1,200"],
      ["-5", "-5"],
    ],
    true,
  );
});

it("keeps brackets and slashes on their word, as chooseOption does", () => {
  expectEach([["(Gironde)", "Gironde"]], false);
  expectEach([["Blue/Green", "blue/green"]], true);
});

it("keeps text of punctuation alone as it is, never blank", () => {
  expect(sameText("-", "-")).toBe(true);
  expectEach([["-", ""]], false);
  expectEach([["-", "  "]], false);
});

it("embeds as self-contained source, as the page code uses it", () => {
  const embedded = new Function(`return ${String(sameText)};`)() as typeof sameText;
  expect(embedded("St-Jean", "Saint Jean")).toBe(true);
  expect(embedded("St-Jean", "St-Jean-de-Luz")).toBe(false);
});
