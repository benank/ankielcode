import { SourceControlProviderKind } from "@ankielcode/contracts";
import {
  providerAuth,
  type SourceControlProviderDiscoverySpec,
} from "@ankielcode/source-control-core/server/discovery";
import type { SourceControlDriverInstance } from "@ankielcode/source-control-core/server/driver";
import type * as SourceControlProvider from "@ankielcode/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";

const kindOf = (kind: string) => SourceControlProviderKind.make(kind);

type SourceControlProviderService = SourceControlProvider.SourceControlProvider["Service"];

const unexpected = (kind: string, operation: string) => () =>
  Effect.die(`Unexpected ${kind} ${operation} in a test that supplied none.`);

/** A source control provider whose every operation dies unless the test supplies it. */
export function fakeSourceControlProvider(
  kind: string,
  overrides: Partial<SourceControlProviderService> = {},
): SourceControlProviderService {
  return {
    kind: kindOf(kind),
    getRepositoryCloneUrls: unexpected(kind, "getRepositoryCloneUrls"),
    createRepository: unexpected(kind, "createRepository"),
    getDefaultBranch: unexpected(kind, "getDefaultBranch"),
    ...overrides,
  };
}

/** Discovery over an API integration that reports an unknown sign-in. */
export function fakeDiscovery(
  kind: string,
  overrides: Partial<Extract<SourceControlProviderDiscoverySpec, { readonly type: "api" }>> = {},
): SourceControlProviderDiscoverySpec {
  return {
    type: "api",
    kind: kindOf(kind),
    label: kind,
    installHint: `Install ${kind}.`,
    probeAuth: Effect.succeed(providerAuth({ status: "unknown" })),
    ...overrides,
  };
}

export interface FakeSourceControlDriverOptions {
  readonly sourceControl?: Partial<SourceControlProviderService>;
  readonly discovery?: SourceControlProviderDiscoverySpec;
  readonly fetchMedia?: SourceControlDriverInstance["fetchMedia"];
}
