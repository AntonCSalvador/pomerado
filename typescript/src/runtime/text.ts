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
