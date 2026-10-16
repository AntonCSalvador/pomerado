import { posix } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { localRuntimeAssets } from "../../src/execution/local-runtime-assets.js";
import { loadStandaloneAuthoring, skillReferenceFiles } from "../../src/mint/skills.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { sourceInspector } from "../../src/standalone/request-context.js";

/** Guardian's reads over a review's own files, with the local host's trusted SDK. */
const reader = async (sources: ReadonlyMap<string, string>) => {
  const trustedSources = new Map(await Effect.runPromise(localRuntimeAssets));
  const readSource = sourceInspector({ trustedSources, secrets: makeRunSecrets() }, sources);
  return {
    trustedSources,
    read: (path: string) =>
      Effect.runPromise(
        readSource(path, 0).pipe(
          Effect.match({
            onFailure: (failure) => ({ failure: failure.code }),
            onSuccess: (chunk) => ({ source: (JSON.parse(chunk) as { source: string }).source }),
          }),
        ),
      ),
  };
};

describe("Guardian's source reads on the local host", () => {
  it("reads the SDK under operation/, where authored source imports it", async () => {
    const { trustedSources, read } = await reader(
      new Map([["operation/src/index.js", 'import "../../runtime/index.js";\n']]),
    );
    for (const path of ["runtime/index.js", "browser/form-controls.js"]) {
      const sdk = trustedSources.get(path);
      expect(sdk).toBeDefined();
      expect(await read(`operation/${path}`)).toEqual({ source: sdk });
      expect(await read(path)).toEqual({ source: sdk });
    }
  });

  it("reads the SDK's package path, and every module it loads, as the SDK's source", async () => {
    const { trustedSources, read } = await reader(
      new Map([["operation/src/tool-http.mjs", 'import "pomerado/runtime";\n']]),
    );
    const entry = trustedSources.get("browser/index.js");
    expect(entry).toBeDefined();
    for (const path of ["pomerado/runtime", "operation/pomerado/runtime"])
      expect(await read(path)).toEqual({ source: entry });
    // Every relative import the SDK makes, followed from its entry, is readable too.
    const pending = ["browser/index.js"];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const path = pending.pop() ?? "";
      if (seen.has(path)) continue;
      seen.add(path);
      const result = await read(path);
      expect(result, path).toHaveProperty("source");
      const text = "source" in result ? result.source : "";
      for (const [, specifier = ""] of text.matchAll(
        /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/gu,
      ))
        pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("reads the SDK's modules under pomerado/, and a TypeScript spelling as the JavaScript that runs", async () => {
    const { trustedSources, read } = await reader(new Map());
    const operation = trustedSources.get("runtime/operation.js");
    const entry = trustedSources.get("browser/index.js");
    expect(operation).toBeDefined();
    for (const path of [
      "pomerado/runtime/operation.js",
      "pomerado/runtime/operation.ts",
      "pomerado/runtime/operation.d.ts",
      "runtime/operation.ts",
      "operation/pomerado/runtime/operation.d.ts",
    ])
      expect(await read(path), path).toEqual({ source: operation });
    expect(await read("pomerado/browser/index.ts")).toEqual({ source: entry });
    expect(await read("pomerado/runtime/missing.ts")).toEqual({ failure: "SourceUnavailable" });
  });

  it("reads an authored TypeScript file as written, never as the SDK's JavaScript", async () => {
    const { read } = await reader(
      new Map([["operation/runtime/operation.ts", "export const authored = 1;\n"]]),
    );
    expect(await read("operation/runtime/operation.ts")).toEqual({
      source: "export const authored = 1;\n",
    });
  });

  it("reads each of the minter's skills where the minter reads it", async () => {
    const { skills } = await Effect.runPromise(
      loadStandaloneAuthoring(fileURLToPath(new URL("../../authoring/", import.meta.url))),
    );
    const references = skillReferenceFiles(skills);
    expect(references.size).toBe(skills.length);
    const { read } = await reader(references);
    // The skill is long, so its first chunk starts it.
    const core = await read(".agents/core/SKILL.md");
    expect("source" in core && core.source.length > 0).toBe(true);
    expect(references.get(".agents/core/SKILL.md")?.startsWith("source" in core ? core.source : "-")).toBe(true);
  });

  it("reads an authored file before the SDK file at the same path", async () => {
    const { read } = await reader(
      new Map([["operation/runtime/index.js", "export const authored = true;\n"]]),
    );
    expect(await read("operation/runtime/index.js")).toEqual({
      source: "export const authored = true;\n",
    });
  });

  it("finds no file outside the review's files and the SDK", async () => {
    const { read } = await reader(new Map());
    for (const path of ["operation/src/missing.js", "executed/runtime/index.js"])
      expect(await read(path)).toEqual({ failure: "SourceUnavailable" });
  });

  it("ships every SDK module the SDK's own files import", async () => {
    const { trustedSources } = await reader(new Map());
    const missing: string[] = [];
    for (const [path, source] of trustedSources)
      for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
        const imported = new URL(specifier ?? "", `file:///sdk/${path}`).pathname.slice(5);
        if (!trustedSources.has(imported)) missing.push(`${path} -> ${imported}`);
      }
    expect(missing).toEqual([]);
  });
});
