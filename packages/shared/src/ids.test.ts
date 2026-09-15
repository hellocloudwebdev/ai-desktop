import { describe, expect, it } from "vitest";
import {
  createConversationId,
  createMessageId,
  createPermissionRequestId,
  createTaskId,
  createToolCallId,
  createResearchRequestId,
  createResearchSourceId,
  createResearchResultId,
  createResearchDocumentId,
  generateUlid,
  getUlidTimestamp,
  isUlid,
  parseConversationId,
  parseMessageId,
  parseTaskId,
  parseResearchRequestId,
  parseResearchSourceId,
  parseResearchResultId,
  parseResearchDocumentId,
  type ConversationId,
  type MessageId,
} from "./ids.js";

describe("ids: ULID generation and validation", () => {
  it("generates non-empty, exactly 26-character strings conforming to Crockford Base32", () => {
    const id = generateUlid();
    expect(typeof id).toBe("string");
    expect(id.length).toBe(26);
    expect(isUlid(id)).toBe(true);
  });

  it("produces distinct IDs across successive generations", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) {
      set.add(generateUlid());
    }
    expect(set.size).toBe(100);
  });

  it("encodes and decodes the seed timestamp accurately", () => {
    const now = 1788705800000;
    const id = generateUlid(now);
    expect(isUlid(id)).toBe(true);
    const decoded = getUlidTimestamp(id);
    expect(decoded).toBe(now);
  });

  it("rejects invalid ULID strings in isUlid", () => {
    expect(isUlid("")).toBe(false);
    expect(isUlid("too-short")).toBe(false);
    expect(isUlid("123456789012345678901234567")).toBe(false); // 27 chars
    expect(isUlid("01M1VJNQTKK6BWB7STBDKGZGG-")).toBe(false); // contains dash
    expect(isUlid("01M1VJNQTKK6BWB7STBDKGZGGI")).toBe(false); // contains invalid char 'I'
    expect(isUlid(null)).toBe(false);
    expect(isUlid(undefined)).toBe(false);
    expect(isUlid(12345)).toBe(false);
  });

  it("throws when getUlidTimestamp is called on invalid string", () => {
    expect(() => getUlidTimestamp("invalid")).toThrow(TypeError);
  });
});

describe("ids: Branded entity constructors and parsers", () => {
  it("creates branded entity IDs that are valid ULIDs", () => {
    const convId = createConversationId();
    const msgId = createMessageId();
    const taskId = createTaskId();
    const toolId = createToolCallId();
    const permId = createPermissionRequestId();
    const reqId = createResearchRequestId();
    const srcId = createResearchSourceId();
    const resId = createResearchResultId();
    const docId = createResearchDocumentId();

    expect(isUlid(convId)).toBe(true);
    expect(isUlid(msgId)).toBe(true);
    expect(isUlid(taskId)).toBe(true);
    expect(isUlid(toolId)).toBe(true);
    expect(isUlid(permId)).toBe(true);
    expect(isUlid(reqId)).toBe(true);
    expect(isUlid(srcId)).toBe(true);
    expect(isUlid(resId)).toBe(true);
    expect(isUlid(docId)).toBe(true);
  });

  it("parses valid ULID strings into branded types", () => {
    const raw = generateUlid().toLowerCase();
    const parsedConv = parseConversationId(raw);
    const parsedMsg = parseMessageId(raw);
    const parsedTask = parseTaskId(raw);
    const parsedReq = parseResearchRequestId(raw);
    const parsedSrc = parseResearchSourceId(raw);
    const parsedRes = parseResearchResultId(raw);
    const parsedDoc = parseResearchDocumentId(raw);

    expect(parsedConv).toBe(raw.toUpperCase());
    expect(parsedMsg).toBe(raw.toUpperCase());
    expect(parsedTask).toBe(raw.toUpperCase());
    expect(parsedReq).toBe(raw.toUpperCase());
    expect(parsedSrc).toBe(raw.toUpperCase());
    expect(parsedRes).toBe(raw.toUpperCase());
    expect(parsedDoc).toBe(raw.toUpperCase());
  });

  it("throws TypeError when parsing invalid strings into branded types", () => {
    expect(() => parseConversationId("bad-id")).toThrow(TypeError);
    expect(() => parseMessageId("bad-id")).toThrow(TypeError);
    expect(() => parseTaskId("bad-id")).toThrow(TypeError);
    expect(() => parseResearchRequestId("bad-id")).toThrow(TypeError);
    expect(() => parseResearchSourceId("bad-id")).toThrow(TypeError);
    expect(() => parseResearchResultId("bad-id")).toThrow(TypeError);
    expect(() => parseResearchDocumentId("bad-id")).toThrow(TypeError);
  });

  it("maintains compile-time distinction between branded types", () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    // Type-level test: Assigning ConversationId to MessageId should fail typecheck if uncommented:
    // const _invalid: MessageId = convId; // ts(2322)
    function acceptMessageId(id: MessageId) {
      return Boolean(id);
    }
    function acceptConversationId(id: ConversationId) {
      return Boolean(id);
    }

    expect(acceptConversationId(convId)).toBe(true);
    expect(acceptMessageId(msgId)).toBe(true);
  });
});
