/**
 * Review gate, run by .github/workflows/review-gate.yml. It posts the `review/clear` check run that
 * the ruleset on main requires, for pull requests whose author isn't a maintainer, from the review
 * CodeRabbit leaves on GitHub. A maintainer's own pull request gets its `review/clear` from the
 * independent review as before, and the gate leaves it alone.
 *
 * A maintainer is a user .github/CODEOWNERS lists who also has write permission, as in the approval
 * gate. For any other author's pull request into the default branch, the gate decides one of:
 *
 * - Maintainer review (`action_required`): the pull request changes a path .github/review-gate.json
 *   lists, changes more lines than it allows, CodeRabbit rates the merge risk above what it allows,
 *   or the gate can't read CodeRabbit's verdict. A maintainer then reviews it and posts
 *   `review/clear` with `review:clear`, which the gate never overwrites.
 * - Waiting (`in_progress`): the pull request is a draft, or CodeRabbit hasn't reviewed its head
 *   commit yet.
 * - BLOCK (`failure`): CodeRabbit's review of the head commit left a finding at a blocking severity
 *   open, or a pre-merge check errored.
 * - CLEAR (`success`): CodeRabbit reviewed the head commit and left nothing blocking.
 *
 * CodeRabbit records the commit its review covers in a marker in its walkthrough comment, including
 * when it carries a review across a merge of the base branch. The gate counts only comments and
 * review threads that CodeRabbit's bot account wrote, and never its approval, its commit status or
 * a thread resolution CodeRabbit makes on someone's command, since others can trigger those. A
 * finding stops blocking once CodeRabbit marks it addressed in a later commit, or once a code owner
 * resolves its thread.
 *
 * The `Approval` check still needs a code owner's approval of the head commit, so a CLEAR alone never
 * merges an outside contributor's pull request.
 *
 * The workflow runs this file from the default branch, never from a pull request, with the policy
 * and CODEOWNERS as they are there. It reads each fact from GitHub's API.
 *
 * Usage, in the workflow: node tools/review-gate.ts
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createClient, parseCodeOwners } from "./approval-gate.ts";

/** The check run name the ruleset requires, from the reviewer GitHub App. */
export const checkName = "review/clear";

const writeRoles = new Set(["admin", "maintain", "write"]);
/** Findings and paths a check run's summary lists before it counts the rest. */
const listLimit = 20;

export interface GitHub {
  /** One REST resource, or undefined when GitHub answers 404. */
  readonly get: (path: string) => Promise<unknown>;
  /** Every item of a paginated REST list. */
  readonly list: (path: string) => Promise<readonly unknown[]>;
  /** A REST or GraphQL POST. */
  readonly post: (path: string, body: unknown) => Promise<unknown>;
  readonly patch: (path: string, body: unknown) => Promise<unknown>;
}

/** .github/review-gate.json. */
export interface Policy {
  /** The reviewer's bot account, as REST names it. */
  readonly reviewer: string;
  /** The lane the gate's check runs name, which tells them apart from a maintainer's. */
  readonly lane: string;
  /** Coverage kinds in CodeRabbit's marker that count as a review of the commit they cover. */
  readonly coverageKinds: readonly string[];
  /** Finding severities that block until addressed. */
  readonly blockingSeverities: readonly string[];
  /** Merge risk labels the gate may CLEAR. Any other label needs a maintainer. */
  readonly clearMergeRisks: readonly string[];
  readonly maintainerReview: {
    readonly maxChangedLines: number;
    /** Globs over repository paths: `*` stays within a folder, `**` crosses folders. */
    readonly paths: readonly string[];
  };
}

export type Outcome =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "wait" | "maintainer" | "block" | "clear";
      readonly title: string;
      readonly summary: string;
    };

interface PullRequest {
  readonly number: number;
  readonly state: string;
  readonly draft?: boolean;
  readonly user: { readonly login: string };
  readonly head: { readonly sha: string };
  readonly base: { readonly ref: string };
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
}

interface ChangedFile {
  readonly filename: string;
  readonly previous_filename?: string;
}

interface IssueComment {
  readonly user: { readonly login: string; readonly type: string } | null;
  readonly body?: string | null;
  readonly updated_at: string;
}

interface CheckRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly external_id: string | null;
  readonly output: { readonly title: string | null; readonly summary: string | null };
}

export interface ReviewThread {
  readonly isResolved: boolean;
  readonly resolvedBy: { readonly login: string } | null;
  readonly path: string;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly comments: {
    readonly nodes: readonly {
      readonly author: { readonly __typename: string; readonly login: string } | null;
      readonly body: string;
      readonly url: string;
    }[];
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");

/** Reads .github/review-gate.json, or throws naming what is wrong with it. */
export const parsePolicy = (text: string): Policy => {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error("The review gate policy must be a JSON object.");
  const { reviewer, lane, coverageKinds, blockingSeverities, clearMergeRisks, maintainerReview } = value;
  if (typeof reviewer !== "string" || !/^[\w-]+\[bot\]$/.test(reviewer)) {
    throw new Error("The review gate policy's reviewer must be a bot account such as name[bot].");
  }
  if (typeof lane !== "string" || lane === "" || /[;=]/.test(lane)) {
    throw new Error("The review gate policy's lane must be a name without ; or =.");
  }
  for (const [name, list] of Object.entries({ coverageKinds, blockingSeverities, clearMergeRisks })) {
    if (!isStringList(list) || list.length === 0) {
      throw new Error(`The review gate policy's ${name} must be a list of names.`);
    }
  }
  if (!isObject(maintainerReview)) throw new Error("The review gate policy needs maintainerReview.");
  const { maxChangedLines, paths } = maintainerReview;
  if (typeof maxChangedLines !== "number" || !Number.isInteger(maxChangedLines) || maxChangedLines < 1) {
    throw new Error("The review gate policy's maintainerReview.maxChangedLines must be a positive whole number.");
  }
  if (!isStringList(paths)) throw new Error("The review gate policy's maintainerReview.paths must be a list of globs.");
  return {
    reviewer,
    lane,
    coverageKinds: coverageKinds as string[],
    blockingSeverities: blockingSeverities as string[],
    clearMergeRisks: clearMergeRisks as string[],
    maintainerReview: { maxChangedLines, paths },
  };
};

/** A matcher for repository paths. Each glob matches whole paths from the repository root. */
export const pathMatcher = (globs: readonly string[]): ((path: string) => boolean) => {
  const expressions = globs.map((glob) => {
    let source = "";
    for (let index = 0; index < glob.length; index += 1) {
      const rest = glob.slice(index);
      if (rest.startsWith("**/")) {
        source += "(?:.*/)?";
        index += 2;
      } else if (rest.startsWith("/**") && rest.length === 3) {
        source += "(?:/.*)?";
        index += 2;
      } else if (rest.startsWith("**")) {
        source += ".*";
        index += 1;
      } else if (rest[0] === "*") source += "[^/]*";
      else if (rest[0] === "?") source += "[^/]";
      else source += (rest[0] ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`);
  });
  return (path) => expressions.some((expression) => expression.test(path));
};

/** The reviewer's login as GraphQL names a bot, without the `[bot]` REST adds. */
const graphLogin = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");

/** The text between CodeRabbit's `<!-- name_start -->` and `<!-- name_end -->` markers. */
const sections = (body: string, name: string): string[] =>
  [...body.matchAll(new RegExp(`<!-- ${name}_start -->([\\s\\S]*?)<!-- ${name}_end -->`, "g"))].map(
    (match) => match[1] ?? "",
  );

export interface Coverage {
  /** The commit the latest review covers. */
  readonly commit: string;
  readonly kind: string;
  /** The merge risk label, such as Minimal, when the walkthrough has one. */
  readonly mergeRisk: string | undefined;
  /** Pre-merge checks the walkthrough reports as errors. */
  readonly erroredChecks: readonly string[];
}

/**
 * What CodeRabbit's walkthrough says it covered, from the newest comment its bot account wrote that
 * carries a coverage marker. It is undefined when there is none yet, and a string saying what is
 * wrong when the comment can't be read with confidence.
 */
export const readCoverage = (comments: readonly IssueComment[], reviewer: string): Coverage | string | undefined => {
  const marker = /<!-- final_review_risk_coverage:(\{[^}]*\}) -->/g;
  const written = comments
    .filter((comment) => comment.user?.login === reviewer && comment.user.type === "Bot")
    .filter((comment) => (comment.body ?? "").includes("final_review_risk_coverage:"))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  const body = written[0]?.body;
  if (body === undefined || body === null) return undefined;
  const markers = [...body.matchAll(marker)];
  if (markers.length !== 1) return `its walkthrough has ${markers.length} coverage markers, not one`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(markers[0]?.[1] ?? "");
  } catch {
    return "its coverage marker isn't JSON";
  }
  if (!isObject(parsed) || typeof parsed["coveredCommitId"] !== "string" || typeof parsed["kind"] !== "string") {
    return "its coverage marker names no covered commit";
  }
  const risk = sections(body, "final_review_risk")
    .map((section) => /\*\*Merge Risk:\*\*\s*\*\*(?:[^\s*]+\s+)?([A-Za-z]+)\*\*/.exec(section)?.[1])
    .find((label) => label !== undefined);
  const erroredChecks = sections(body, "pre_merge_checks_walkthrough").flatMap((section) =>
    section
      .split("\n")
      .map((line) => /^\|\s*(.+?)\s*\|\s*!\[Error\]\(/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  return { commit: parsed["coveredCommitId"], kind: parsed["kind"], mergeRisk: risk, erroredChecks };
};

/** A review comment's severity label, such as Major, or undefined when it has none. */
export const severityOf = (body: string): string | undefined =>
  /(?:🔴|🟠|🟡|🔵|⚪)️?\s*[*_]{0,2}\s*(Critical|Major|Minor|Trivial|Info)(?![A-Za-z])/u.exec(body)?.[1];

export interface Finding {
  readonly severity: string | undefined;
  readonly location: string;
  readonly url: string;
}

/**
 * The reviewer's open findings: those at a blocking severity, and those whose severity the gate
 * can't read. A finding is closed once the reviewer marks it addressed in a later commit, or once a
 * code owner resolves its thread.
 */
export const openFindings = (
  threads: readonly ReviewThread[],
  policy: Policy,
  codeOwners: ReadonlySet<string>,
): { readonly blocking: readonly Finding[]; readonly unreadable: readonly Finding[] } => {
  const blocking: Finding[] = [];
  const unreadable: Finding[] = [];
  const blockingSeverities = new Set(policy.blockingSeverities);
  for (const thread of threads) {
    const first = thread.comments.nodes[0];
    if (first?.author?.__typename !== "Bot" || graphLogin(first.author.login) !== graphLogin(policy.reviewer)) continue;
    if (/✅ Addressed in commits?\b/u.test(first.body)) continue;
    if (thread.isResolved && codeOwners.has((thread.resolvedBy?.login ?? "").toLowerCase())) continue;
    const severity = severityOf(first.body);
    const line = thread.line ?? thread.originalLine;
    const finding = { severity, location: line === null ? thread.path : `${thread.path}:${line}`, url: first.url };
    if (severity === undefined) unreadable.push(finding);
    else if (blockingSeverities.has(severity)) blocking.push(finding);
  }
  return { blocking, unreadable };
};

const short = (sha: string) => sha.slice(0, 7);

const listed = (items: readonly string[]) => {
  const shown = items.slice(0, listLimit).join("\n");
  return items.length > listLimit ? `${shown}\n- and ${items.length - listLimit} more` : shown;
};

const rateLimitHint =
  "If CodeRabbit skipped the review or reached its rate limit, a maintainer can comment `@coderabbitai review` on the pull request.";

export interface Context {
  readonly repo: string;
  readonly defaultBranch: string;
  readonly policy: Policy;
  /** Lowercased users CODEOWNERS lists. */
  readonly codeOwners: readonly string[];
}

const reviewThreadsQuery = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          resolvedBy { login }
          path
          line
          originalLine
          comments(first: 1) { nodes { author { __typename login } body url } }
        }
      }
    }
  }
}`;

/** Every review thread on a pull request, from GraphQL, which REST doesn't expose. */
export const reviewThreads = async (github: GitHub, repo: string, number: number): Promise<ReviewThread[]> => {
  const [owner, name] = repo.split("/");
  const threads: ReviewThread[] = [];
  let after: string | null = null;
  for (;;) {
    const answer = (await github.post("/graphql", {
      query: reviewThreadsQuery,
      variables: { owner, name, number, after },
    })) as {
      readonly data?: {
        readonly repository: {
          readonly pullRequest: {
            readonly reviewThreads: {
              readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
              readonly nodes: readonly ReviewThread[];
            };
          } | null;
        } | null;
      };
      readonly errors?: readonly { readonly message: string }[];
    };
    if (answer.errors !== undefined && answer.errors.length > 0) {
      throw new Error(`GitHub's GraphQL API refused the review threads: ${answer.errors.map((error) => error.message).join("; ")}`);
    }
    const page = answer.data?.repository?.pullRequest?.reviewThreads;
    if (page === undefined) throw new Error(`GitHub's GraphQL API returned no review threads for pull request ${number}.`);
    threads.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
};

/** A maintainer, as in the approval gate: a code owner who has write permission. */
const maintainerCheck = (github: GitHub, context: Context) => {
  const owners = new Set(context.codeOwners);
  const known = new Map<string, Promise<boolean>>();
  return (login: string): Promise<boolean> => {
    const key = login.toLowerCase();
    if (!owners.has(key)) return Promise.resolve(false);
    let answer = known.get(key);
    if (answer === undefined) {
      answer = (async () => {
        const body = (await github.get(
          `/repos/${context.repo}/collaborators/${encodeURIComponent(login)}/permission`,
        )) as { readonly permission?: string } | undefined;
        return body?.permission !== undefined && writeRoles.has(body.permission);
      })();
      known.set(key, answer);
    }
    return answer;
  };
};

/** Decides the review gate's verdict on one pull request's head commit. */
export const evaluate = async (
  github: GitHub,
  context: Context,
  pull: PullRequest,
  isMaintainer: (login: string) => Promise<boolean>,
  openPulls: readonly PullRequest[],
): Promise<Outcome> => {
  const { policy, repo } = context;
  const head = pull.head.sha;
  if (pull.state !== "open") return { kind: "skip", reason: "it isn't open" };
  if (pull.base.ref !== context.defaultBranch) {
    return { kind: "skip", reason: `it targets ${pull.base.ref}, not ${context.defaultBranch}` };
  }
  if (await isMaintainer(pull.user.login)) {
    return { kind: "skip", reason: "a maintainer opened it, so the independent review clears it" };
  }
  // A check run belongs to a commit. A maintainer's pull request at the same commit owns its verdict.
  for (const other of openPulls) {
    if (other.number !== pull.number && other.head.sha === head && (await isMaintainer(other.user.login))) {
      return { kind: "skip", reason: `maintainer's pull request ${other.number} is at the same commit` };
    }
  }
  if (pull.draft === true) {
    return {
      kind: "wait",
      title: "Waiting for the pull request to leave draft",
      summary: "CodeRabbit reviews this pull request once it is ready for review, and the gate posts `review/clear` from that review.",
    };
  }

  const files = (await github.list(`/repos/${repo}/pulls/${pull.number}/files`)) as ChangedFile[];
  const reviewedByMaintainer = pathMatcher(policy.maintainerReview.paths);
  const sensitive = [
    ...new Set(
      files
        .flatMap((file) => [file.filename, file.previous_filename])
        .filter((path): path is string => path !== undefined && reviewedByMaintainer(path)),
    ),
  ];
  if (sensitive.length > 0) {
    return {
      kind: "maintainer",
      title: "A maintainer reviews this pull request",
      summary: `It changes files that a maintainer reviews in person, as \`.github/review-gate.json\` lists:\n\n${listed(sensitive.map((path) => `- \`${path}\``))}\n\nCodeRabbit's review still helps. A maintainer posts \`review/clear\` once they have reviewed it.`,
    };
  }
  if (files.length < pull.changed_files) {
    return {
      kind: "maintainer",
      title: "A maintainer reviews this pull request",
      summary: `It changes ${pull.changed_files} files, more than GitHub lists for the gate to check. A maintainer posts \`review/clear\` once they have reviewed it.`,
    };
  }
  const changedLines = pull.additions + pull.deletions;
  if (changedLines > policy.maintainerReview.maxChangedLines) {
    return {
      kind: "maintainer",
      title: "A maintainer reviews this pull request",
      summary: `It changes ${changedLines} lines, more than the ${policy.maintainerReview.maxChangedLines} that the automated review covers. A maintainer posts \`review/clear\` once they have reviewed it.`,
    };
  }

  const comments = (await github.list(`/repos/${repo}/issues/${pull.number}/comments`)) as IssueComment[];
  const coverage = readCoverage(comments, policy.reviewer);
  if (typeof coverage === "string") {
    return {
      kind: "maintainer",
      title: "A maintainer reviews this pull request",
      summary: `The gate couldn't read CodeRabbit's verdict: ${coverage}. A maintainer posts \`review/clear\` once they have reviewed it.`,
    };
  }
  if (coverage === undefined) {
    return {
      kind: "wait",
      title: `Waiting for CodeRabbit's review of ${short(head)}`,
      summary: `CodeRabbit hasn't reviewed \`${head}\` yet. The gate checks again when it does. ${rateLimitHint}`,
    };
  }
  if (coverage.commit !== head) {
    return {
      kind: "wait",
      title: `Waiting for CodeRabbit's review of ${short(head)}`,
      summary: `CodeRabbit last reviewed \`${coverage.commit}\`, not the head commit \`${head}\`. The gate checks again when it reviews the head. ${rateLimitHint}`,
    };
  }
  if (!policy.coverageKinds.includes(coverage.kind)) {
    return {
      kind: "maintainer",
      title: "A maintainer reviews this pull request",
      summary: `CodeRabbit's last pass over \`${head}\` was \`${coverage.kind}\`, which the gate doesn't count as a review. A maintainer posts \`review/clear\` once they have reviewed it.`,
    };
  }
  if (coverage.mergeRisk !== undefined && !policy.clearMergeRisks.includes(coverage.mergeRisk)) {
    return {
      kind: "maintainer",
      title: "A maintainer reviews this pull request",
      summary: `CodeRabbit rates the merge risk of \`${head}\` ${coverage.mergeRisk}, above what the gate clears on its own. A maintainer posts \`review/clear\` once they have reviewed it.`,
    };
  }

  const { blocking, unreadable } = openFindings(
    await reviewThreads(github, repo, pull.number),
    policy,
    new Set(context.codeOwners),
  );
  if (unreadable.length > 0) {
    return {
      kind: "maintainer",
      title: "A maintainer reviews this pull request",
      summary: `The gate couldn't read the severity of these CodeRabbit findings:\n\n${listed(unreadable.map((finding) => `- [${finding.location}](${finding.url})`))}\n\nA maintainer posts \`review/clear\` once they have reviewed it.`,
    };
  }
  if (blocking.length > 0 || coverage.erroredChecks.length > 0) {
    const lines = [
      ...blocking.map((finding) => `- ${finding.severity ?? ""}: [${finding.location}](${finding.url})`),
      ...coverage.erroredChecks.map((name) => `- Pre-merge check errored: ${name}`),
    ];
    const count = lines.length;
    return {
      kind: "block",
      title: `CodeRabbit found ${count} blocking ${count === 1 ? "issue" : "issues"}`,
      summary: `CodeRabbit's review of \`${head}\` left these open:\n\n${listed(lines)}\n\nFix them and push. CodeRabbit marks a finding addressed when a later commit fixes it, and the gate checks again. A maintainer can resolve a finding that doesn't apply.`,
    };
  }
  return {
    kind: "clear",
    title: `CLEAR from ${policy.lane}, round 1`,
    summary: `CodeRabbit reviewed \`${head}\` and left no open ${policy.blockingSeverities.join(" or ")} finding. A later commit needs its own \`${checkName}\`. A code owner still approves the pull request under \`Approval\`.`,
  };
};

/** The newest `review/clear` check run the reviewer App posted on `sha`, if any. */
const latestCheck = async (github: GitHub, repo: string, sha: string, appId: string): Promise<CheckRun | undefined> => {
  const answer = (await github.get(
    `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&app_id=${appId}&filter=all&per_page=100`,
  )) as { readonly check_runs?: readonly CheckRun[] } | undefined;
  return [...(answer?.check_runs ?? [])].sort((left, right) => right.id - left.id)[0];
};

const conclusions = { block: "failure", clear: "success", maintainer: "action_required" } as const;

export interface Posted {
  readonly pull: number;
  readonly head: string;
  readonly outcome: Outcome;
  /**
   * What happened to the check run: posted anew, the gate's own waiting check updated in place,
   * already standing, or left to a maintainer's verdict.
   */
  readonly action: "posted" | "updated" | "unchanged" | "maintainer-verdict" | "skipped";
}

/** Evaluates one pull request and posts its verdict when it differs from the one standing. */
export const gatePull = async (
  github: GitHub,
  context: Context,
  number: number,
  appId: string,
  detailsUrl: string,
  isMaintainer: (login: string) => Promise<boolean>,
  openPulls: readonly PullRequest[],
): Promise<Posted | undefined> => {
  const pull = (await github.get(`/repos/${context.repo}/pulls/${number}`)) as PullRequest | undefined;
  if (pull === undefined) return undefined;
  const head = pull.head.sha;
  const outcome = await evaluate(github, context, pull, isMaintainer, openPulls);
  if (outcome.kind === "skip") return { pull: number, head, outcome, action: "skipped" };
  const lane = `lane=${context.policy.lane};round=1`;
  const standing = await latestCheck(github, context.repo, head, appId);
  if (standing !== undefined && standing.external_id !== lane) {
    return { pull: number, head, outcome, action: "maintainer-verdict" };
  }
  const status = outcome.kind === "wait" ? "in_progress" : "completed";
  const conclusion = outcome.kind === "wait" ? null : conclusions[outcome.kind];
  if (
    standing !== undefined &&
    standing.status === status &&
    standing.conclusion === conclusion &&
    standing.output.title === outcome.title &&
    standing.output.summary === outcome.summary
  ) {
    return { pull: number, head, outcome, action: "unchanged" };
  }
  const check = {
    status,
    ...(conclusion === null ? {} : { conclusion }),
    external_id: lane,
    details_url: detailsUrl,
    output: { title: outcome.title, summary: outcome.summary },
  };
  // The gate's own check that still waits is finished in place, so the commit never shows a stale
  // `review/clear` in progress beside the verdict.
  if (standing !== undefined && standing.status !== "completed") {
    await github.patch(`/repos/${context.repo}/check-runs/${standing.id}`, check);
    return { pull: number, head, outcome, action: "updated" };
  }
  await github.post(`/repos/${context.repo}/check-runs`, { name: checkName, head_sha: head, ...check });
  return { pull: number, head, outcome, action: "posted" };
};

/** The pull requests an event asks the gate to evaluate. */
export const pullsToEvaluate = (eventName: string, event: unknown, openPulls: readonly PullRequest[]): number[] => {
  // The event only points at what to evaluate. The verdict comes from the API.
  if (eventName === "pull_request_target") {
    return [(event as { readonly pull_request: { readonly number: number } }).pull_request.number];
  }
  // The reviewer wrote or edited a comment on a pull request.
  if (eventName === "issue_comment") {
    const issue = (event as { readonly issue: { readonly number: number; readonly pull_request?: unknown } }).issue;
    return issue.pull_request === undefined ? [] : [issue.number];
  }
  // A review was submitted or dismissed. The marker workflow's run names the head commit it ran for.
  if (eventName === "workflow_run") {
    const sha = (event as { readonly workflow_run: { readonly head_sha: string } }).workflow_run.head_sha;
    return openPulls.filter((pull) => pull.head.sha === sha).map((pull) => pull.number);
  }
  // A maintainer's dispatch evaluates one pull request, or every open one.
  if (eventName === "workflow_dispatch") {
    const input = (event as { readonly inputs?: { readonly pull_request?: string } }).inputs?.pull_request ?? "";
    if (input.trim() === "") return openPulls.map((pull) => pull.number);
    if (!/^[1-9]\d*$/.test(input.trim())) throw new Error(`The pull_request input must be a number, not ${input}.`);
    return [Number(input.trim())];
  }
  throw new Error(`The review gate doesn't handle ${eventName} events.`);
};

/** Runs the gate for an event: evaluates each pull request it names and posts the verdicts. */
export const runGate = async (
  github: GitHub,
  context: Context,
  eventName: string,
  event: unknown,
  appId: string,
  detailsUrl: string,
): Promise<Posted[]> => {
  const openPulls = (await github.list(`/repos/${context.repo}/pulls?state=open`)) as PullRequest[];
  const isMaintainer = maintainerCheck(github, context);
  const results: Posted[] = [];
  for (const number of pullsToEvaluate(eventName, event, openPulls)) {
    const result = await gatePull(github, context, number, appId, detailsUrl, isMaintainer, openPulls);
    if (result !== undefined) results.push(result);
  }
  return results;
};

const describe = (result: Posted) => {
  const what = result.outcome.kind === "skip" ? `skipped, since ${result.outcome.reason}` : `${result.outcome.kind}: ${result.outcome.title}`;
  const action = {
    posted: "Posted.",
    updated: "Updated the waiting check.",
    unchanged: "Already standing.",
    "maintainer-verdict": "A maintainer's verdict stands, so nothing was posted.",
    skipped: "",
  }[result.action];
  return `Pull request ${result.pull} at ${result.head}: ${what}. ${action}`.trim();
};

const main = async (): Promise<void> => {
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set.`);
    return value;
  };
  const repo = env("GITHUB_REPOSITORY");
  const github = createClient(env("REVIEW_APP_TOKEN"), env("GITHUB_API_URL"));
  const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as unknown;
  const repository = (await github.get(`/repos/${repo}`)) as { readonly default_branch: string };
  const context: Context = {
    repo,
    defaultBranch: repository.default_branch,
    policy: parsePolicy(readFileSync(".github/review-gate.json", "utf8")),
    codeOwners: parseCodeOwners(readFileSync(".github/CODEOWNERS", "utf8")),
  };
  const detailsUrl = `${env("GITHUB_SERVER_URL")}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const results = await runGate(github, context, env("GITHUB_EVENT_NAME"), event, env("REVIEW_APP_ID"), detailsUrl);
  if (results.length === 0) console.log("The event names no open pull request.");
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  for (const result of results) {
    const line = describe(result);
    console.log(line);
    if (summary) appendFileSync(summary, `${line}\n`);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
