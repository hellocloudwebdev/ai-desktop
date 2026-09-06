import { describe, expect, it } from "vitest";
import {
  all,
  err,
  flatMap,
  fromPromise,
  fromThrowable,
  isErr,
  isOk,
  map,
  mapErr,
  match,
  ok,
  unwrap,
  unwrapOr,
} from "./result.js";

describe("result: Construction and Type Narrowing", () => {
  it("constructs an Ok result and narrows correctly", () => {
    const res = ok(42);
    expect(res.ok).toBe(true);
    expect(isOk(res)).toBe(true);
    expect(isErr(res)).toBe(false);
    if (isOk(res)) {
      expect(res.value).toBe(42);
    }
  });

  it("constructs an Err result and narrows correctly", () => {
    const error = new Error("Something broke");
    const res = err(error);
    expect(res.ok).toBe(false);
    expect(isOk(res)).toBe(false);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error).toBe(error);
    }
  });
});

describe("result: Functional Combinators", () => {
  it("map transforms Ok value and leaves Err untouched", () => {
    const okRes = ok(10);
    const mappedOk = map(okRes, (x) => x * 2);
    expect(unwrap(mappedOk)).toBe(20);

    const errRes = err(new Error("fail"));
    const mappedErr = map(errRes, (x: number) => x * 2);
    expect(isErr(mappedErr)).toBe(true);
  });

  it("mapErr transforms Err and leaves Ok untouched", () => {
    const okRes = ok("success");
    const mappedOk = mapErr(okRes, (e: Error) => new Error(`Wrapped: ${e.message}`));
    expect(unwrap(mappedOk)).toBe("success");

    const errRes = err(new Error("original"));
    const mappedErr = mapErr(errRes, (e) => new Error(`Wrapped: ${e.message}`));
    expect(isErr(mappedErr)).toBe(true);
    if (isErr(mappedErr)) {
      expect(mappedErr.error.message).toBe("Wrapped: original");
    }
  });

  it("flatMap chains Ok computations and propagates first Err", () => {
    const parseNumber = (s: string) => {
      const n = Number(s);
      return Number.isNaN(n) ? err(new Error("NaN")) : ok(n);
    };

    const res1 = flatMap(ok("100"), parseNumber);
    expect(unwrap(res1)).toBe(100);

    const res2 = flatMap(ok("invalid"), parseNumber);
    expect(isErr(res2)).toBe(true);

    const res3 = flatMap(err(new Error("initial fail")), parseNumber);
    expect(isErr(res3)).toBe(true);
  });

  it("unwrap extracts value or throws error", () => {
    expect(unwrap(ok("hello"))).toBe("hello");

    const error = new Error("boom");
    expect(() => unwrap(err(error))).toThrow("boom");
    expect(() => unwrap(err("string-error"))).toThrow("string-error");
  });

  it("unwrapOr extracts value or returns fallback", () => {
    expect(unwrapOr(ok(10), 0)).toBe(10);
    expect(unwrapOr(err(new Error("fail")), 0)).toBe(0);
  });

  it("match executes the appropriate branch", () => {
    const okBranch = match(ok(5), {
      ok: (val) => val * 10,
      err: () => -1,
    });
    expect(okBranch).toBe(50);

    const errBranch = match(err(new Error("fail")), {
      ok: () => "not this",
      err: (e) => e.message,
    });
    expect(errBranch).toBe("fail");
  });
});

describe("result: fromThrowable and fromPromise", () => {
  it("fromThrowable captures thrown exceptions into Err", () => {
    const safeOk = fromThrowable(() => JSON.parse('{"valid":true}'));
    expect(isOk(safeOk)).toBe(true);

    const safeErr = fromThrowable(() => JSON.parse("invalid-json"));
    expect(isErr(safeErr)).toBe(true);
  });

  it("fromPromise captures promise resolution and rejection", async () => {
    const resolved = await fromPromise(Promise.resolve("async-val"));
    expect(unwrap(resolved)).toBe("async-val");

    const rejected = await fromPromise(Promise.reject(new Error("async-fail")));
    expect(isErr(rejected)).toBe(true);
  });
});

describe("result: all (combination helper)", () => {
  it("combines all Ok results into a single array", () => {
    const results = [ok(1), ok(2), ok(3)];
    const combined = all(results);
    expect(unwrap(combined)).toEqual([1, 2, 3]);
  });

  it("short-circuits on the first Err encountered", () => {
    const results = [ok(1), err(new Error("first error")), ok(3), err(new Error("second error"))];
    const combined = all(results);
    expect(isErr(combined)).toBe(true);
    if (isErr(combined)) {
      expect(combined.error.message).toBe("first error");
    }
  });
});
