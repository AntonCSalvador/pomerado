/**
 * Text as a person reads it: characters that never show (zero-width space U+200B, word joiner
 * U+2060, byte order mark U+FEFF and soft hyphen U+00AD) removed, while the zero-width
 * non-joiner and joiner (U+200C, U+200D), which spell words in many scripts and join emoji, stay;
 * a no-break space or any other Unicode space read as a space, runs of spaces and tabs collapsed
 * to one, each line trimmed and empty lines dropped. By default the lines are joined
 * with one space; `lines: true` keeps them, separated by "\n".
 *
 * It is pure and self-contained: the page code of `visibleTextCode` embeds this same function, so a
 * value read over HTTP or from parsed HTML normalizes as one read from the rendered page does.
 */
export const normalizeText = (text: string, options: { readonly lines?: boolean } = {}): string =>
  text
    .replace(/[\u200B\u2060\uFEFF\u00AD]/gu, "")
    .replace(/\r\n?|[\u0085\u2028\u2029]/gu, "\n")
    .replace(/[ \t\v\f\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(options.lines === true ? "\n" : " ");

/**
 * A choice's name folded for matching: case, accents and runs of spaces ignored, apostrophes
 * dropped and the punctuation `.`, `,`, hyphens and dashes read as a space, except next to a
 * digit, so "Joe’s Café" and "joes cafe" name the same option while "-1.5" keeps its sign and
 * point. Text that folds to nothing is kept as written, trimmed.
 *
 * It is pure and self-contained: the page code of `formControlsCode` and `pickerCode` embeds this
 * same function, so every option match folds names alike.
 */
export const foldChoiceText = (text: unknown): string => {
  const folded = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .normalize("NFC")
    .replace(/(?<!\p{N})['\u2018\u2019\u02bc](?!\p{N})/gu, "")
    .replace(/(?<!\p{N})[.,\-\u2010\u2011\u2012\u2013\u2014](?!\p{N})/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return folded === "" ? String(text ?? "").trim() : folded;
};

/**
 * Whether `shown`, text read from the page, names what `wanted` names, as a person reads them.
 * Case, accents on Latin, Greek and Cyrillic letters, spacing and apostrophes are ignored, and so
 * are periods, commas and hyphens between letters, while marks that change a word in other scripts,
 * such as Hindi, Thai and Japanese, still count. A word `shown` writes short, such as St for Saint
 * or Blvd for Boulevard, matches the full word in `wanted` when it starts with the same letter,
 * keeps its letters in order and is at most half as long. This holds only for words of Latin
 * letters, never inside an email, domain or file name. A short word in `wanted` never matches a
 * longer one in `shown`, so a wanted Pen never matches a shown Pencil. Both texts need the same
 * number of words in the same order, and a word holding a digit or another symbol, such as a slash
 * or a bracket, must be the same word, so 12 never matches 123, C++ never matches C and Blue/Green
 * never matches Blue Green. Compare numbers, dates and amounts as values instead. It is pure and
 * self-contained, so page code can embed it, as `formControlsCode` does.
 */
export const sameText = (shown: string, wanted: string): boolean => {
  const fold = (text: string) => {
    const raw = String(text ?? "").replace(/[\u00AD\u200B\u2060\uFEFF]/gu, "");
    const folded = raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/(?<!\p{N})['\u2018\u2019\u02bc](?!\p{N})/gu, "")
      .replace(/(?<!\p{N})[.,\-\u2010\u2011\u2012\u2013\u2014](?!\p{N})/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return folded === "" ? raw.trim() : folded;
  };
  // The page's word writes the wanted one short: same first letter, its letters in order in the
  // wanted word, and at most half as long. Never the other way round.
  const shortens = (short: string, full: string) => {
    const latin = /^\p{Script=Latin}+$/u.test(short + full);
    if (!latin || short[0] !== full[0] || short.length * 2 > full.length) return false;
    let next = 0;
    for (const letter of full) if (letter === short[next]) next++;
    return next === short.length;
  };
  // An email, domain or file name is a literal: none of its words reads as short for another. A
  // period before two letters marks one; an abbreviation's own periods, as in D.C., do not.
  const both = String(shown ?? "") + " " + String(wanted ?? "");
  const literal = /@|[\p{L}\p{N}]\.\p{L}{2}/u.test(both);
  const a = fold(shown).split(" ");
  const b = fold(wanted).split(" ");
  return (
    a.length === b.length &&
    a.every((word, index) => word === b[index] || (!literal && shortens(word, b[index] ?? "")))
  );
};
