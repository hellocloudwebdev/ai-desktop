import { describe, expect, it } from "vitest";
import {
  BaseError,
  CancelledError,
  ConflictError,
  formatError,
  InternalError,
  InvalidArgumentError,
  isBaseError,
  NotFoundError,
  TimeoutError,
  toError,
  ValidationError,
} from "./errors.js";

describe("errors: Domain-neutral Error Classes", () => {
  it("creates BaseError with custom code, message, and details", () => {
    const err = new BaseError("CUSTOM_CODE", "Something custom happened", {
      details: { foo: "bar" },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BaseError);
    expect(err.code).toBe("CUSTOM_CODE");
    expect(err.message).toBe("Something custom happened");
    expect(err.details).toEqual({ foo: "bar" });
    expect(err.name).toBe("BaseError");
  });

  it("creates typed domain-neutral error subclasses with appropriate codes", () => {
    const valErr = new ValidationError("bad input");
    expect(valErr.code).toBe("VALIDATION_ERROR");
    expect(valErr.name).toBe("ValidationError");

    const notFound = new NotFoundError("entity missing");
    expect(notFound.code).toBe("NOT_FOUND");

    const invalidArg = new InvalidArgumentError("invalid arg");
    expect(invalidArg.code).toBe("INVALID_ARGUMENT");

    const timeout = new TimeoutError("timed out after 5000ms");
    expect(timeout.code).toBe("TIMEOUT");

    const cancelled = new CancelledError("aborted by user");
    expect(cancelled.code).toBe("CANCELLED");

    const conflict = new ConflictError("resource already exists");
    expect(conflict.code).toBe("CONFLICT");

    const internal = new InternalError("unexpected crash");
    expect(internal.code).toBe("INTERNAL");
  });

  it("serializes BaseError to JSON", () => {
    const err = new ValidationError("Field is required", { details: { field: "name" } });
    const json = err.toJSON();
    expect(json.name).toBe("ValidationError");
    expect(json.code).toBe("VALIDATION_ERROR");
    expect(json.message).toBe("Field is required");
    expect(json.details).toEqual({ field: "name" });
  });

  it("supports error cause chaining", () => {
    const cause = new Error("network reset");
    const err = new InternalError("Database query failed", { cause });
    expect(err.cause).toBe(cause);
  });

  it("isBaseError detects BaseError instances", () => {
    expect(isBaseError(new ValidationError("test"))).toBe(true);
    expect(isBaseError(new Error("plain error"))).toBe(false);
    expect(isBaseError("string")).toBe(false);
    expect(isBaseError(null)).toBe(false);
  });

  it("toError safely converts any thrown value into a standard Error", () => {
    const standard = new Error("already an error");
    expect(toError(standard)).toBe(standard);

    const fromString = toError("raw string message");
    expect(fromString).toBeInstanceOf(Error);
    expect(fromString.message).toBe("raw string message");

    const fromObject = toError({ message: "object with message" });
    expect(fromObject).toBeInstanceOf(Error);
    expect(fromObject.message).toBe("object with message");

    const fromNumber = toError(500);
    expect(fromNumber.message).toBe("500");
  });

  it("formatError formats BaseError and standard Error cleanly", () => {
    const base = new NotFoundError("Conversation not found");
    expect(formatError(base)).toBe("[NOT_FOUND] Conversation not found");

    const std = new Error("Simple failure");
    expect(formatError(std)).toBe("Simple failure");

    expect(formatError("plain string")).toBe("plain string");
  });
});
