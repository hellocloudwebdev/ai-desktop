// PR40: apps/desktop — Realtime Errors
//
// Typed realtime failures following BaseError conventions. Renderer-facing
// messages are safe (no secrets, paths, or provider internals).

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";

export class RealtimeError extends BaseError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "RealtimeError";
  }
}

export class RealtimePermissionError extends RealtimeError {
  constructor(message = "Microphone/realtime permission denied", options?: ErrorOptions) {
    super("REALTIME_PERMISSION_DENIED", message, options);
    this.name = "RealtimePermissionError";
  }
}

export class RealtimeCapabilityError extends RealtimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("REALTIME_CAPABILITY_UNSUPPORTED", message, options);
    this.name = "RealtimeCapabilityError";
  }
}

export class RealtimeTransportError extends RealtimeError {
  constructor(message = "Realtime transport failed", options?: ErrorOptions) {
    super("REALTIME_TRANSPORT_FAILED", message, options);
    this.name = "RealtimeTransportError";
  }
}

export class RealtimeAudioError extends RealtimeError {
  constructor(message = "Invalid realtime audio", options?: ErrorOptions) {
    super("REALTIME_AUDIO_INVALID", message, options);
    this.name = "RealtimeAudioError";
  }
}

export class RealtimeProviderError extends RealtimeError {
  constructor(message = "Realtime provider failed", options?: ErrorOptions) {
    super("REALTIME_PROVIDER_FAILED", message, options);
    this.name = "RealtimeProviderError";
  }
}

export class RealtimeSessionStateError extends RealtimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("REALTIME_INVALID_STATE", message, options);
    this.name = "RealtimeSessionStateError";
  }
}

export class RealtimeTimeoutError extends RealtimeError {
  constructor(message = "Realtime operation timed out", options?: ErrorOptions) {
    super("REALTIME_TIMEOUT", message, options);
    this.name = "RealtimeTimeoutError";
  }
}

export class RealtimeCancelledError extends RealtimeError {
  constructor(message = "Realtime session cancelled", options?: ErrorOptions) {
    super("REALTIME_CANCELLED", message, options);
    this.name = "RealtimeCancelledError";
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ABORT_ERR")
  );
}

export function toCanonicalRealtimeError(err: unknown): RealtimeError {
  if (err instanceof RealtimeError) {
    return err;
  }
  if (isAbortError(err)) {
    return new RealtimeCancelledError();
  }
  if (err instanceof Error) {
    if (/timed out|timeout|ETIMEDOUT/i.test(err.message)) {
      return new RealtimeTimeoutError(err.message);
    }
    return new RealtimeProviderError(err.message, { cause: err });
  }
  return new RealtimeProviderError(`Unknown realtime failure: ${String(err)}`);
}
