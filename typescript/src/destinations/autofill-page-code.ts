import { Schema } from "effect";
import { formControlsCode } from "../browser/form-controls.js";
import type { AutofillPopup, DateOfBirthFormat } from "./autofill-contracts.js";
import { elementReadMs, locateCode, questionTextCode } from "./autofill-locate-code.js";
import { clipCode, controlNamingCode } from "./control-naming-code.js";
import { pageCode, primaryPageCode } from "../runtime/host-execute.js";
import { hostOnSiteSource } from "../runtime/same-site.js";
import { submissionGuardCode } from "./autofill-submission-guard.js";
import { pageControlsCode } from "./page-controls.js";

/**
 * Page code: the step's controls and visible native and ARIA actions, for the host and Guardian.
 * The page keeps the controls as found, with every form destination as found, under `observed`.
 */
const inspectCode = `await keep(observed, {
  questions: fields.map(({ described }) => described.questionText ?? null),
  targets: { fields: fields.map(({ target }) => target), submit: submit === null ? null : submit.target },
  destinations: [submit, ...fields].flatMap((found) => found?.destinations ?? []),
});
const buttons = [];
for (const frame of primary.frames()) {
  const candidates = frame.locator('button, input[type="submit"], input[type="button"], input[type="image"], a, [role~="button"], [role~="link"], [role~="menuitem"], [role~="radio"]');
  const count = Math.min(await candidates.count(), 50);
  for (let index = 0; index < count && buttons.length < 20; index++) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    const words = clip(await candidate.evaluate((element) => element.getAttribute("aria-label") ?? (element instanceof HTMLInputElement ? (element.type === "image" ? element.alt : element.value) : element.textContent), undefined, { timeout: ${elementReadMs} }));
    buttons.push(words ?? "(unlabelled button)");
  }
}
return {
  fields: fields.map(({ target, described }) => ({ target, described })),
  submit: submit === null ? null : { target: submit.target, described: submit.described },
  located,
  buttons,
  ...(submitKey === null || submit === null ? {} : { keySubmit: { submitControls: submit.submitControls } }),
  ...(popupTargetId === undefined ? {} : { popupTargetId }),
  url: primary.url(),
};`;

/**
 * One call of a step's fill, after its inspection. None carries a value but a date's: the host
 * types every other value itself over its own DevTools socket, into the field `focus` left focused. `check` names the field the host typed just before, which must now hold
 * something, so typing that went to another element never leads to a click.
 * - `focus`: empties the field when it holds something and focuses it, then reads that it holds
 *   the focus.
 * - `date`: fills a date of birth with the authoring library's `fillDate`, which needs the page's
 *   own options, so this call's code holds the date (`iso`).
 * - `submit`: first reads whether the page sent what was typed itself (`pageSentCode`). Otherwise
 *   it guards the submission as it fires (`submissionGuardCode`, under the host's
 *   `guardKey` and armed for `guardCall`, with every form action and link destination as the
 *   step's inspection found them, which the page kept under `inspection`, the submission's method
 *   as judged, and how each field's secret is found by value, if it is one), reads the page's
 *   alert text, clicks the submit (or, for a step with a submit key, presses that key in its last
 *   field, which stands as the submit),
 *   waits for the page to settle and reads its controls (`pageControlsCode`), with how many of
 *   their alerts did not show before the click (`newAlerts`). A disabled submit it
 *   never clicks: it says so and does nothing, and the host calls again while the page may still
 *   enable it.
 */
export type AutofillFillCall =
  | {
      readonly kind: "focus";
      readonly index: number;
      readonly bindingKey: string;
    }
  | {
      readonly kind: "date";
      readonly index: number;
      readonly iso: string;
      readonly format: DateOfBirthFormat;
    }
  | {
      readonly kind: "submit";
      readonly settleMs: number;
      readonly guardKey: string;
      readonly guardCall: string;
      /** The id the page keeps the step's inspection under. */
      readonly inspection: string | undefined;
      /**
       * Once something was typed before the inspection, the configured origins, whose own scheme
       * and host alone still exempt a secret in place of what the inspection found; else null.
       */
      readonly exempt: readonly string[] | null;
      readonly secretMatch: readonly ("within" | "token" | null)[];
      /** The submit as judged: whether it submits a form at all, and by GET. */
      readonly submitInForm: boolean;
      readonly submitGet: boolean;
      /** Whether each field's own form was judged to submit by GET. */
      readonly fieldGet: readonly boolean[];
      /** Only look: a call that finds the step's fields clicks nothing and answers `none`. */
      readonly look?: true;
    };

/**
 * Page code: when any control differs from the one the host last judged (the submit's `editable`
 * aside, which only follows whether it is disabled, as a submit input's does), which the page kept
 * under `judged`, or the page lost it, does nothing, keeps every control as found under `observed` and
 * hands them back, for the host to judge again by inspection's rule (page code may move a form off
 * the site once values are typed, so each call finds and judges every control again). Otherwise
 * checks the field the host just typed, then runs the call. A field that check cannot read counts
 * as empty, except in the submit call of a step with fields and no submit (`readsOnly`), which only
 * reads the page: there a read that fails, as when the page takes the field away while the call
 * reads it, fails the call, a look the host takes again, and is never a typed field left empty.
 * With no settle wait the host takes no look again, so the failed call stands, and the host reports
 * it as uncertain: what was typed may have been sent.
 */
const fillCallCode = (
  call: AutofillFillCall,
  judgedId: string | undefined,
  check: number | null,
  typedAt: string,
) => `const judgment = await kept(${JSON.stringify(judgedId ?? null)});
const judged = judgment?.targets ?? null;
const questions = fields.map(({ described }) => described.questionText ?? null);
for (let index = 0; index < questionSelectors.length; index++) {
  if (questionSelectors[index] === null) continue;
  if (judgment === null) return { error: "target_changed", target: index, url: primary.url() };
  if (questions[index] !== judgment.questions?.[index])
    return { error: "target_changed", target: index, question: "changed", url: primary.url() };
}
const same = (found, expected, editable = true) =>
  found === null || expected === null
    ? found === expected
    : found.ownerUrl === expected.ownerUrl &&
      JSON.stringify(found.ancestors ?? []) === JSON.stringify(expected.ancestors ?? []) &&
      (found.explicitGet ?? false) === (expected.explicitGet ?? false) &&
      found.documentOrigin === expected.documentOrigin &&
      (!editable || found.editable === expected.editable) &&
      found.control === expected.control &&
      JSON.stringify(found.actions) === JSON.stringify(expected.actions) &&
      JSON.stringify(found.methods) === JSON.stringify(expected.methods) &&
      found.submitMethod === expected.submitMethod;
const found = { fields: fields.map(({ target }) => target), submit: submit === null ? null : submit.target };
if (
  judged === null ||
  found.fields.some((target, index) => !same(target, judged.fields[index] ?? null)) ||
  // A submit the page enables is no change: the submit call reads whether it is disabled itself.
  !same(found.submit, judged.submit, false)
) {
  await keep(observed, { targets: found, questions });
  return { changed: found, located, url: primary.url() };
}
// Where the page was as the host typed each field, kept in the page under the fill's id, so the
// submit call compares against it with no address in its code.
const typedAt = ${JSON.stringify(typedAt)};
const readsOnly = ${JSON.stringify(call.kind === "submit")} && fields.length > 0 && submit === null;
${call.kind === "submit" ? pageSentCode : "await keep(typedAt, primary.url());"}
const check = ${JSON.stringify(check)};
if (check !== null) {
  // Its length only, never its value.
  const holding = fields[check].locator.evaluate(
    (element) => typeof element.value === "string" && element.value.length > 0,
    undefined,
    { timeout: ${elementReadMs} },
  );
  const holds = await (readsOnly ? holding : holding.catch(() => false));
  if (!holds) {
    ${call.kind === "submit" ? "if (await allEmptied()) return { pageSent: true, url: primary.url() };" : ""}
    return { checked: false, url: primary.url() };
  }
}
${fillCallBody(call)}`;

/**
 * Page code for the submit call of a step with fields and no submit, once every field is typed and
 * found as the host judged it: the page sent what was typed itself, as a code widget does on its
 * last box, when its address names another page than the one the host typed the last field on
 * (`typedAt`, by origin and path, so a query or hash the page writes as it goes is no move; a
 * window replaced since keeps no address to compare), or every field is disabled. A step whose
 * fields are gone was sent too; the host reads that from the call's own refusal to find them.
 * `allEmptied`, for the check of the field typed last, reads whether the page emptied every field
 * of such a step of several, as a widget does when it draws its boxes again after the site refused
 * what it sent: the host saw each earlier field hold its value when it typed the next. Lengths
 * only, never a value; a field it cannot read fails the call, as the check's own read does there
 * (`readsOnly`). A step with a submit is the host's to click: a form that locks, moves or
 * redraws itself while it checks what was typed has not sent it, and the submit call waits on it
 * or refuses as before.
 */
const pageSentCode = `const originAndPath = (url) => {
  try {
    const at = new URL(url);
    return at.origin + at.pathname;
  } catch {
    return null;
  }
};
if (readsOnly) {
  const typedPage = await kept(typedAt);
  if (typeof typedPage === "string" && originAndPath(typedPage) !== originAndPath(primary.url()))
    return { pageSent: true, url: primary.url() };
  const fieldsDisabled = await Promise.all(
    fields.map(({ locator }) => locator.isDisabled({ timeout: 1000 }).catch(() => false)),
  );
  if (fieldsDisabled.every(Boolean)) return { pageSent: true, url: primary.url() };
}
const allEmptied = async () => {
  if (fields.length < 2 || !readsOnly) return false;
  for (const { locator } of fields) {
    const empty = await locator.evaluate(
      (element) => typeof element.value === "string" && element.value.length === 0,
      undefined,
      { timeout: ${elementReadMs} },
    );
    if (!empty) return false;
  }
  return true;
};`;

const fillCallBody = (call: AutofillFillCall) => {
  if (call.kind === "focus")
    return `const field = fields[${call.index}].locator;
const fieldLocated = located.fields[${call.index}];
const question = fields[${call.index}].question;
try {
  // Emptied only when it holds something: Playwright clears with a Delete key a page sees.
  if (await field.evaluate((element) => typeof element.value === "string" && element.value.length > 0, undefined, { timeout: ${elementReadMs} }))
    await field.fill("", { timeout: 5000 });
  await field.focus({ timeout: 5000 });
  // Keep this original-node binding in Patchright's isolated world, inaccessible to page code.
  // The tag of the element that holds the focus instead, if another does.
  const activeTag = await field.evaluate((element, [key, questionRequired]) => {
    const active = element.ownerDocument.activeElement;
    if (active !== element) return active === null ? "none" : active.tagName.toLowerCase();
    const binding = { document: element.ownerDocument, frame: element.ownerDocument.defaultView, questionRequired };
    Object.defineProperty(element, key, { value: binding, configurable: true });
    // Transfer the guard through this frame's isolated world; no value is involved.
    if (questionRequired) Object.defineProperty(element.ownerDocument.defaultView, key, { value: binding, configurable: true });
    element.setAttribute(key, "");
    return null;
  }, [${JSON.stringify(call.bindingKey)}, question !== undefined], { timeout: ${elementReadMs} }, true);
  if (activeTag === null && question !== undefined) {
    await question.locator.evaluate((element, { key, text }) => {
      const scope = element.ownerDocument.defaultView;
      const binding = scope[key];
      delete scope[key];
      if (!binding) throw new Error("Question binding unavailable");
      const readQuestionText = ${questionTextCode};
      binding.checkQuestion = () => readQuestionText(element) === text;
    }, { key: ${JSON.stringify(call.bindingKey)}, text: question.text }, { timeout: ${elementReadMs} }, true);
  }
  return activeTag === null
    ? { focused: true, located: fieldLocated, url: primary.url(), document: await documentStart() }
    : { focused: false, unfocused: { activeTag }, located: fieldLocated, url: primary.url() };
} catch (error) {
  const focusError = error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "unknown";
  return { focused: false, unfocused: { focusError }, located: fieldLocated, url: primary.url() };
} finally {
  if (question !== undefined) await field.evaluate((element, key) => {
    delete element.ownerDocument.defaultView[key];
  }, ${JSON.stringify(call.bindingKey)}, { timeout: 1000 }, true).catch(() => undefined);
}`;
  if (call.kind === "date")
    return `try {
  // A date goes into whatever date control the page has, in the format the field takes.
  await fillDate(fields[${call.index}].locator, ${JSON.stringify(call.iso)}, ${JSON.stringify(call.format)}, { timeout: 5000 });
  return { dated: true, url: primary.url(), document: await documentStart() };
} catch {
  return { dated: false, url: primary.url() };
}`;
  return `${call.look === true ? "return { submit: \"none\", url: primary.url() };\n" : ""}if (submit === null) return { submit: "none", url: primary.url() };
// Disabled as Playwright's own click judges it, read where page code cannot redefine the answer.
if (await submit.locator.isDisabled({ timeout: 5000 })) return { submit: "disabled", url: primary.url() };
const guardKey = ${JSON.stringify(call.guardKey)};
const guardCall = ${JSON.stringify(call.guardCall)};
const secretMatch = ${JSON.stringify(call.secretMatch)};
const fieldGet = ${JSON.stringify(call.fieldGet)};
// None once the page lost them: then a secret any action holds is refused, as if none held it before.
const exempt = ${JSON.stringify(call.exempt)};
const inspected =
  exempt ?? (await kept(${JSON.stringify(call.inspection ?? null)}))?.destinations ?? [];
const submitHandle = await submit.locator.elementHandle({ timeout: 5000 });
const submitFrame = await submitHandle.ownerFrame();
const guarded = [];
for (const [index, field] of fields.entries()) {
  const handle = await field.locator.elementHandle({ timeout: 5000 });
  // Only the form the host's click submits, judged GET, submits by GET: the
  // methods as judged, not as read now, which page code could have changed since the recheck.
  const guarding = await handle.evaluate(${submissionGuardCode}, {
    key: guardKey,
    call: guardCall,
    actions: inspected,
    match: secretMatch[index] ?? null,
    submit: (await handle.ownerFrame()) === submitFrame ? submitHandle : null,
    submitInForm: ${JSON.stringify(call.submitInForm)},
    submitGet: ${JSON.stringify(call.submitGet)},
    fieldGet: fieldGet[index] === true,
  });
  if (guarding) guarded.push(handle);
}
// Read through the same handles, so in the guard's own world; a document that left has none.
const refusedSubmission = async () => {
  for (const handle of guarded) {
    const refused = await handle
      .evaluate((field, { key, call }) => {
        const guard = field.ownerDocument.defaultView[key];
        return guard?.call === call ? guard.refused : null;
      }, { key: guardKey, call: guardCall })
      .catch(() => null);
    if (refused) return refused;
  }
  return null;
};
${pageControlsCode}
// The alert text the page shows before the click, so the host counts only what the submit brought.
const alertsBefore = await pageControls(true).then((found) => found.alerts, () => null);
const navigated = primary
  .waitForEvent("framenavigated", { predicate: (frame) => frame === primary.mainFrame(), timeout: ${call.settleMs} })
  .then(() => true, () => false);
try {
  // A submit key goes to the last field, which stands as the submit and submits its own form.
  if (submitKey === null) await submit.locator.click({ timeout: 5000 });
  else await submit.locator.press(submitKey, { timeout: 5000 });
} catch {
  return { submit: "failed", url: primary.url() };
}
let submission = await refusedSubmission();
if (submission === null && (await navigated))
  await primary.waitForLoadState("domcontentloaded", { timeout: ${call.settleMs} }).catch(() => undefined);
submission ??= await refusedSubmission();
if (submission !== null) return { submission, url: primary.url() };
// What the page shows once the submit settled, never a value, for the minter's next step.
const controls = await pageControls().catch(() => null);
const newAlerts =
  controls === null || alertsBefore === null ? null : controls.alerts.filter((text) => !alertsBefore.includes(text)).length;
return {
  submit: "clicked",
  url: primary.url(),
  ...(controls === null ? {} : { controls: newAlerts === null ? controls : { ...controls, newAlerts } }),
};`;
};

/**
 * Page code: `keySubmit` stands a step's last field in as its submit when the step submits with a
 * key: the field's own place and destinations (its form's action and method, every form action and
 * method its controls could submit with), described for Guardian as that form, by its own name,
 * id and label and its method, never a value; and how many submit controls the form shows. A
 * field in no form submits nothing (`submitMethod` null), which the host refuses.
 */
const keySubmitCode = `const keySubmit = async (field) => {
  const form = await field.locator.evaluate((element) => {
    const associated =
      "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
    if (associated === null) return null;
    const controls = Array.from(
      Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements").get.call(associated),
    );
    const submitter = (control) =>
      (control instanceof HTMLButtonElement && control.type === "submit") ||
      (control instanceof HTMLInputElement && ["submit", "image"].includes(control.type));
    const shows = (control) => {
      const box = control.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && control.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    };
    return {
      name: associated.getAttribute("name"),
      id: associated.getAttribute("id"),
      ariaLabel: associated.getAttribute("aria-label"),
      submitControls: controls.filter((control) => submitter(control) && shows(control)).length,
    };
  }, undefined, { timeout: ${elementReadMs} });
  return {
    ...field,
    submitControls: form?.submitControls ?? 0,
    described: {
      tag: "form",
      role: null,
      formMethod: field.target.submitMethod,
      type: null,
      name: clip(form?.name ?? null),
      id: clip(form?.id ?? null),
      autocomplete: null,
      inputmode: null,
      label: null,
      placeholder: null,
      ariaLabel: clip(form?.ariaLabel ?? null),
      text: null,
    },
  };
};`;

/**
 * Page code for a fill call: when the primary page's document began loading, which tells one
 * document from the next. A new document changes it; a pushState, a redraw or a reload of a frame
 * never does. Undefined when the page cannot say, as while it loads.
 */
const documentStartCode = `const documentStart = () =>
  primary.mainFrame().evaluate(() => performance.timeOrigin).catch(() => undefined);`;

/** Resolves only a real child of the stable primary opener, on the recorded origin. */
export const autofillPageCode = (targetId: string, popup: AutofillPopup | undefined) =>
  popup === undefined
    ? primaryPageCode(targetId)
    : `${pageCode(targetId, "opener")}
const popupOrigin = ${JSON.stringify(popup.origin)};
const matches = [];
for (const candidate of context.pages()) {
  if (candidate === opener || candidate.isClosed()) continue;
  if (await candidate.opener() !== opener) continue;
  let origin;
  try { origin = new URL(candidate.url()).origin; } catch { continue; }
  if (origin === popupOrigin) matches.push(candidate);
}
if (matches.length !== 1) return {
  error: matches.length === 0 ? "popup_missing" : "popup_ambiguous", target: "popup"
};
const primary = matches[0];
`;

/**
 * One host call for a step: its inspection, or with `fill`, one call of its fill. What it finds,
 * the page keeps under `observed`; a fill call compares against what it kept under `judged`.
 */
export const autofillStepCode = (
  targetId: string,
  step: {
    readonly fields: readonly {
      readonly selector: string;
      readonly slot?: string | undefined;
      readonly questionSelector?: string | undefined;
    }[];
    readonly submit?: string | undefined;
    readonly submitKey?: string | undefined;
    readonly popup?: AutofillPopup | undefined;
  },
  observed: string,
  fill?: {
    readonly popupTargetId?: string | undefined;
    readonly call: AutofillFillCall;
    readonly judged: string | undefined;
    readonly check: number | null;
    /** The fill's id for where the page was as each field was typed. */
    readonly typedAt: string;
  },
) => `${autofillPageCode(targetId, step.popup)}
let popupTargetId;
${
  step.popup === undefined
    ? ""
    : `const authTargetSession = await context.newCDPSession(primary);
try { popupTargetId = (await authTargetSession.send("Target.getTargetInfo")).targetInfo.targetId; }
finally { await authTargetSession.detach(); }
${fill === undefined ? "" : `if (popupTargetId !== ${JSON.stringify(fill.popupTargetId)}) return {error:"target_changed", target:"popup"};`}`
}
${formControlsCode}
${locateCode}
${fill === undefined ? "" : documentStartCode}
const observed = ${JSON.stringify(observed)};
const selectors = ${JSON.stringify(step.fields.map((field) => field.selector))};
const questionSelectors = ${JSON.stringify(step.fields.map((field) => field.slot === "private_answer" ? field.questionSelector ?? null : null))};
const fields = [];
for (let index = 0; index < selectors.length; index++) {
  const found = await locate(selectors[index], questionSelectors[index]);
  if ("error" in found)
    return { ...found, target: index, url: primary.url()${fill?.call.kind === "submit" ? ", document: await documentStart()" : ""} };
  fields.push(found);
}
const submitSelector = ${JSON.stringify(step.submit ?? null)};
const submitKey = ${JSON.stringify(step.submitKey ?? null)};
${keySubmitCode}
const submit =
  submitKey !== null && fields.length > 0
    ? await keySubmit(fields[fields.length - 1])
    : submitSelector === null
      ? null
      : await locate(submitSelector);
if (submit !== null && "error" in submit) return { ...submit, target: "submit", url: primary.url() };
// An inert submit takes no interaction at all, so nothing is typed for it. A disabled one may be
// enabled once the fields hold input; the submit call never clicks it while it is disabled.
if (submit !== null && submit.inert)
  return { error: "not_editable", target: "submit", located: submit.located, url: primary.url() };
const located = { fields: fields.map((field) => field.located), submit: submit === null ? null : submit.located };
${fill === undefined ? inspectCode : fillCallCode(fill.call, fill.judged, fill.check, fill.typedAt)}`;

/** What named a control when the host inspected it, each as `clip` keeps it. */
export interface ControlIdentity {
  readonly label: string | null;
  readonly ariaLabel: string | null;
  readonly placeholder: string | null;
  readonly type: string | null;
  readonly autocomplete: string | null;
  readonly name: string | null;
  readonly id: string | null;
}

/** What `autofillSignedInCode` answers. */
export const SignedInPage = Schema.Struct({
  url: Schema.String,
  indicator: Schema.NullOr(Schema.Boolean),
  passwordVisible: Schema.Boolean,
  challengeFormVisible: Schema.Boolean,
});

/**
 * Page code: whether a recorded challenge field still asks. A selector counts only where it
 * matches the same control the host inspected (`sameControl`), one that shows and takes typing, in
 * a frame on the site or a configured sign-in origin whose every frame above it shows. A control
 * or frame the host cannot read in time, such as one that detaches during the check, shows nothing.
 */
const signedInChallengeFormCode = `
${clipCode}
/** How long the host waits to read one control's naming. */
const namingLimitMs = 1500;
// A call that does not answer within the limit fails, whether it waits for a control that
// detached or the page keeps it busy.
const withinLimit = (call) => {
  let timer;
  const expiry = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out")), namingLimitMs);
  });
  return Promise.race([call, expiry]).finally(() => clearTimeout(timer));
};
// The same words name it as named the recorded field, with its type, autocomplete, name and id
// where inspection recorded one. An id or name generated on each render, such as ":r3:" or
// "mat-input-3", differs once the page renders the control again, so that control shows nothing.
const sameControl = async (control, identity) => {
  const named = await withinLimit(control.evaluate((element) => {
    ${controlNamingCode}
    return controlNaming(element);
  }, undefined, { timeout: namingLimitMs }));
  const found = Object.fromEntries(Object.entries(named).map(([key, value]) => [key, clip(value)]));
  return ["label", "ariaLabel", "placeholder"].every((key) => found[key] === identity[key]) &&
    ["type", "autocomplete", "name", "id"].every((key) => identity[key] === null || found[key] === identity[key]);
};
// A frame's own address, or for an about:blank or about:srcdoc frame, the first one above it with
// a real address, as locate reads where a control sits.
const frameAddress = (frame) => {
  let scope = frame;
  while (scope !== null && ["about:blank", "about:srcdoc"].includes(scope.url())) scope = scope.parentFrame();
  return scope === null ? "" : scope.url();
};
const challengeOrigin = (frame) => {
  let url;
  try {
    url = new URL(frameAddress(frame));
  } catch {
    return false;
  }
  return onSiteHost(url.hostname) || authenticationOrigins.includes(url.origin);
};
// The frame and every frame above it show, as a question's frames are read.
const frameShows = async (frame) => {
  for (let scope = frame; scope.parentFrame() !== null; scope = scope.parentFrame())
    if (!(await (await scope.frameElement()).isVisible())) return false;
  return true;
};
// A read-only or disabled control takes no typing, and one that is no form control throws.
const takesTyping = (control) => control.isEditable({ timeout: 1000 }).catch(() => false);
// A control the host cannot read shows nothing: a check that cannot tell does not fail.
const stillAsks = async (control, identity) => {
  try {
    return (await control.isVisible()) && (await takesTyping(control)) && (await sameControl(control, identity));
  } catch {
    return false;
  }
};
const recordedChallengeVisible = async (fields) => {
  if (fields.length === 0) return false;
  for (const frame of primary.frames()) {
    try {
      if (!challengeOrigin(frame) || !(await frameShows(frame))) continue;
      for (const { selector, identity } of fields) {
        const located = frame.locator(selector);
        const count = Math.min(await located.count(), 100);
        for (let index = 0; index < count; index++)
          if (await stillAsks(located.nth(index), identity)) return true;
      }
    } catch {
      // A frame the host cannot read, such as one that detaches during the check, shows nothing.
      continue;
    }
  }
  return false;
};`;

/**
 * One host call: the page URL, whether the indicator is visible in a frame on the site (its host
 * `siteHost` or a subdomain of it on the same site, as `hostOnSiteSource` reads it), and whether a
 * password field of the sign-in's own shows in any frame: one of its fields (`signInFields`, by
 * selector), or one in the form of a visible one. Another form's password field, such as a
 * change-password form or an inner service's login,
 * does not count unless one of those selectors matches in it. A hidden match, such as the username
 * a change-password form keeps for password managers, is no sign-in form showing. With no
 * `signInFields`, any visible password field counts. A recorded challenge field
 * (`challengeFields`, each with the identity the host inspected) still asks as
 * `signedInChallengeFormCode` reads it, on the site or one of `authenticationOrigins`. Both come
 * after `popups` and default to none, so a caller that passes no challenge fields gets no
 * challenge check.
 */
export const autofillSignedInCode = (
  targetId: string,
  selector: string | undefined,
  siteHost: string,
  signInFields: readonly string[],
  popups: readonly AutofillPopup[] = [],
  challengeFields: readonly {
    readonly selector: string;
    readonly identity: ControlIdentity;
  }[] = [],
  authenticationOrigins: readonly string[] = [],
) =>
  `${primaryPageCode(targetId)}
const popupOrigins = ${JSON.stringify(popups.map((popup) => popup.origin))};
for (const candidate of context.pages()) {
  if (candidate === primary || candidate.isClosed() || await candidate.opener() !== primary) continue;
  let origin;
  try { origin = new URL(candidate.url()).origin; } catch { continue; }
  if (popupOrigins.includes(origin)) return { url: primary.url(), indicator: false, passwordVisible: false, challengeFormVisible: false };
}
const onSiteHost = ${hostOnSiteSource(siteHost)};
const onSite = (frame) => {
  let host = "";
  try {
    host = new URL(frame.url()).hostname;
  } catch {
    return false;
  }
  return onSiteHost(host);
};
const authenticationOrigins = ${JSON.stringify(authenticationOrigins)};
const visibleIn = async (selector, scopes) => {
  for (const scope of scopes) {
    const located = scope.locator(selector);
    const count = Math.min(await located.count(), 100);
    for (let index = 0; index < count; index++)
      if (await located.nth(index).isVisible()) return true;
  }
  return false;
};
${signedInChallengeFormCode}
const password = 'input[type="password"]';
// The field itself, or a control of its form as locate reads the form (its form attribute too),
// that is a password field and shows: a box with an area, and not hidden.
const passwordInForm = (element, matched) => {
  const form =
    "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
  const controls = form
    ? Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements").get.call(form))
    : [element];
  return controls.some((control) => {
    const box = control.getBoundingClientRect();
    return (
      control.matches(matched) &&
      box.width > 0 &&
      box.height > 0 &&
      control.checkVisibility({ visibilityProperty: true })
    );
  });
};
const signInPasswordVisible = async (selectors) => {
  for (const frame of primary.frames())
    for (const fieldSelector of selectors) {
      const located = frame.locator(fieldSelector);
      const count = Math.min(await located.count(), 100);
      for (let index = 0; index < count; index++) {
        const field = located.nth(index);
        if (!(await field.isVisible())) continue;
        if (await field.evaluate(passwordInForm, password)) return true;
      }
    }
  return false;
};
const selector = ${JSON.stringify(selector ?? null)};
const signInFields = ${JSON.stringify(signInFields)};
const challengeFields = ${JSON.stringify(challengeFields)};
const siteFrames = primary.frames().filter(onSite);
return {
  url: primary.url(),
  indicator: selector === null ? null : await visibleIn(selector, siteFrames),
  challengeFormVisible: await recordedChallengeVisible(challengeFields),
  // With no field of the sign-in's own to go by, any password field on the page still counts.
  passwordVisible:
    signInFields.length === 0
      ? popupOrigins.length === 0 && await visibleIn(password, primary.frames())
      : await signInPasswordVisible(signInFields),
};`;
