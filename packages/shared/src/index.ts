// PR3: packages/shared — Public API Surface
//
// Cross-cutting, domain-neutral contracts and primitives for the ai-desktop
// monorepo. Every package in the workspace may depend on this package.
//
// Dependency rule:
//   shared -> nothing (no internal workspace dependencies)

export * from "./ids.js";
export * from "./result.js";
export * from "./errors.js";
export * from "./time.js";
export * from "./ipc-contract.js";
