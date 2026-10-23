import { expect, it } from "vitest";
import { locateCode, noOpScriptCode } from "../../src/destinations/autofill-locate-code.js";
import { submissionGuardCode } from "../../src/destinations/autofill-submission-guard.js";

const noOpScript = (0, eval)(noOpScriptCode) as (address: unknown) => boolean;

// Only a script action that does nothing is the page's own script submit. Any other script runs
// what its address says, so its form is judged as any form whose action is off the site.
it.each([
  "javascript:",
  "javascript:;",
  "javascript:void(0)",
  "javascript:void(0);",
  "javascript:void 0",
  "javascript:void 0;",
  "JAVASCRIPT:VOID(0)",
  " javascript: void ( 0 ) ; ",
  "java\tscript:void(0)",
  "javascript:%20void%280%29",
])("counts %j as a script action that does nothing", (address) => {
  expect(noOpScript(address)).toBe(true);
});

it.each([
  "javascript:send()",
  "javascript:void(send())",
  "javascript:void(0);send()",
  "javascript:;send()",
  "javascript:void(1)",
  "javascript:void(0)//",
  "javascript:/**/void(0)",
  "javascript:void(0)?x=1",
  "javascript:void(0)#x",
  "javascript:%E0%A4%A",
  "javascript:%73end()",
  "https://member.example.test/session",
  "data:,void(0)",
  "",
  null,
])("does not count %j as a script action that does nothing", (address) => {
  expect(noOpScript(address)).toBe(false);
});

// The destination check's page code and the submission guard judge a script action by one rule.
it("judges a script action by the same rule in the step call and the guard", () => {
  expect(locateCode).toContain(noOpScriptCode);
  expect(submissionGuardCode).toContain(noOpScriptCode);
});
