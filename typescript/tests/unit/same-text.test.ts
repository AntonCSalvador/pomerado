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

it("confirms a town the list writes short against the caller's spelling and the label picked", () => {
  expect(sameText("St-Exemple-sur-Lac", "Saint-Exemple-sur-Lac")).toBe(true);
  expect(sameText("St-Exemple-sur-Lac", "St-Exemple-sur-Lac")).toBe(true);
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
    ["j.smith@example.com", "jo.smith@example.com"],
    ["user@example.com", "user@example.community"],
    ["Row A", "Row AA"],
    ["York", "Yorkshire"],
    ["北京", "北京大学"],
  ];
  for (const [wanted, shown] of pairs)
    expect(sameText(shown, wanted), `shown ${shown} | wanted ${wanted}`).toBe(false);
});

it("reads no short form inside an email, domain or file name, or in a word outside Latin letters", () => {
  // Each pair is what the page shows, then the caller's wanted text.
  const pairs: Pairs = [
    ["j.smith@example.com", "jo.smith@example.com"],
    ["www.e.com", "www.example.com"],
    ["a.pdf", "annual.pdf"],
    ["Rpt 2024.pdf", "Receipt 2024.pdf"],
    ["a 2024.pdf", "annual 2024.pdf"],
    ["北京", "北京大学"],
    ["中国", "中国银行"],
    ["田中", "田中太郎"],
    ["Мск", "Москва"],
    ["क", "कमल"],
  ];
  for (const [shown, wanted] of pairs)
    expect(sameText(shown, wanted), `shown ${shown} | wanted ${wanted}`).toBe(false);
  // Latin letters beyond A to Z still read short.
  expect(sameText("Øst", "Østergade")).toBe(true);
  // An abbreviation's own periods, as in D.C. or U.S., leave short forms on.
  expect(sameText("100 Main Ave, Washington, D.C.", "100 Main Avenue, Washington, D.C.")).toBe(true);
  expect(sameText("U.S. Hwy 1", "U.S. Highway 1")).toBe(true);
});

it("drops characters that never show, as normalizeText does", () => {
  expect(sameText("St\u200B-Jean", "Saint-Jean")).toBe(true);
  expect(sameText("Jo\u00ADhn Smith", "\uFEFFJohn\u2060 Smith")).toBe(true);
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

it("embeds as self-contained source, so page code can use it", () => {
  const embedded = new Function(`return ${String(sameText)};`)() as typeof sameText;
  expect(embedded("St-Jean", "Saint Jean")).toBe(true);
  expect(embedded("Saint Jean", "St-Jean")).toBe(false);
  expect(embedded("St-Jean", "St-Jean-de-Luz")).toBe(false);
});
