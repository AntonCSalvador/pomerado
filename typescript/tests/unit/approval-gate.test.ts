import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitsToEvaluate,
  createClient,
  evaluateCommit,
  parseCodeOwners,
  type GitHub,
} from "../../../tools/approval-gate.js";

const script = fileURLToPath(new URL("../../../tools/approval-gate.ts", import.meta.url));
const repo = "example-org/example-repo";
const head = "a".repeat(40);
const earlier = "b".repeat(40);
const owners = ["owner-one", "owner-two"];

interface Review {
  readonly login: string;
  readonly state: string;
  readonly sha: string;
}

interface Pull {
  readonly number: number;
  readonly author: string;
  readonly sha?: string;
  readonly reviews?: readonly Review[];
  readonly association?: string;
  /** The repository the head branch is in: this one unless it names a fork, or null once the fork is deleted. */
  readonly headRepo?: string | null;
}

interface Fixture {
  /** Repository permission per user. A missing user answers 404. */
  readonly permissions: Readonly<Record<string, string>>;
  /** The open pull requests. Each is at `head` unless it names another commit. */
  readonly pulls: readonly Pull[];
}

/** Answers a GET the way GitHub's REST API does for the fixture, or throws for an unknown path. */
const fakeApi = (fixture: Fixture) => {
  const pulls = fixture.pulls.map((pull) => ({
    number: pull.number,
    user: { login: pull.author },
    head: {
      sha: pull.sha ?? head,
      repo: pull.headRepo === null ? null : { full_name: pull.headRepo ?? repo },
    },
    author_association: pull.association ?? "CONTRIBUTOR",
  }));
  const permission = /^\/repos\/example-org\/example-repo\/collaborators\/([^/]+)\/permission$/;
  const reviews = /^\/repos\/example-org\/example-repo\/pulls\/(\d+)\/reviews$/;
  return (path: string): unknown => {
    const pathname = path.split("?")[0] ?? "";
    if (pathname === `/repos/${repo}/pulls`) return pulls;
    const number = reviews.exec(pathname)?.[1];
    if (number !== undefined) {
      return (fixture.pulls.find((pull) => pull.number === Number(number))?.reviews ?? []).map((review) => ({
        user: { login: review.login },
        state: review.state,
        commit_id: review.sha,
      }));
    }
    const user = permission.exec(pathname)?.[1];
    if (user !== undefined) {
      // GitHub matches user names without regard to case.
      const name = decodeURIComponent(user).toLowerCase();
      const level = Object.entries(fixture.permissions).find(([login]) => login.toLowerCase() === name)?.[1];
      return level === undefined ? undefined : { permission: level, user: { login: user } };
    }
    throw new Error(`Unexpected request for ${path}`);
  };
};

const github = (fixture: Fixture): GitHub => {
  const api = fakeApi(fixture);
  return { get: async (path) => api(path), list: async (path) => api(path) as unknown[] };
};

const permissions = { "outside-dev": "read", "owner-one": "admin", "owner-two": "write", "other-dev": "write" };
/** The verdict for `head` when one outside contributor's pull request is open there. */
const outside = (reviews: readonly Review[] = [], extra: Readonly<Record<string, string>> = {}) => {
  const fixture = { permissions: { ...permissions, ...extra }, pulls: [{ number: 7, author: "outside-dev", reviews }] };
  return evaluateCommit(github(fixture), repo, head, owners);
};

describe("approval gate", () => {
  it("passes a maintainer's pull request without any review", async () => {
    for (const level of ["write", "maintain", "admin"]) {
      const fixture = { permissions: { maintainer: level }, pulls: [{ number: 7, author: "maintainer" }] };
      expect(await evaluateCommit(github(fixture), repo, head, owners)).toMatchObject({ state: "success", pulls: [7] });
    }
  });

  it("fails an outside contributor's pull request that no code owner approved", async () => {
    const result = await outside();
    expect(result).toMatchObject({ state: "failure", pulls: [7] });
    expect(result?.description).toContain("code owner's approval");
    expect(result?.description.length).toBeLessThanOrEqual(140);
  });

  it("passes an outside contributor's pull request once a code owner approves the head commit", async () => {
    expect(await outside([{ login: "Owner-Two", state: "APPROVED", sha: head }])).toMatchObject({ state: "success" });
  });

  it("doesn't count a code owner's approval of an earlier commit", async () => {
    const result = await outside([{ login: "owner-one", state: "APPROVED", sha: earlier }]);
    expect(result?.state).toBe("failure");
    expect(result?.description).toContain("earlier commit");
  });

  it("doesn't count an approval from a reviewer CODEOWNERS doesn't list", async () => {
    expect(await outside([{ login: "other-dev", state: "APPROVED", sha: head }])).toMatchObject({ state: "failure" });
  });

  it("doesn't count a listed code owner who has lost write access", async () => {
    const reviews = [{ login: "owner-one", state: "APPROVED", sha: head }];
    expect(await outside(reviews, { "owner-one": "read" })).toMatchObject({ state: "failure" });
  });

  it("withdraws an approval on a later change request or dismissal, and keeps it through a comment", async () => {
    const approved = { login: "owner-one", state: "APPROVED", sha: head };
    for (const later of ["CHANGES_REQUESTED", "DISMISSED"]) {
      expect(await outside([approved, { login: "owner-one", state: later, sha: head }])).toMatchObject({
        state: "failure",
      });
    }
    expect(await outside([approved, { login: "owner-one", state: "COMMENTED", sha: head }])).toMatchObject({
      state: "success",
    });
  });

  it("fails while another reviewer with write access has changes requested", async () => {
    const approved = { login: "owner-one", state: "APPROVED", sha: head };
    const result = await outside([{ login: "other-dev", state: "CHANGES_REQUESTED", sha: earlier }, approved]);
    expect(result).toMatchObject({ state: "failure", description: "@other-dev requested changes." });
    // A change request from someone without write access doesn't block, as on GitHub.
    const reader = { login: "outside-reader", state: "CHANGES_REQUESTED", sha: head };
    expect(await outside([reader, approved], { "outside-reader": "read" })).toMatchObject({ state: "success" });
  });

  it("needs a code owner's approval for a maintainer's pull request from a fork", async () => {
    // The fork's owner can push to its branch without write access here, so the author's access doesn't vouch for it.
    for (const headRepo of ["outside-dev/example-repo", null]) {
      const pull = { number: 7, author: "maintainer", headRepo };
      const fixture = { permissions: { ...permissions, maintainer: "write" }, pulls: [pull] };
      expect(await evaluateCommit(github(fixture), repo, head, owners)).toMatchObject({ state: "failure" });
      const approved = { ...fixture, pulls: [{ ...pull, reviews: [{ login: "owner-one", state: "APPROVED", sha: head }] }] };
      expect(await evaluateCommit(github(approved), repo, head, owners)).toMatchObject({ state: "success" });
    }
  });

  it("asks the API for the author's permission rather than trusting the author association", async () => {
    for (const association of ["MEMBER", "OWNER", "COLLABORATOR"]) {
      const fixture = { permissions, pulls: [{ number: 7, author: "outside-dev", association }] };
      expect(await evaluateCommit(github(fixture), repo, head, owners)).toMatchObject({ state: "failure" });
    }
  });

  it("passes a commit when any open pull request at it passes", async () => {
    const fixture = {
      permissions: { ...permissions, maintainer: "write" },
      pulls: [
        { number: 8, author: "outside-dev" },
        { number: 7, author: "maintainer" },
      ],
    };
    expect(await evaluateCommit(github(fixture), repo, head, owners)).toMatchObject({ state: "success", pulls: [7] });
  });

  it("decides nothing for a commit no open pull request is at", async () => {
    const fixture = { permissions, pulls: [{ number: 7, author: "outside-dev", sha: earlier }] };
    expect(await evaluateCommit(github(fixture), repo, head, owners)).toBeUndefined();
  });

  it("reads user owners from CODEOWNERS and skips teams, emails and comments", () => {
    const text = [
      "# @commented-out",
      "* @Owner-One @example-org/a-team",
      "/docs/ owner@example.com @owner-two # @trailing-comment",
      "",
    ].join("\n");
    expect(parseCodeOwners(text)).toEqual(["owner-one", "owner-two"]);
  });

  it("evaluates the commit an event names, or every open pull request's on a dispatch", async () => {
    const fixture = {
      permissions,
      pulls: [
        { number: 6, author: "outside-dev", sha: earlier },
        { number: 7, author: "outside-dev" },
        { number: 8, author: "outside-dev" },
      ],
    };
    const api = github(fixture);
    const pullRequest = { pull_request: { head: { sha: head } } };
    expect(await commitsToEvaluate(api, repo, "pull_request_target", pullRequest)).toEqual([head]);
    expect(await commitsToEvaluate(api, repo, "workflow_run", { workflow_run: { head_sha: head } })).toEqual([head]);
    expect(await commitsToEvaluate(api, repo, "workflow_dispatch", {})).toEqual([earlier, head]);
  });
});

/** A local stand-in for GitHub's API. `answer` may take over a request by returning true. */
const serve = async (
  fixture: Fixture,
  answer: (request: IncomingMessage, response: ServerResponse) => boolean = () => false,
) => {
  const api = fakeApi(fixture);
  const posted: { path: string; body: unknown; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      if (answer(request, response)) return;
      if (request.method === "POST") {
        posted.push({ path: request.url ?? "", body: JSON.parse(body), authorization: request.headers.authorization });
        response.writeHead(201).end("{}");
        return;
      }
      let result: unknown;
      try {
        result = api(request.url ?? "");
      } catch {
        response.writeHead(500).end("{}");
        return;
      }
      if (result === undefined) response.writeHead(404).end("{}");
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posted,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

describe("approval gate API client", () => {
  it("tries a GitHub error again with backoff, and gives up after its attempts", async () => {
    let failures = 2;
    const fixture = { permissions, pulls: [{ number: 7, author: "outside-dev" }] };
    const api = await serve(fixture, (request, response) => {
      if (request.method !== "GET" || failures === 0) return false;
      failures -= 1;
      response.writeHead(502).end("{}");
      return true;
    });
    const waits: number[] = [];
    const wait = async (milliseconds: number) => waits.push(milliseconds);
    try {
      const client = createClient("test-token", api.url, { attempts: 3, wait });
      expect(await client.get(`/repos/${repo}/collaborators/outside-dev/permission`)).toMatchObject({
        permission: "read",
      });
      expect(waits).toEqual([1000, 4000]);
      failures = 5;
      await expect(client.get(`/repos/${repo}/pulls?state=open`)).rejects.toThrow("after 3 attempts");
    } finally {
      await api.close();
    }
  });

  it("tries a rate-limited request again", async () => {
    const fixture = { permissions, pulls: [] };
    const limits = [
      { status: 429, headers: {} },
      { status: 403, headers: { "x-ratelimit-remaining": "0" } },
    ];
    for (const limit of limits) {
      let requests = 0;
      const api = await serve(fixture, (_request, response) => {
        requests += 1;
        if (requests > 1) return false;
        response.writeHead(limit.status, limit.headers).end("{}");
        return true;
      });
      try {
        const client = createClient("test-token", api.url, { attempts: 3, wait: async () => undefined });
        expect(await client.get(`/repos/${repo}/pulls`)).toEqual([]);
        expect(requests).toBe(2);
      } finally {
        await api.close();
      }
    }
  });

  it("doesn't try a request GitHub refused again", async () => {
    const fixture = { permissions, pulls: [] };
    // A 403 with rate limit left is a refusal, not a rate limit.
    for (const refusal of [{ status: 401, headers: {} }, { status: 403, headers: { "x-ratelimit-remaining": "42" } }]) {
      let requests = 0;
      const api = await serve(fixture, (_request, response) => {
        requests += 1;
        response.writeHead(refusal.status, refusal.headers).end("{}");
        return true;
      });
      try {
        const client = createClient("test-token", api.url, { attempts: 3, wait: async () => undefined });
        await expect(client.get(`/repos/${repo}/pulls`)).rejects.toThrow(`answered ${refusal.status}`);
        expect(requests).toBe(1);
      } finally {
        await api.close();
      }
    }
  });
});

describe("approval gate workflow step", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** Runs the script as the workflow does, against a local stand-in for GitHub's API. */
  const run = async (
    fixture: Fixture,
    eventName: string,
    event: unknown,
    answer?: (request: IncomingMessage, response: ServerResponse) => boolean,
  ) => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-gate-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".github"));
    writeFileSync(join(cwd, ".github", "CODEOWNERS"), "* @owner-one @owner-two\n");
    writeFileSync(join(cwd, "event.json"), JSON.stringify(event));
    const api = await serve(fixture, answer);
    try {
      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [script], {
          cwd,
          stdio: "ignore",
          env: {
            PATH: process.env["PATH"] ?? "",
            APPROVAL_APP_TOKEN: "test-token",
            GITHUB_API_URL: api.url,
            GITHUB_SERVER_URL: "https://github.example",
            GITHUB_REPOSITORY: repo,
            GITHUB_RUN_ID: "1",
            GITHUB_EVENT_NAME: eventName,
            GITHUB_EVENT_PATH: join(cwd, "event.json"),
          },
        });
        child.on("exit", resolve);
      });
      return { exitCode, posted: api.posted };
    } finally {
      await api.close();
    }
  };

  const status = (state: string) => ({
    path: `/repos/${repo}/statuses/${head}`,
    authorization: "Bearer test-token",
    body: expect.objectContaining({ context: "Approval", state }),
  });

  it("posts the Approval status on the head commit for a pull request event", async () => {
    const fixture = {
      permissions,
      pulls: [{ number: 7, author: "outside-dev", reviews: [{ login: "owner-one", state: "APPROVED", sha: head }] }],
    };
    const { exitCode, posted } = await run(fixture, "pull_request_target", { pull_request: { head: { sha: head } } });
    expect(exitCode).toBe(0);
    expect(posted).toEqual([status("success")]);
  });

  it("posts a failing status after a review run for a pull request still missing an approval", async () => {
    const fixture = {
      permissions,
      pulls: [{ number: 7, author: "outside-dev", reviews: [{ login: "owner-one", state: "APPROVED", sha: earlier }] }],
    };
    const { exitCode, posted } = await run(fixture, "workflow_run", { workflow_run: { head_sha: head } });
    expect(exitCode).toBe(0);
    expect(posted).toEqual([status("failure")]);
  });

  it("posts nothing and fails when GitHub refuses the token", async () => {
    const fixture = { permissions, pulls: [{ number: 7, author: "outside-dev" }] };
    const refuse = (_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(401).end("{}");
      return true;
    };
    const event = { pull_request: { head: { sha: head } } };
    const { exitCode, posted } = await run(fixture, "pull_request_target", event, refuse);
    expect(exitCode).toBe(1);
    expect(posted).toEqual([]);
  });
});
