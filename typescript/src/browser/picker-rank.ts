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
export const pickerRanks = ["exact", "normalized", "folded", "leading", "words"] as const;
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
 * punctuation (`fold`), then a name whose leading part, its text before its first comma, is a
 * spelling, folded the same way (`leading`: York, UK for York), then a name holding a spelling as
 * whole words (New York for York). A name beats the value at each rank. Options at the first rank that matches decide: one option (by key) is picked, or
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
  const phrase = (text: string) =>
    " " +
    fold(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .join(" ") +
    " ";
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
      "leading",
      (choice) => {
        const forms = new Set(spellings.map(fold).filter((spelling) => spelling !== ""));
        return choice.names.some((name) => {
          const comma = String(name ?? "").indexOf(",");
          return comma > 0 && forms.has(fold(String(name).slice(0, comma)));
        });
      },
    ],
    [
      "words",
      (choice) => {
        const parts = spellings.map(phrase).filter((part) => part.trim() !== "");
        return choice.names.some((name) => parts.some((part) => phrase(name).includes(part)));
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
