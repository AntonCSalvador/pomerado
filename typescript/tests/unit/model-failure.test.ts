import { Cause } from "effect";
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import { modelCauseMetadata, modelFailureMetadata } from "../../src/models/model-failure.js";

// A failure keeps its class, code, provider fields and message; only credentials are masked, by
// structure.
describe("model failure metadata", () => {
  it("keeps an untagged exception's message, cause code and credentials masked", () => {
    const error = new TypeError("fetch failed for password=hunter2-canary", {
      cause: Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" }),
    });
    expect(modelFailureMetadata(error)).toEqual({
      kind: "TypeError",
      message: "fetch failed for password=[redacted]",
      causeCode: "UND_ERR_SOCKET",
    });
  });

  it("keeps a hostile or cyclic error's readable fields without throwing", () => {
    const error = new TypeError("hostile message");
    Object.defineProperty(error, "request_id", {
      get: () => {
        throw new Error("getter throws");
      },
    });
    Object.assign(error, { code: "CUSTOM_CODE", cause: error });
    // The error is its own cause, read once.
    expect(modelFailureMetadata(error)).toEqual({
      kind: "TypeError",
      code: "CUSTOM_CODE",
      message: "hostile message",
      causeCode: "CUSTOM_CODE",
    });
    const hostileConstructor = Object.assign(new Error("constructor throws"), {
      status: 503,
      requestID: "req_safe_constructor",
    });
    Object.defineProperty(hostileConstructor, "constructor", {
      get: () => {
        throw new Error("constructor getter throws");
      },
    });
    expect(modelFailureMetadata(hostileConstructor)).toEqual({
      kind: "Error",
      message: "constructor throws",
      httpStatus: 503,
      requestId: "req_safe_constructor",
    });
  });

  it("keeps any provider code, request id and nested code", () => {
    expect(
      modelFailureMetadata({
        name: "APIConnectionError",
        code: "custom_provider_code",
        request_id: "req_custom?trace=abc",
      }),
    ).toEqual({
      kind: "APIConnectionError",
      code: "custom_provider_code",
      requestId: "req_custom?trace=abc",
    });
    expect(
      modelFailureMetadata(new TypeError("outer", { cause: { code: "server_error" } })),
    ).toEqual({
      kind: "TypeError",
      message: "outer",
      causeCode: "server_error",
    });
  });

  it("classifies OpenAI SDK errors by constructor and keeps their bodies", () => {
    const headers = new Headers({ "x-request-id": "req_real_sdk_429" });
    const limited = APIError.generate(
      429,
      { error: { code: "rate_limit_exceeded", message: "Rate limit reached for gpt" } },
      "Rate limit reached for gpt",
      headers,
    );
    expect(limited.name).toBe("Error");
    expect(modelFailureMetadata(limited)).toMatchObject({
      kind: "RateLimitError",
      code: "rate_limit_exceeded",
      providerCode: "rate_limit_exceeded",
      message: expect.stringContaining("Rate limit reached for gpt") as unknown,
      httpStatus: 429,
      requestId: "req_real_sdk_429",
    });
    const connection = new APIConnectionError({
      message: "Connection error.",
      cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
    });
    expect(modelFailureMetadata(connection)).toMatchObject({
      kind: "APIConnectionError",
      message: "Connection error.",
      causeCode: "UND_ERR_SOCKET",
    });
    expect(modelFailureMetadata(new APIConnectionTimeoutError())).toMatchObject({
      kind: "APIConnectionTimeoutError",
    });
    expect(modelFailureMetadata(new APIUserAbortError())).toMatchObject({
      kind: "APIUserAbortError",
    });
  });

  it("keeps a thrown string as its message", () => {
    expect(modelFailureMetadata("model stream ended")).toEqual({
      kind: "string",
      message: "model stream ended",
    });
    expect(modelFailureMetadata(undefined)).toEqual({ kind: "unclassified" });
  });

  it("reads a cause's failure, defect or interruption", () => {
    expect(modelCauseMetadata(Cause.fail(new RangeError("out of range")))).toEqual({
      kind: "RangeError",
      message: "out of range",
      interrupted: false,
    });
    expect(modelCauseMetadata(Cause.interrupt("fiber" as never))).toMatchObject({
      kind: "interrupted",
      interrupted: true,
    });
  });
});
