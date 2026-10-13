import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, parseCodeOwners, pullsToEvaluate, type GitHub } from "../../../tools/approval-gate.js";

const script = fileURLToPath(new URL("../../../tools/approval-gate.ts", import.meta.url));
const repo = "example-org/example-repo";
const head = "a".repeat(40);
const earlier = "b".repeat(40);
const owners = ["owner-one", "owner-two"];

interface Fixture {
  readonly author: string;
  /** Repository permission per user. A missing user answers 404. */
  readonly permissions: Readonly<Record<string, string>>;
  readonly reviews?: readonly { readonly login: string; readonly state: string; readonly sha: string }[];
  readonly association?: string;
}

/** GitHub's REST API for one open pull request, number 7, at `head`. */
const fakeApi = (fixture: Fixture) => {
  const pull = {
    number: 7,
    user: { login: fixture.author },
    head: { sha: head },
    author_association: fixture.association ?? "CONTRIBUTOR",
  };
  const reviews = (fixture.reviews ?? []).map((review) => ({
    user: { login: review.login },
    state: review.state,
    commit_id: review.sha,
  }));
  const permission = /^\/repos\/example-org\/example-repo\/collaborators\/([^/]+)\/permission$/;
  return (path: string): unknown => {
    const pathname = path.split("?")[0];
    if (pathname === `/repos/${repo}/pulls/7`) return pull;
    if (pathname === `/repos/${repo}/pulls/7/reviews`) return reviews;
    if (pathname === `/repos/${repo}/pulls`) return [{ ...pull, number: 6, head: { sha: earlier } }, pull];
    const user = permission.exec(pathname ?? "")?.[1];
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
  return {
    get: async (path) => api(path),
    list: async (path) => api(path) as unknown[],
  };
};

const verdict = (fixture: Fixture) => evaluate(github(fixture), repo, 7, owners);
const outside = { author: "outside-dev", permissions: { "outside-dev": "read", "owner-one": "admin", "owner-two": "write" } };

describe("approval gate", () => {
  it("passes a maintainer's pull request without any review", async () => {
    for (const level of ["write", "maintain", "admin"]) {
      expect(await verdict({ author: "maintainer", permissions: { maintainer: level } })).toMatchObject({
        sha: head,
        state: "success",
      });
    }
  });

  it("fails an outside contributor's pull request that no code owner approved", async () => {
    const result = await verdict(outside);
    expect(result).toMatchObject({ sha: head, state: "failure" });
    expect(result.description).toContain("code owner's approval");
    expect(result.description.length).toBeLessThanOrEqual(140);
  });

  it("passes an outside contributor's pull request once a code owner approves the head commit", async () => {
    expect(
      await verdict({ ...outside, reviews: [{ login: "Owner-Two", state: "APPROVED", sha: head }] }),
    ).toMatchObject({ sha: head, state: "success" });
  });

  it("doesn't count a code owner's approval of an earlier commit", async () => {
    const result = await verdict({ ...outside, reviews: [{ login: "owner-one", state: "APPROVED", sha: earlier }] });
    expect(result.state).toBe("failure");
    expect(result.description).toContain("earlier commit");
  });

  it("doesn't count an approval from a reviewer CODEOWNERS doesn't list", async () => {
    const permissions = { ...outside.permissions, "other-maintainer": "admin" };
    expect(
      await verdict({ ...outside, permissions, reviews: [{ login: "other-maintainer", state: "APPROVED", sha: head }] }),
    ).toMatchObject({ state: "failure" });
  });

  it("doesn't count a listed code owner who has lost write access", async () => {
    const permissions = { ...outside.permissions, "owner-one": "read" };
    expect(
      await verdict({ ...outside, permissions, reviews: [{ login: "owner-one", state: "APPROVED", sha: head }] }),
    ).toMatchObject({ state: "failure" });
  });

  it("withdraws an approval on a later change request or dismissal, and keeps it through a comment", async () => {
    const approved = { login: "owner-one", state: "APPROVED", sha: head };
    for (const later of ["CHANGES_REQUESTED", "DISMISSED"]) {
      expect(
        await verdict({ ...outside, reviews: [approved, { login: "owner-one", state: later, sha: head }] }),
      ).toMatchObject({ state: "failure" });
    }
    expect(
      await verdict({ ...outside, reviews: [approved, { login: "owner-one", state: "COMMENTED", sha: head }] }),
    ).toMatchObject({ state: "success" });
  });

  it("asks the API for the author's permission rather than trusting the author association", async () => {
    expect(await verdict({ ...outside, association: "MEMBER" })).toMatchObject({ state: "failure" });
    expect(await verdict({ author: "unknown-user", permissions: {}, association: "OWNER" })).toMatchObject({
      state: "failure",
    });
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

  it("evaluates again the open pull requests at the head commit a review's run names", async () => {
    const event = { workflow_run: { head_sha: head } };
    expect(await pullsToEvaluate(github(outside), repo, "workflow_run", event)).toEqual([7]);
  });
});

describe("approval gate workflow step", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** Runs the script as the workflow does, against a local stand-in for GitHub's API. */
  const run = async (fixture: Fixture, eventName: string, event: unknown) => {
    const cwd = mkdtempSync(join(tmpdir(), "approval-gate-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".github"));
    writeFileSync(join(cwd, ".github", "CODEOWNERS"), "* @owner-one @owner-two\n");
    writeFileSync(join(cwd, "event.json"), JSON.stringify(event));
    const api = fakeApi(fixture);
    const posted: { path: string; body: unknown; authorization: string | undefined }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
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
    try {
      const { port } = server.address() as AddressInfo;
      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [script], {
          cwd,
          stdio: "ignore",
          env: {
            PATH: process.env["PATH"] ?? "",
            GITHUB_TOKEN: "test-token",
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            GITHUB_SERVER_URL: "https://github.example",
            GITHUB_REPOSITORY: repo,
            GITHUB_RUN_ID: "1",
            GITHUB_EVENT_NAME: eventName,
            GITHUB_EVENT_PATH: join(cwd, "event.json"),
          },
        });
        child.on("exit", resolve);
      });
      return { exitCode, posted };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  it("posts the Approval status on the head commit for a pull request event", async () => {
    const fixture = { ...outside, reviews: [{ login: "owner-one", state: "APPROVED", sha: head }] };
    const { exitCode, posted } = await run(fixture, "pull_request_target", { pull_request: { number: 7 } });
    expect(exitCode).toBe(0);
    expect(posted).toEqual([
      {
        path: `/repos/${repo}/statuses/${head}`,
        authorization: "Bearer test-token",
        body: expect.objectContaining({ context: "Approval", state: "success" }),
      },
    ]);
  });

  it("posts a failing status after a review run for a pull request still missing an approval", async () => {
    const fixture = { ...outside, reviews: [{ login: "owner-one", state: "APPROVED", sha: earlier }] };
    const { exitCode, posted } = await run(fixture, "workflow_run", { workflow_run: { head_sha: head } });
    expect(exitCode).toBe(0);
    expect(posted).toEqual([
      {
        path: `/repos/${repo}/statuses/${head}`,
        authorization: "Bearer test-token",
        body: expect.objectContaining({ context: "Approval", state: "failure" }),
      },
    ]);
  });

  it("posts nothing and fails when GitHub's API can't be read", async () => {
    const fixture = { author: "outside-dev", permissions: {} };
    const { exitCode, posted } = await run(fixture, "pull_request_target", { pull_request: { number: 404 } });
    expect(exitCode).toBe(1);
    expect(posted).toEqual([]);
  });
});
