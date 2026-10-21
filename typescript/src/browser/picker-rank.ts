/** One option a picker listed, as `rankChoices` reads it. */
export interface PickerChoice {
  /** Every name the option shows or carries: its text, first line, accessible name, title, cells. */
  readonly names: readonly string[];
  /** The value the option carries in an attribute, such as `data-value`, or "". */
  readonly value: string;
  readonly disabled: boolean;
  /** Options with one key are one option seen twice; different keys are different options. */
  readonly key: string;
}

/** How closely the winning option matched, best first. */
export const pickerRanks = ["exact", "normalized", "folded", "words", "stem"] as const;
export type PickerRank = (typeof pickerRanks)[number];

export type PickerRanking =
  | { readonly status: "picked"; readonly index: number; readonly rank: PickerRank }
  | { readonly status: "disabled"; readonly index: number; readonly rank: PickerRank }
  | {
      readonly status: "ambiguous";
      readonly indexes: readonly number[];
      readonly rank: PickerRank;
    }
  | { readonly status: "missing" };

/**
 * The one option `wanted` names, a list of spellings of one choice, by rank: a name or the value
 * as written (trimmed), then ignoring case and spacing, then also ignoring accents and
 * punctuation (`fold`), then a name holding a spelling as whole words, then a name whose words
 * pair one for one with a spelling's by stem (`stem`): a practitioner's word with its field's,
 * such as Dentist with Dentistry, Pediatrician with Pediatrics or Cardiologist with Cardiology,
 * or either with its plural. Only the endings -ist, -ician and -arian (a practitioner) and
 * -istry, -ics and -y (a field) count, each also as a plural, and only on a word of letters
 * whose stem keeps four or more, so UK, Arm and Artist never stem, and County never pairs with
 * Count. The value never matches by stem. A name beats the value at each rank. Options at the first rank that matches decide: one option (by key) is picked, or
 * reported disabled when every copy of it is; two or more are ambiguous, never guessed. A weaker
 * rank never overrules a stronger one, so a disabled exact match is not replaced by a looser one.
 *
 * It is pure and self-contained: the page code of `pickerCode` embeds this same function with
 * `fold` set to `foldChoiceText`.
 */
export const rankChoices = (
  choices: readonly PickerChoice[],
  wanted: readonly string[],
  fold: (text: string) => string,
): PickerRanking => {
  const squash = (text: string) => String(text ?? "").replace(/\s+/gu, " ").trim();
  const lower = (text: string) => squash(text).toLowerCase();
  const words = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const phrase = (text: string) => " " + words(text).join(" ") + " ";
  // [ending, letters kept, kind]; the first ending a word has decides.
  const endings: readonly (readonly [string, string, string])[] = [
    ["istries", "", "istry"],
    ["istry", "", "istry"],
    ["icians", "", "ician"],
    ["ician", "", "ician"],
    ["arians", "ar", "arian"],
    ["arian", "ar", "arian"],
    ["ists", "", "ist"],
    ["ist", "", "ist"],
    ["ics", "", "ics"],
    ["ies", "", "y"],
    ["y", "", "y"],
  ];
  const practitioners = ["ist", "ician", "arian"];
  const stem = (word: string): readonly [string, string] => {
    const ending = /^\p{L}+$/u.test(word) ? endings.find(([end]) => word.endsWith(end)) : undefined;
    if (ending === undefined) return [word, ""];
    const root = word.slice(0, word.length - ending[0].length) + ending[1];
    return root.length >= 4 ? [root, ending[2]] : [word, ""];
  };
  const pairs = (want: string, have: string) => {
    if (want === have) return true;
    const [wantRoot, wantKind] = stem(want);
    const [haveRoot, haveKind] = stem(have);
    if (wantKind === "" || haveKind === "" || wantRoot !== haveRoot) return false;
    return wantKind === haveKind || practitioners.includes(wantKind) !== practitioners.includes(haveKind);
  };
  const spellings = wanted.map(squash).filter((spelling) => spelling !== "");
  const tests: readonly (readonly [PickerRank, (choice: PickerChoice) => boolean])[] = [
    ["exact", (choice) => choice.names.some((name) => spellings.includes(squash(name)))],
    ["exact", (choice) => choice.value !== "" && spellings.includes(squash(choice.value))],
    ...(
      [
        ["normalized", lower],
        ["folded", fold],
      ] as const
    ).flatMap(([rank, form]) => {
      const forms = new Set(spellings.map(form).filter((spelling) => spelling !== ""));
      return [
        [rank, (choice: PickerChoice) => choice.names.some((name) => forms.has(form(name)))],
        [rank, (choice: PickerChoice) => choice.value !== "" && forms.has(form(choice.value))],
      ] as const;
    }),
    [
      "words",
      (choice) => {
        const parts = spellings.map(phrase).filter((part) => part.trim() !== "");
        return choice.names.some((name) => parts.some((part) => phrase(name).includes(part)));
      },
    ],
    [
      "stem",
      (choice) => {
        const wants = spellings.map(words).filter((list) => list.length > 0);
        return choice.names.some((name) => {
          const have = words(name);
          return wants.some((want) => want.length === have.length && want.every((word, at) => pairs(word, have[at] ?? "")));
        });
      },
    ],
  ];
  for (const [rank, test] of tests) {
    const matched = choices.flatMap((choice, index) => (test(choice) ? [index] : []));
    if (matched.length === 0) continue;
    const keys = [...new Set(matched.map((index) => choices[index]?.key))];
    if (keys.length > 1) {
      const indexes = keys.map((key) => matched.find((index) => choices[index]?.key === key) ?? 0);
      return { status: "ambiguous", indexes, rank };
    }
    const enabled = matched.find((index) => choices[index]?.disabled === false);
    return enabled === undefined
      ? { status: "disabled", index: matched[0] ?? 0, rank }
      : { status: "picked", index: enabled, rank };
  }
  return { status: "missing" };
};
