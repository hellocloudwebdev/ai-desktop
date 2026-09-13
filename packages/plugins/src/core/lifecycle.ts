// PR32: packages/plugins — Extension Lifecycle State Machine
//
// Invariants:
//   1. Legal transitions only; all else throws ValidationError.
//   2. "uninstalled" is a terminal removal marker (any -> uninstalled).
//   3. Idempotent enable/disable: same-state transitions return ok().

import { ValidationError, type Result, ok, err } from "@ai-desktop/shared";

export type ExtensionLifecycle = "installed" | "enabled" | "active" | "disabled" | "uninstalled";

type TransitionPair = `${ExtensionLifecycle}->${ExtensionLifecycle}`;

const LEGAL_TRANSITIONS = new Set<TransitionPair>([
  // Entry: installation produces "installed" (represented as installed->installed
  // for transition checks, plus the virtual entry point).
  "installed->installed",
  "installed->enabled",
  "disabled->enabled",
  "enabled->active",
  "enabled->disabled",
  "active->disabled",
  // Terminal removal from any state.
  "installed->uninstalled",
  "enabled->uninstalled",
  "active->uninstalled",
  "disabled->uninstalled",
  "uninstalled->uninstalled",
]);

/**
 * Entry transition: a fresh install lands in "installed".
 */
export function initialLifecycle(): ExtensionLifecycle {
  return "installed";
}

export function canTransition(from: ExtensionLifecycle, to: ExtensionLifecycle): boolean {
  return LEGAL_TRANSITIONS.has(`${from}->${to}` as TransitionPair);
}

/**
 * Asserts a lifecycle transition is legal, throwing ValidationError otherwise.
 */
export function assertTransition(from: ExtensionLifecycle, to: ExtensionLifecycle): void {
  if (!canTransition(from, to)) {
    throw new ValidationError(`Illegal extension lifecycle transition: "${from}" -> "${to}"`);
  }
}

/**
 * Idempotent wrapper: same-state enable/disable returns ok without validation.
 * Distinct-state transitions are validated and return ok/err Result.
 */
export function transitionLifecycle(
  from: ExtensionLifecycle,
  to: ExtensionLifecycle,
): Result<ExtensionLifecycle, ValidationError> {
  if (from === to) {
    return ok(from);
  }
  if (!canTransition(from, to)) {
    return err(new ValidationError(`Illegal extension lifecycle transition: "${from}" -> "${to}"`));
  }
  return ok(to);
}
