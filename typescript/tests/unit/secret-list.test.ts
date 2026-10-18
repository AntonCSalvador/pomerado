import { describe, expect, it } from "vitest";
import {
  awsAccessKeyIdPattern,
  isCredentialAssignmentKey,
} from "../../src/privacy/credential-policy.js";
import { publicationBlockFeedback } from "../../src/mint/publication-block.js";
import { redactDiagnosticText } from "../../src/runtime/failure-detail.js";
import { providerKeyRefusal } from "../../src/standalone/mint-publication.js";

/** A synthetic key, built at run time so no secret scanner reads a literal one. */
const fake = (prefix: string, body: string) => prefix + body;

// One list of credential names and key shapes serves every host's masking and publication gates.
describe("the credential list", () => {
  it.each(["secret_string", "SecretString", "awsSecretBinary", "secret-binary"])(
    "names a vault secret %s as a credential",
    (key) => {
      expect(isCredentialAssignmentKey(key)).toBe(true);
    },
  );

  it("redacts a vault secret assignment in diagnostics", () => {
    expect(redactDiagnosticText("secret_string=hunter2hunter2")).toBe("secret_string=[redacted]");
  });

  it.each([
    ["after an underscore", `KEY_${fake("AKIA", "ABCDEFGHIJKLMNOP")}`],
    ["before an underscore", `${fake("ASIA", "ABCDEFGHIJKLMNOP")}_old`],
  ])("finds an AWS access key ID %s", (_, text) => {
    expect(text.match(awsAccessKeyIdPattern())?.[0]).toMatch(/^A[KS]IAABCDEFGHIJKLMNOP$/u);
    expect(redactDiagnosticText(text)).not.toMatch(/A[KS]IAABCDEFGHIJKLMNOP/u);
  });
});

// The local publication precheck refuses a hard-coded provider key as the hosted gate does.
describe("providerKeyRefusal", () => {
  it.each([
    ["a live payment key", fake("sk_live_", "FAKEsynthetic0000")],
    ["a test restricted key", fake("rk_test_", "FAKEsynthetic0000")],
    ["a webhook signing secret", fake("whsec_", "FAKEsyntheticSigning0000")],
    ["an analytics personal key", fake("phx_", "FAKEsynthetic0000personal1")],
    ["a model provider key", fake("sk-proj-", "FAKEsynthetic0000modelkey1")],
    ["a GitHub token", fake("ghp_", "FAKEsynthetic0000abcd")],
    ["an AWS access key ID", fake("AKIA", "FAKEFAKEFAKE0000")],
  ])("refuses %s, naming the file and position, never the key", (_, key) => {
    const text = `export const tool = 1;\nconst key = "${key}";\n`;
    const refused = providerKeyRefusal("src/tool.mjs", text);
    expect(refused).toMatchObject({
      code: "PublicationUnavailable",
      reason: "source_screening",
      publicationBlock: {
        file: "src/tool.mjs",
        check: "provider_credential",
        entity: "API_TOKEN",
        line: 2,
        column: 14,
      },
    });
    expect(JSON.stringify(refused)).not.toContain(key);
    const feedback = publicationBlockFeedback(
      refused?.publicationBlock ?? { file: "", check: "invalid_text" },
    );
    expect(feedback.instruction).toContain(
      "Not published: src/tool.mjs (line 2, column 14) holds a provider API key or private key.",
    );
  });

  it.each([
    ["a placeholder", 'const token = "ghp_example";'],
    ["a slug", 'const sku = "sk-hynix-ddr5-memory-kit";'],
    ["an identifier", 'const name = "bl_workspace_configuration_value";'],
  ])("keeps %s", (_, text) => {
    expect(providerKeyRefusal("src/tool.mjs", text)).toBeUndefined();
  });
});
