/**
 * Approval gate, run by .github/workflows/approval.yml. It posts the `Approval` commit status on a
 * pull request's head commit, which the ruleset on main requires.
 *
 * - A maintainer's pull request passes. A maintainer is a user whom GitHub's API reports with
 *   write, maintain or admin permission on this repository. The payload's author association is
 *   never enough on its own, so the gate always asks the API.
 * - Any other pull request passes only once a code owner approves its current head commit. A code
 *   owner is a user listed in .github/CODEOWNERS who also has write permission. As with dismissed
 *   stale reviews, an approval of an earlier commit stops counting after a push. A later change
 *   request or dismissal of the same reviewer's review withdraws the approval, and a later comment
 *   leaves it standing, as on GitHub.
 *
 * Every user CODEOWNERS lists counts as an owner of every path, which is what the file assigns.
 * Team entries are skipped, because the workflow's token can't read team membership.
 *
 * The workflow runs this file from the base branch, never from the pull request. It reads each fact
 * from GitHub's API, so nothing a pull request contains or sends decides the result.
 *
 * Usage, in the workflow: node tools/approval-gate.ts
 */
import { appendFileSync, readFileSync } from "node:fs";

/** The status context the ruleset requires. */
export const statusContext = "Approval";

const writeRoles = new Set(["admin", "maintain", "write"]);
/** Review states that set a reviewer's verdict. A comment review doesn't change it. */
const verdictStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

export interface GitHub {
  /** One REST resource, or undefined when GitHub answers 404. */
  readonly get: (path: string) => Promise<unknown>;
  /** Every item of a paginated REST list. */
  readonly list: (path: string) => Promise<readonly unknown[]>;
}

export interface Verdict {
  readonly sha: string;
  readonly state: "success" | "failure";
  /** The status description, at most 140 characters. */
  readonly description: string;
}

interface PullRequest {
  readonly number: number;
  readonly user: { readonly login: string };
  readonly head: { readonly sha: string };
}

interface Review {
  readonly user: { readonly login: string } | null;
  readonly state: string;
  readonly commit_id: string | null;
}

/** The lowercased user names CODEOWNERS lists. Teams and email addresses are skipped. */
export const parseCodeOwners = (text: string): string[] => {
  const owners = new Set<string>();
  for (const line of text.split("\n")) {
    const [, ...entries] = line.replace(/#.*/, "").trim().split(/\s+/);
    for (const entry of entries) if (/^@[\w-]+$/.test(entry)) owners.add(entry.slice(1).toLowerCase());
  }
  return [...owners];
};

const canWrite = async (github: GitHub, repo: string, login: string): Promise<boolean> => {
  const body = (await github.get(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)) as
    | { readonly permission?: string }
    | undefined;
  return body?.permission !== undefined && writeRoles.has(body.permission);
};

/** Decides the `Approval` status for a pull request's current head commit. */
export const evaluate = async (
  github: GitHub,
  repo: string,
  number: number,
  codeOwners: readonly string[],
): Promise<Verdict> => {
  const pull = (await github.get(`/repos/${repo}/pulls/${number}`)) as PullRequest | undefined;
  if (pull === undefined) throw new Error(`Pull request ${number} was not found.`);
  const sha = pull.head.sha;
  const author = pull.user.login.toLowerCase();
  if (await canWrite(github, repo, pull.user.login)) {
    return { sha, state: "success", description: "The author has write access, so no code owner approval is needed." };
  }
  // GitHub lists reviews oldest first, so the last verdict per reviewer is the one that stands.
  const latest = new Map<string, Review & { readonly user: { readonly login: string } }>();
  for (const review of (await github.list(`/repos/${repo}/pulls/${number}/reviews`)) as Review[]) {
    if (review.user !== null && verdictStates.has(review.state)) {
      latest.set(review.user.login.toLowerCase(), { ...review, user: review.user });
    }
  }
  const owners = new Set(codeOwners);
  let staleApproval = false;
  for (const [login, review] of latest) {
    if (review.state !== "APPROVED" || !owners.has(login) || login === author) continue;
    if (!(await canWrite(github, repo, review.user.login))) continue;
    if (review.commit_id === sha) {
      return { sha, state: "success", description: `Code owner @${review.user.login} approved the head commit.` };
    }
    staleApproval = true;
  }
  const description = staleApproval
    ? "A code owner approved an earlier commit. The head commit needs a code owner's approval."
    : "The author lacks write access, so the head commit needs a code owner's approval.";
  return { sha, state: "failure", description };
};

/** The open pull requests an event asks the gate to evaluate. */
export const pullsToEvaluate = async (
  github: GitHub,
  repo: string,
  eventName: string,
  event: unknown,
): Promise<number[]> => {
  if (eventName === "pull_request_target") {
    return [(event as { readonly pull_request: PullRequest }).pull_request.number];
  }
  if (eventName === "workflow_run") {
    // A submitted or dismissed review woke the gate. The review's run names the head commit it ran
    // for, and the pull requests still at that commit are the ones to evaluate again. A pull request
    // that has moved on was evaluated at its new head when it was pushed.
    const sha = (event as { readonly workflow_run: { readonly head_sha: string } }).workflow_run.head_sha;
    const open = (await github.list(`/repos/${repo}/pulls?state=open`)) as PullRequest[];
    return open.filter((pull) => pull.head.sha === sha).map((pull) => pull.number);
  }
  throw new Error(`The approval gate doesn't handle ${eventName} events.`);
};

const client = (token: string, api: string) => {
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (method === "GET" && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as unknown;
  };
  return {
    get: (path: string) => request("GET", path),
    list: async (path: string) => {
      const items: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const batch = (await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)) as
          | unknown[]
          | undefined;
        items.push(...(batch ?? []));
        if (batch === undefined || batch.length < 100) return items;
      }
    },
    post: (path: string, body: unknown) => request("POST", path, body),
  };
};

const main = async (): Promise<void> => {
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set.`);
    return value;
  };
  const repo = env("GITHUB_REPOSITORY");
  const github = client(env("GITHUB_TOKEN"), env("GITHUB_API_URL"));
  const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as unknown;
  const codeOwners = parseCodeOwners(readFileSync(".github/CODEOWNERS", "utf8"));
  const targetUrl = `${env("GITHUB_SERVER_URL")}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;
  for (const number of await pullsToEvaluate(github, repo, env("GITHUB_EVENT_NAME"), event)) {
    const verdict = await evaluate(github, repo, number, codeOwners);
    await github.post(`/repos/${repo}/statuses/${verdict.sha}`, {
      state: verdict.state,
      context: statusContext,
      description: verdict.description,
      target_url: targetUrl,
    });
    const line = `Pull request ${number} at ${verdict.sha}: ${verdict.state}. ${verdict.description}`;
    console.log(line);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary) appendFileSync(summary, `${line}\n`);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
