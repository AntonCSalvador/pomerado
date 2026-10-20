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

/** The page shows the short form and the caller wanted the full one: only that order matches. */
const expectShownShort = (pairs: Pairs) => {
  for (const [shown, wanted] of pairs) {
    expect(sameText(shown, wanted), `shown ${shown} | wanted ${wanted}`).toBe(true);
    expect(sameText(wanted, shown), `shown ${wanted} | wanted ${shown}`).toBe(false);
  }
};

it("ignores case, accents, spacing, apostrophes, and periods, commas and hyphens between letters", () => {
  expectEach(
    [
      ["Joe’s Café", "joes cafe"],
      ["  ABACÁ ", "abaca"],
      ["Crème Brûlée", "creme brulee"],
      ["St. Louis", "St Louis"],
      ["Saint-Denis", "saint denis"],
      ["Paris, France", "Paris France"],
    ],
    true,
  );
});

it("matches a word the page writes short when the wanted text has the full word", () => {
  expectShownShort([
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
  ]);
});

it("never matches a short wanted word against a longer word the page shows", () => {
  // Each pair is the caller's wanted text, then what the page shows.
  const pairs: Pairs = [
    ["USA", "Uzbekistan"],
    ["USA", "United States"],
    ["UAE", "Ukraine"],
    ["Ms", "Mr"],
    ["Ms", "Mrs"],
    ["Ms", "Miss"],
    ["Ms", "Dr"],
    ["Jon Lee", "Jonathan Lee"],
    ["Jo Smith", "John Smith"],
    ["Dan", "Duncan"],
    ["Pen", "Pencil"],
    ["XL", "XXXL"],
    ["5 m", "5 mm"],
    ["10 g", "10 gal"],
    ["a.smith@acme.com", "alan.smith@acme.com"],
    ["user@acme.com", "user@acme.community"],
    ["Row A", "Row AA"],
    ["York", "Yorkshire"],
    ["北京", "北京大学"],
  ];
  for (const [wanted, shown] of pairs)
    expect(sameText(shown, wanted), `shown ${shown} | wanted ${wanted}`).toBe(false);
});

it("still matches a page that shows a short word for a different longer wanted word, a known limit", () => {
  expect(sameText("Ms", "Miss")).toBe(true);
  expect(sameText("XL", "XXXL")).toBe(true);
});

it("needs the same number of words in the same order", () => {
  expectEach(
    [
      ["St-Jean", "St-Jean-de-Luz"],
      ["Smith John", "John Smith"],
      ["NY", "New York"],
      ["Le Mans", "Mans"],
      ["McDonald", "Mc Donald"],
      ["Acme Inc.", "Acme"],
      ["Paris, France", "Paris"],
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

it("needs a word holding a digit or another symbol to be the same word", () => {
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
      ["Blue/Green", "Blue Green"],
      ["(Gironde)", "Gironde"],
    ],
    false,
  );
  expectEach(
    [
      ["Apt 4B", "apt 4b"],
      ["$1,200", "$1,200"],
      ["-5", "-5"],
      ["Blue/Green", "blue/green"],
    ],
    true,
  );
});

it("folds only Latin accents, so a mark that spells another word in another script counts", () => {
  expectEach(
    [
      ["राम", "रमा"],
      ["कमल", "कोमल"],
      ["ขาว", "ข่าว"],
      ["バス", "パス"],
      // Letters that are not a base letter plus an accent stay as they are.
      ["Cœur", "Coeur"],
      ["Straße", "Strasse"],
      ["Øster", "Oster"],
      ["Łódź", "Lodz"],
    ],
    false,
  );
  expectEach(
    [
      ["Łódź", "Łodz"],
      ["Ñandú", "nandu"],
    ],
    true,
  );
});

it("keeps text of punctuation alone as it is, never blank", () => {
  expect(sameText("-", "-")).toBe(true);
  expectEach([["-", ""]], false);
  expectEach([["-", "  "]], false);
});

it("embeds as self-contained source, as the page code uses it", () => {
  const embedded = new Function(`return ${String(sameText)};`)() as typeof sameText;
  expect(embedded("St-Jean", "Saint Jean")).toBe(true);
  expect(embedded("Saint Jean", "St-Jean")).toBe(false);
  expect(embedded("St-Jean", "St-Jean-de-Luz")).toBe(false);
});
