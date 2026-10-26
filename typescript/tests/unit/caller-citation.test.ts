import { expect, it } from "vitest";
import { citesCallerRequest, citesConfirmedUpdate } from "../../src/mint/caller-citation.js";

/*
 * A caller_input ending's basis: its intent cites the caller's request, by a field name its input
 * holds or by words of its instruction, never by a value alone.
 */

const request = "List every open order, and stop if the account number does not match the export.";
const input = { accounts: [{ accountNumber: "A-77", lines: [{ unit_price: 4 }] }] };

it.each([
  ["a nested field in camelCase", "accountNumber is missing from the export"],
  ["a field inside an array, written in words", "The unit price conflicts with its source."],
  ["four words of the instruction in a row", "The request says: stop if the account number does not match."],
  ["a whole short instruction", "Asked to export it all, nothing more."],
])("takes %s", (_name, intent) => {
  const text = intent.startsWith("Asked") ? "Export it all" : request;
  expect(citesCallerRequest(intent, text, input)).toBe(true);
});

it.each([
  ["no intent", undefined],
  ["words the request never says", "The data looks inconsistent, so the build stops."],
  ["a value but no field", "A-77 is wrong."],
  ["three words of the instruction", "It should stop if the totals change."],
])("refuses %s", (_name, intent) => {
  expect(citesCallerRequest(intent, request, input)).toBe(false);
});

/*
 * A task update the owner confirmed in an answer is the caller's own request too: the intent cites
 * it by its revision, or by words of its summary, a change it makes or the answer that confirmed it.
 */

const confirmed = {
  revision: 2,
  summary: "Stop without searching when the store redirects.",
  changes: [
    {
      setting: "requirement" as const,
      change: "add" as const,
      text: "Search only the main store, and stop when it redirects to the sister store.",
    },
  ],
  confirmation: [
    {
      id: "store",
      question: "Where should the tool search?",
      answer: "Keep the main store only, and stop if it redirects",
    },
  ],
};
const unconfirmed = { ...confirmed, revision: 1, confirmation: [] };
const confirmedByYes = {
  ...confirmed,
  confirmation: [{ id: "stop", question: "Stop on a redirect?", answer: "Yes" }],
};

it.each([
  ["its revision", "Task revision 2 requires stopping here."],
  ["words of its requirement", "It must stop when it redirects to the sister store."],
  ["words of its summary", "Per the update: stop without searching when redirected."],
  ["words of the answer that confirmed it", "The owner chose to keep the main store only."],
])("takes a confirmed update cited by %s", (_name, intent) => {
  expect(citesConfirmedUpdate(intent, [unconfirmed, confirmed])).toBe(true);
});

it.each([
  ["no intent", undefined, [confirmed]],
  ["an update no answer confirmed", "Task revision 1 requires stopping here.", [unconfirmed]],
  ["another revision", "Task revision 20 requires stopping here.", [confirmed]],
  ["the minter's own notes", "My notes say a redirect ends this build.", [confirmed]],
  ["a one-word answer", "Yes, the owner said so.", [confirmedByYes]],
] as const)("refuses %s", (_name, intent, updates) => {
  expect(citesConfirmedUpdate(intent, updates)).toBe(false);
});
