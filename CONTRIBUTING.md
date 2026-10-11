# Contributing

Contributions are welcome, from people and from their coding agents. Open an issue for a bug, a question or an idea. Report security problems privately with **Report a vulnerability** on the [Security tab](https://github.com/Pomerado/pomerado/security), never in a public issue.

## How to contribute

1. Open an issue before a large change, so we can agree on the approach before you write code. A small fix can go straight to a pull request.
2. Fork the repository and branch from `main`.
3. Make your change. A change in behavior starts with a failing test.
4. Run the checks under [Build and test](#build-and-test).
5. Open a pull request that says what changed and why.

A maintainer approves the CI run on your pull request, then reviews it. Alan ([@alanmrsa](https://github.com/alanmrsa)) or Akshay ([@AkshayM21](https://github.com/AkshayM21)) reviews and approves every pull request before it merges, our own included. Push fixes as new commits, and merge `main` into your branch rather than rebasing. Each merge publishes a canary to npm, so you can try your change right away. [Releasing](docs/RELEASING.md) covers how `latest` moves.

## Using a coding agent

Pomerado is agent friendly. Point your agent at [AGENTS.md](AGENTS.md), which has the setup, the layout and the rules it should follow. Read the diff and run the checks yourself before you open the pull request. You answer for the change as if you wrote it.

## Build and test

Use macOS or Linux, Node 24.21 or a later Node 24 release, pnpm 10.34.5, git 2.36 or later, and jq.

```sh
git clone https://github.com/<your-username>/pomerado.git
cd pomerado
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm test:browser
npm pack --dry-run
bash tools/ci-scan.sh content
```

- Tests use synthetic sites and scripted model responses. They need no model API key or Pomerado account.
- Browser tests run the built `dist/`, so build before you run them.
- On Linux, add `--with-deps` after `install` if Chromium's system libraries are missing.

To try your build in an MCP client, point the client at the built entry with Node. Use absolute paths. `node -p 'process.execPath'` prints the Node path.

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pomerado/dist/typescript/src/standalone/mcp-cli.js", "mint", "--root", "/absolute/path/to/integrations"]
    }
  }
}
```

The server needs `OPENAI_API_KEY` in its environment to mint. [Client settings](docs/getting-started.md#client-settings) shows how each client passes it.

## What CI checks

- CI runs typecheck, build, unit tests, the packed package check, browser tests, a gitleaks secret scan and a public content scan.
- Keep credentials, personal data and customer data out of code, tests, commit messages and pull request text.
- Link an issue by its full URL in files and commit messages. The content scan rejects `#123` style references there, though your pull request description can use them.
- Add to this package only code the local host runs, or a hook interface another host implements.

## License

Pomerado is licensed under the [MIT License](LICENSE). Contributions are accepted under the same license, inbound = outbound, with no Contributor License Agreement. Third-party code keeps its own license, with its license and notice under `third-party/`.
