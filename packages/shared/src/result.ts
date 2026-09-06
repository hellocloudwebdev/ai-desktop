// PR3: packages/shared — Domain-neutral Result Primitive
//
// Represents either a successful computation yielding a value T or a failure
// yielding an error E. Keeps error handling explicit and typed without
// coupling to any provider-, storage-, or execution-specific concerns.

export type Result<T, E = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };

/**
 * Creates an Ok Result containing the specified value.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Creates an Err Result containing the specified error.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Type guard that narrows a Result to Ok.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/**
 * Type guard that narrows a Result to Err.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

/**
 * Transforms the value of an Ok Result using the provided mapping function.
 */
export function map<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * Transforms the error of an Err Result using the provided mapping function.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (!result.ok) {
    return err(fn(result.error));
  }
  return result;
}

/**
 * Chains a function returning a Result onto an Ok Result (monadic bind).
 */
export function flatMap<T, E, U>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}

/**
 * Extracts the value of an Ok Result, or throws the contained error if it is an Err.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof Error) {
    throw result.error;
  }
  throw new Error(`Unwrap failed: ${String(result.error)}`, { cause: result.error });
}

/**
 * Extracts the value of an Ok Result, or returns the provided fallback if it is an Err.
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  if (result.ok) {
    return result.value;
  }
  return fallback;
}

/**
 * Matches on a Result, evaluating the corresponding branch.
 */
export function match<T, E, U>(
  result: Result<T, E>,
  branches: { ok: (value: T) => U; err: (error: E) => U },
): U {
  if (result.ok) {
    return branches.ok(result.value);
  }
  return branches.err(result.error);
}

/**
 * Executes a synchronous function, returning Ok with its value or Err with caught error.
 */
export function fromThrowable<T, E = Error>(
  fn: () => T,
  mapErrFn: (thrown: unknown) => E = (e) =>
    e instanceof Error ? (e as unknown as E) : (new Error(String(e)) as unknown as E),
): Result<T, E> {
  try {
    return ok(fn());
  } catch (caught) {
    return err(mapErrFn(caught));
  }
}

/**
 * Awaits a promise, returning Ok with the resolved value or Err with the rejected reason.
 */
export async function fromPromise<T, E = Error>(
  promise: Promise<T>,
  mapErrFn: (thrown: unknown) => E = (e) =>
    e instanceof Error ? (e as unknown as E) : (new Error(String(e)) as unknown as E),
): Promise<Result<T, E>> {
  try {
    const value = await promise;
    return ok(value);
  } catch (caught) {
    return err(mapErrFn(caught));
  }
}

/**
 * Combines an iterable of Results into a single Result containing an array of values,
 * or short-circuits on the first Err encountered.
 */
export function all<T, E>(results: Iterable<Result<T, E>>): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    values.push(result.value);
  }
  return ok(values);
}
