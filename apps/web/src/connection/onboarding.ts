import { ConnectionOnboarding } from "@ankielcode/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@ankielcode/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const claimPairingInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:claim-pairing-invite",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingInviteClaimInput) =>
      `${input.invite.baseUrl}:${input.invite.inviteId}:${input.expectedEnvironmentId ?? ""}`,
  },
  execute: (input: ConnectionOnboarding.PairingInviteClaimInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.claimPairingInvite(input)),
    ),
});

export const pollPairingInviteClaim = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:poll-pairing-invite-claim",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingInvitePollInput) =>
      `${input.httpBaseUrl}:${input.inviteId}`,
  },
  execute: (input: ConnectionOnboarding.PairingInvitePollInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.pollPairingInviteClaim(input)),
    ),
});

export const completePairingInvite = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:complete-pairing-invite",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingInviteCompleteInput) =>
      `${input.httpBaseUrl}:${input.environmentId}:${input.expectedEnvironmentId ?? ""}`,
  },
  execute: (input: ConnectionOnboarding.PairingInviteCompleteInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.completePairingInvite(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});
