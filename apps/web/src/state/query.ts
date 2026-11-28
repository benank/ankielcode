import { errorDisplayMessage } from "@ankielcode/client-runtime/errors";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useContext } from "react";

import { m, type MessageResolver } from "../i18n/messages";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface EnvironmentQueryView<A, E = unknown> {
  readonly data: A | null;
  readonly dataUpdatedAt: number;
  readonly error: string | null;
  readonly failure: E | null;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

export function formatEnvironmentQueryError(
  cause: Cause.Cause<unknown>,
  resolve: MessageResolver = m,
): string {
  const error = Cause.squash(cause);
  return (
    (error instanceof Error ? errorDisplayMessage(error, resolve) : null) ??
    resolve(msg("The environment request failed."))
  );
}

function queryUpdatedAt(result: AsyncResult.AsyncResult<unknown, unknown>): number {
  return result._tag === "Success"
    ? result.timestamp
    : result._tag === "Failure"
      ? (Option.getOrNull(result.previousSuccess)?.timestamp ?? 0)
      : 0;
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  resolve: MessageResolver = m,
): EnvironmentQueryView<A, E> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: AsyncResult.getOrElse(result, () => null),
    dataUpdatedAt: queryUpdatedAt(result),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause, resolve) : null,
    failure:
      result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null,
    isPending: atom !== null && result.waiting,
    isSuccess: result._tag === "Success",
    refresh,
  };
}

/** Returns refresh and call-time pending state without subscribing to it. */
export function useEnvironmentQueryRefresh<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): { readonly refresh: () => void; readonly isPending: () => boolean } {
  const registry = useContext(RegistryContext);
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const refresh = useAtomRefresh(selectedAtom);
  return { refresh, isPending: () => atom !== null && registry.get(selectedAtom).waiting };
}
