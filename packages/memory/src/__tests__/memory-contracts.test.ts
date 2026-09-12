import { describe, expect, it } from "vitest";
import { createConversationId, createMemoryFactId } from "@ai-desktop/shared";
import { containsRawCredential, MemoryFactSchema, type MemoryFact } from "@ai-desktop/ai-core";

describe("packages/memory: MemoryFact Canonical Contract (PR28.2–PR28.4, PR28.12)", () => {
  it("accepts a valid global fact without projectId", () => {
    const fact: MemoryFact = {
      id: createMemoryFactId(),
      scopeLevel: "global",
      projectId: null,
      content: "User prefers dark mode interfaces.",
      category: "preference",
      sensitivity: "normal",
      sourceConversationId: createConversationId(),
      confidence: 0.95,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      supersededBy: null,
    };

    expect(MemoryFactSchema.safeParse(fact).success).toBe(true);
  });

  it("accepts a valid project fact with projectId", () => {
    const fact: MemoryFact = {
      id: createMemoryFactId(),
      scopeLevel: "project",
      projectId: "project-alpha",
      content: "This project uses pnpm for package management.",
      category: "project_context",
      sensitivity: "normal",
      sourceConversationId: null,
      confidence: 0.85,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      supersededBy: null,
    };

    expect(MemoryFactSchema.safeParse(fact).success).toBe(true);
  });

  it("rejects project scope without projectId", () => {
    const fact = {
      id: createMemoryFactId(),
      scopeLevel: "project",
      projectId: null,
      content: "Orphaned project fact without owner.",
      category: "fact",
      sensitivity: "normal",
      confidence: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      supersededBy: null,
    };

    const res = MemoryFactSchema.safeParse(fact);
    expect(res.success).toBe(false);
  });

  it("rejects global scope with projectId present", () => {
    const fact = {
      id: createMemoryFactId(),
      scopeLevel: "global",
      projectId: "project-alpha",
      content: "Global fact should not carry a project.",
      category: "fact",
      sensitivity: "normal",
      confidence: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      supersededBy: null,
    };

    const res = MemoryFactSchema.safeParse(fact);
    expect(res.success).toBe(false);
  });

  it("rejects empty content and oversized content", () => {
    const empty = {
      id: createMemoryFactId(),
      scopeLevel: "global",
      content: "   ",
      category: "fact",
      sensitivity: "normal",
      confidence: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(MemoryFactSchema.safeParse(empty).success).toBe(false);

    const oversized = {
      id: createMemoryFactId(),
      scopeLevel: "global",
      content: "x".repeat(2001),
      category: "fact",
      sensitivity: "normal",
      confidence: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(MemoryFactSchema.safeParse(oversized).success).toBe(false);
  });

  it("rejects confidence outside 0.0–1.0", () => {
    const base = {
      id: createMemoryFactId(),
      scopeLevel: "global",
      content: "Confidence must be normalized.",
      category: "fact",
      sensitivity: "normal",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(MemoryFactSchema.safeParse({ ...base, confidence: -0.1 }).success).toBe(false);
    expect(MemoryFactSchema.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
    expect(MemoryFactSchema.safeParse({ ...base, confidence: 0.7 }).success).toBe(true);
  });

  it("SECURITY: rejects raw credentials in fact content", () => {
    const cases = [
      "My key is sk-ant-api03-1234567890123456789012345678901234567890abcd",
      "Use token AIzaSyD-1234567890123456789012345678901234 for auth",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7b...\n-----END RSA PRIVATE KEY-----",
      "database password: hunter2-secure-value",
    ];

    for (const content of cases) {
      expect(containsRawCredential(content)).toBe(true);
      const res = MemoryFactSchema.safeParse({
        id: createMemoryFactId(),
        scopeLevel: "global",
        content,
        category: "fact",
        sensitivity: "normal",
        confidence: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(res.success).toBe(false);
    }
  });

  it("SECURITY: allows benign content mentioning 'password' policy without values", () => {
    expect(containsRawCredential("Remember to rotate the database on schedule.")).toBe(false);
  });
});
