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
 * never matches Blue Green. A space, hyphen, dash, slash or parentheses between digits is one
 * separator, whichever it is, so 29 59, 29-59 and 29/59 match, and so do (317) 555-1234 and
 * 317-555-1234, but the groups it separates count: 1/12 never matches 11/2, 1 234 never matches
 * 12 34 and 2959 never matches 29 59. A period or comma between digits counts too, so 10.0 never
 * matches 100. Compare numbers, dates and amounts as values instead.
 *
 * With `{ rewrite: true }`, `shown` is the site's own version of a value the tool typed, `wanted`,
 * such as an address the site standardized as it was entered, and the answer is whether it kept
 * everything the caller gave, which tells a rewrite that only reformatted the value from one that
 * changed it. Every word and number of `wanted` must appear in `shown`, in order, and `shown` may
 * add its own, as 100 N Main St adds N to 100 Main St. A word may be written short or in full
 * either way, with the same first letter, its letters in order and the short form at most three
 * fifths as long, so Parkway matches PKWY, Suite matches STE and St matches Street, while Main
 * never matches Martin. A number keeps its groups, as above, and may only gain groups after its
 * last, so 46204 matches 46204-1234, while 12 never matches 123 and 3175551234 never matches
 * (317) 555-1234. Other punctuation is ignored. A dropped or changed word or number fails, so
 * 1420 Oak Road, Springfield never matches 1420 Oak Rd, Riverton. An email, domain or file name,
 * or a `wanted` with no letter or digit, compares as it does without the option.
 *
 * It is pure and self-contained, so page code can embed it.
 */
export const sameText = (
  shown: string,
  wanted: string,
  options: { readonly rewrite?: boolean } = {},
): boolean => {
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
  // A space, hyphen, dash, slash or parentheses between digits is one separator, written as a
  // hyphen, and the opening parenthesis of a group such as (317) before more digits goes. The
  // groups stay, so 1/12 never reads as 11/2.
  const groupDigits = (text: string) =>
    text
      .replace(/\((?=\p{N}+\)[\s/\-\u2010-\u2014]*\p{N})/gu, "")
      .replace(/(?<=\p{N})[\s/()\-\u2010-\u2014]+(?=\p{N})/gu, "-");
  // One word writes another short: same first letter, its letters in order in the other word,
  // and at most half as long when `halfLength` holds, three fifths otherwise.
  const shortens = (short: string, full: string, halfLength: boolean) => {
    const latin = /^\p{Script=Latin}+$/u.test(short + full);
    if (!latin || short[0] !== full[0]) return false;
    if (halfLength ? short.length * 2 > full.length : short.length * 5 > full.length * 3)
      return false;
    let next = 0;
    for (const letter of full) if (letter === short[next]) next++;
    return next === short.length;
  };
  // An email, domain or file name is a literal: none of its words reads as short for another. A
  // period before two letters marks one; an abbreviation's own periods, as in D.C., do not.
  const both = String(shown ?? "") + " " + String(wanted ?? "");
  const literal = /@|[\p{L}\p{N}]\.\p{L}{2}/u.test(both);
  // Words and numbers, a number keeping a period or comma between its digits. A number that
  // follows another across separators alone continues it, `joined`.
  type Part = { text: string; number: boolean; joined: boolean };
  const parts = (text: string) => {
    const folded = fold(text);
    const found: Part[] = [];
    let end = 0;
    for (const match of folded.matchAll(/\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}\u200C\u200D]+/gu)) {
      const number = /^\p{N}/u.test(match[0]);
      const gap = folded.slice(end, match.index);
      const previous = found[found.length - 1];
      const joined = number && previous?.number === true && /^[\s/()\-\u2010-\u2014]*$/u.test(gap);
      found.push({ text: match[0], number, joined });
      end = (match.index ?? 0) + match[0].length;
    }
    return found;
  };
  // The site's version keeps each of the caller's words and numbers, in order, and may add its
  // own. A number the caller gave starts one of the site's with the same groups, one by one, and
  // the site's may go on with more.
  const kept = (site: readonly Part[], given: readonly Part[]) => {
    const items: Part[][] = [];
    for (const part of given) {
      const last = items[items.length - 1];
      if (part.joined && last !== undefined) last.push(part);
      else items.push([part]);
    }
    const fits = (item: readonly Part[], start: number) =>
      item.every((part, offset) => {
        const there = site[start + offset];
        if (there === undefined || there.number !== part.number) return false;
        if (part.number) return there.joined === (offset > 0) && there.text === part.text;
        return (
          there.text === part.text ||
          shortens(there.text, part.text, false) ||
          shortens(part.text, there.text, false)
        );
      });
    let at = 0;
    for (const item of items) {
      let start = at;
      while (start < site.length && !fits(item, start)) start++;
      if (start >= site.length) return false;
      at = start + item.length;
    }
    return true;
  };
  if (options?.rewrite === true && !literal) {
    const given = parts(wanted);
    if (given.length > 0) return kept(parts(shown), given);
  }
  const a = groupDigits(fold(shown)).split(" ");
  const b = groupDigits(fold(wanted)).split(" ");
  return (
    a.length === b.length &&
    a.every(
      (word, index) => word === b[index] || (!literal && shortens(word, b[index] ?? "", true)),
    )
  );
};
