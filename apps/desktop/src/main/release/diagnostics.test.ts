// apps/desktop — Redacted diagnostic report tests.

import { describe, expect, it } from "vitest";
import { DiagnosticReportError, buildDiagnosticReport } from "./diagnostics.js";

describe("release: diagnostics", () => {
  it("includes the required fields and a timestamp", () => {
    const report = buildDiagnosticReport({
      version: "1.2.3",
      os: "darwin",
      arch: "arm64",
      subsystem: "storage",
      errorCategory: "database",
    });
    expect(report.appVersion).toBe("1.2.3");
    expect(report.os).toBe("darwin");
    expect(report.arch).toBe("arm64");
    expect(report.subsystem).toBe("storage");
    expect(report.errorCategory).toBe("database");
    expect(typeof report.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(report.timestamp))).toBe(false);
    expect(report.nodeVersion).toBe(process.version);
  });

  it("redacts secret-laden input so no credential survives", () => {
    const report = buildDiagnosticReport({
      version: "1.2.3",
      os: "darwin",
      arch: "arm64",
      subsystem: "auth failure apiKey=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
      errorCategory: "Authorization: Bearer supersecrettokenvalue123",
      correlationId: "corr-001",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("sk-ant-");
    expect(serialized).not.toContain("supersecrettokenvalue123");
    expect(serialized).toContain("[REDACTED]");
  });

  it("drops unknown fields and keeps the allowlisted shape", () => {
    const report = buildDiagnosticReport({
      version: "1.0.0",
      os: "linux",
      arch: "x64",
      subsystem: "sync",
      errorCategory: "network",
      correlationId: "corr-42",
      token: "should-be-dropped",
    } as unknown as Parameters<typeof buildDiagnosticReport>[0]);
    expect(report.correlationId).toBe("corr-42");
    expect(report).not.toHaveProperty("token");
    expect(Object.keys(report).sort()).toEqual(
      [
        "appVersion",
        "arch",
        "correlationId",
        "errorCategory",
        "nodeVersion",
        "os",
        "subsystem",
        "timestamp",
      ].sort(),
    );
  });

  it("rejects invalid contexts with a value-free error", () => {
    let caught: unknown;
    try {
      buildDiagnosticReport({
        version: "",
        os: "linux",
        arch: "x64",
        subsystem: "s",
        errorCategory: "e",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiagnosticReportError);
    expect((caught as DiagnosticReportError).code).toBe("INVALID_DIAGNOSTIC_CONTEXT");
    expect(String((caught as Error).message)).toContain("version");
  });
});
