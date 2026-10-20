/** One option a picker listed, as `rankChoices` reads it. */
export interface PickerChoice {
  /** Every name the option shows or carries: its text, first line, accessible name, title, cells. */
  readonly names: readonly string[];
  /** The value the option carries in an attribute, such as `data-value`, or "". */
  readonly value: string;
  readonly disabled: boolean;
  /** Options with one key are one option seen twice; different keys are different options. */
  readonly key: string;
  /** True for a native select's or datalist's option, whose empty value marks a prompt such as "Choose...". */
  readonly native?: boolean;
}

/** How closely the winning option matched, best first. */
export const pickerRanks = ["exact", "normalized", "folded", "words"] as const;
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
 * punctuation (`fold`), then `words`. A name beats the value at each rank. Options at the first
 * rank that matches decide: one option (by key) is picked, or reported disabled when every copy of
 * it is; two or more are ambiguous, listed in the list's order, never guessed. A weaker rank never
 * overrules a stronger one, so a disabled exact match is not replaced by a looser one.
 *
 * Without `words`, as a write picks, the `words` rank takes a name holding a spelling as whole
 * words. With `words`, a scorer such as `rankByWords`, as a read picks, it takes instead the
 * option whose names share the most words with a spelling, by its score. Options tied for the
 * most shared words are ambiguous, and an option scored 0, such as one sharing no word or, with
 * `rankByWords`, one lacking a number of the spelling, never matches. A name an option repeats
 * counts once, and a native option with an empty value, a prompt such as "Choose...", never
 * matches by its score.
 *
 * It is pure and self-contained: the page code of `pickerCode` embeds this same function with
 * `fold` set to `foldChoiceText`, and passes `rankByWords` as `words` when a pick asks to match by
 * shared words.
 */
export const rankChoices = (
  choices: readonly PickerChoice[],
  wanted: readonly string[],
  fold: (text: string) => string,
  words?: (query: string, texts: readonly string[]) => readonly number[],
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
  let best: { readonly scores: readonly number[]; readonly top: number } | undefined;
  const tests: readonly (readonly [PickerRank, (choice: PickerChoice, index: number) => boolean])[] = [
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
      (choice, index) => {
        if (words === undefined) {
          const parts = spellings.map(phrase).filter((part) => part.trim() !== "");
          return choice.names.some((name) => parts.some((part) => phrase(name).includes(part)));
        }
        // Each option's best score over its names and the spellings, scored once. A name an
        // option repeats, as a native option's label, text and title often do, counts once, and a
        // native select's prompt is left out.
        if (best === undefined) {
          const names = choices.flatMap((choice, at) =>
            choice.native === true && choice.value === ""
              ? []
              : [...new Map(choice.names.map((name) => [fold(name), name])).values()].map((name) => ({ at, name })),
          );
          const scores = choices.map(() => 0);
          for (const spelling of spellings) {
            const found = words(spelling, names.map((entry) => entry.name));
            found.forEach((score, entry) => {
              const at = names[entry]?.at ?? 0;
              scores[at] = Math.max(scores[at] ?? 0, score);
            });
          }
          best = { scores, top: Math.max(0, ...scores) };
        }
        return best.top > 0 && best.top - (best.scores[index] ?? 0) < 1e-9;
      },
    ],
  ];
  for (const [rank, test] of tests) {
    const matched = choices.flatMap((choice, index) => (test(choice, index) ? [index] : []));
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
