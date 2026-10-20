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
 * self-contained, so page code can embed it.
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

/**
 * How much of `query`'s words each of `texts` holds, by BM25 (Okapi BM25 with k1 1.2 and b 0.75,
 * and Lucene's word weight), with `texts` as the set that weighs each word: a word few of them
 * hold counts for more. Each score is the text's BM25 score for the query over the query's own
 * score as a text, so 1 is a text holding every word of the query and no other, it falls as the
 * query's words go missing or the text adds others, and 0 is a text sharing no word with it.
 * Ranking texts by it ranks them by plain BM25.
 *
 * Words are read as `foldChoiceText` reads names: case, accents, apostrophes and periods, commas
 * and hyphens between letters are ignored. A whole text that names one date, such as
 * "Nov 5, 2026", "5 November 2026", "2026-11-05" or "25/11/2026", is one word, that date, unless
 * its day and month could be either way round, as in "03/04/2026". A whole text of 7 to 15 digits
 * with only spaces, periods, hyphens, brackets and a leading +, other than a number with two
 * decimals such as 1500000.00, is one word, its digits, without the leading 1 of 11 digits, so a
 * phone or account number matches however it is spaced. Thousands commas, a trailing .00 and
 * currency symbols are dropped, so $1,250.00 matches 1250 and ¥1,500,000 matches 1500000. An
 * email, domain or file name, a word whose digits are joined by a slash, period or hyphen, such as
 * 1.5 or ACCT-0042, and a number with a sign before or after it, such as -5 or 5+, each stay one
 * word, so 12 never matches 123 or 1.2, and 5 never matches -5. A run of single letters is one
 * word, so U.S.A. matches USA.
 *
 * It is pure and self-contained: the page code of `formControlsCode` and `pickerCode` embeds this
 * same function.
 */
export const rankByWords = (query: string, texts: readonly string[]): number[] => {
  const months: Readonly<Record<string, number>> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const weekdays: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const monthOf = (name: string) => months[name] ?? months[name.slice(0, 3)] ?? 0;
  // The ISO date a whole text names, or "" for none, an impossible date or an unclear order.
  const dateOf = (text: string): string => {
    let rest = text.normalize("NFC").toLowerCase().replace(/,/gu, " ").replace(/\s+/gu, " ").trim();
    let weekday: number | undefined;
    const named = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+(.*)$/u.exec(rest);
    if (named !== null) {
      weekday = weekdays[named[1] ?? ""];
      rest = named[2] ?? "";
    }
    let year = 0;
    let month = 0;
    let day = 0;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(rest);
    const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/u.exec(rest);
    const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/u.exec(rest);
    const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?\s+(\d{4})$/u.exec(rest);
    if (iso !== null) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    else if (numeric !== null) {
      const first = Number(numeric[1]);
      const second = Number(numeric[2]);
      year = Number(numeric[3]);
      if (first > 12 && second <= 12) [day, month] = [first, second];
      else if ((second > 12 && first <= 12) || first === second) [month, day] = [first, second];
      else return "";
    } else if (monthFirst !== null && monthOf(monthFirst[1] ?? "") > 0)
      [month, day, year] = [monthOf(monthFirst[1] ?? ""), Number(monthFirst[2]), Number(monthFirst[3])];
    else if (dayFirst !== null && monthOf(dayFirst[2] ?? "") > 0)
      [day, month, year] = [Number(dayFirst[1]), monthOf(dayFirst[2] ?? ""), Number(dayFirst[3])];
    else return "";
    const at = new Date(Date.UTC(year, month - 1, day));
    if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return "";
    if (weekday !== undefined && at.getUTCDay() !== weekday) return "";
    return at.toISOString().slice(0, 10);
  };
  const foldCase = (word: string) =>
    word.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").normalize("NFC").toLowerCase();
  const foldName = (word: string) => {
    const folded = foldCase(word)
      .replace(/(?<!\p{N})['\u2018\u2019\u02bc](?!\p{N})/gu, "")
      .replace(/(?<!\p{N})[.,\-\u2010\u2011\u2012\u2013\u2014](?!\p{N})/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return folded === "" ? word.trim() : folded;
  };
  const wordsOf = (text: string): string[] => {
    const raw = String(text ?? "")
      .replace(/[\u200B\u2060\uFEFF\u00AD]/gu, "")
      .replace(/[\s\u0085]+/gu, " ")
      .trim();
    const date = dateOf(raw);
    if (date !== "") return ["date:" + date];
    // A phone or account number is its digits, the word a bare number or an amount also gives.
    if (/^[+\d\s().-]+$/u.test(raw) && !/^\d+\.\d\d$/u.test(raw)) {
      const digits = raw.replace(/\D/gu, "");
      if (digits.length >= 7 && digits.length <= 15)
        return [digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits];
    }
    const spaced = raw
      .replace(/(?<![\p{L}\p{N}])(\d{1,3}(?:,\d{3})+)(?!\p{N})/gu, (number) => number.replace(/,/gu, ""))
      .replace(/(?<![\p{N}.])(\d+)\.0{1,2}(?!\p{N})/gu, "$1")
      .replace(/[$\u20AC\u00A3\u00A5\u20B9]/gu, " ");
    const words: string[] = [];
    for (const piece of spaced.split(" ")) {
      const word = piece.replace(/^[("'\u2018\u201C[]+|[)"'\u2019\u201D\].,;:!?\u2026]+$/gu, "");
      if (word === "") continue;
      const literal =
        /@|[\p{L}\p{N}]\.\p{L}{2,}/u.test(word) ||
        (/\p{N}/u.test(word) && /^[+-]?[\p{L}\p{N}]+(?:[/.-][\p{L}\p{N}]+)+$/u.test(word)) ||
        /^[+-]\p{N}|\p{N}[+-]$/u.test(word);
      if (literal) words.push(foldCase(word));
      else words.push(...foldName(word).split(/[^\p{L}\p{N}\p{M}+#&%]+/u).filter(Boolean));
    }
    // A run of single letters, as in U.S.A., is one word.
    const joined: string[] = [];
    for (let at = 0; at < words.length; at++) {
      if (!/^\p{L}$/u.test(words[at] ?? "") || !/^\p{L}$/u.test(words[at + 1] ?? "")) {
        joined.push(words[at] ?? "");
        continue;
      }
      let run = "";
      while (/^\p{L}$/u.test(words[at] ?? "")) run += words[at++];
      joined.push(run);
      at--;
    }
    return joined;
  };
  const docs = texts.map(wordsOf);
  const asked = wordsOf(query);
  const k1 = 1.2;
  const b = 0.75;
  const holding = new Map<string, number>();
  let total = 0;
  for (const doc of docs) {
    total += doc.length;
    for (const word of new Set(doc)) holding.set(word, (holding.get(word) ?? 0) + 1);
  }
  const average = docs.length === 0 ? 1 : Math.max(total / docs.length, 1e-9);
  const weight = (word: string) => {
    const held = holding.get(word) ?? 0;
    return Math.log(1 + (docs.length - held + 0.5) / (held + 0.5));
  };
  const score = (doc: readonly string[]) => {
    if (asked.length === 0 || doc.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const word of doc) counts.set(word, (counts.get(word) ?? 0) + 1);
    const norm = k1 * (1 - b + (b * doc.length) / average);
    let sum = 0;
    for (const word of asked) {
      const count = counts.get(word) ?? 0;
      if (count > 0) sum += (weight(word) * count * (k1 + 1)) / (count + norm);
    }
    return sum;
  };
  const own = score(asked);
  return docs.map((doc) => (own === 0 ? 0 : score(doc) / own));
};

/**
 * Whether text read back from the page, `shown`, confirms `wanted`, the option the tool picked or
 * the caller's value: `sameText(shown, wanted)` holds, or `shown` holds enough of `wanted`'s words,
 * a `rankByWords` score for `wanted` of 0.7 or more with `shown` as the only text. Case, accents,
 * spacing and punctuation between letters are ignored either way. The second step accepts the
 * wanted words in another order and among other words: a one-word value is confirmed by text
 * that adds up to two words to it, and text that drops one of the wanted words is not, unless the
 * value has eleven words or more. So a wanted name inside a longer one, such as Lakeside in North
 * Lakeside, is confirmed. Dates, phone numbers and amounts match as `rankByWords` reads them;
 * other numbers must be the same. It calls `sameText` and `rankByWords`, so page code that embeds
 * it embeds those two first.
 */
export const readBackMatches = (shown: string, wanted: string): boolean =>
  sameText(shown, wanted) || (rankByWords(wanted, [shown])[0] ?? 0) >= 0.7;
