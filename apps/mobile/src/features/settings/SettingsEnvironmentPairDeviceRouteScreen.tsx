import { connectionRouteId } from "@ankielcode/client-runtime/connection";
import { errorDisplayMessage } from "@ankielcode/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
} from "@ankielcode/client-runtime/state/runtime";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthPairingInviteStatus,
  type EnvironmentId,
} from "@ankielcode/contracts";
import { buildPairingInviteAppLink, type PairingInvitePayload } from "@ankielcode/shared/remote";
import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { msg, T, useGT, useMessages, Var } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { StatusPill } from "../../components/StatusPill";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentCatalog } from "../../connection/catalog";
import { m } from "../../i18n/messages";
import {
  isHandoffSupported,
  startPairingHandoffActivity,
  stopPairingHandoffActivity,
} from "../../native/handoff";
import { appAtomRegistry } from "../../state/atom-registry";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { relayTunnelEnvironment } from "../../state/relayTunnel";
import { environmentSession, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  classifyPairingPollError,
  cleanupPairingInviteCacheFiles,
  formatClaimDeviceFallback,
  formatCountdown,
  isFullStandardClientScopeSet,
  resolveDefaultPairingScopes,
  selectShareablePairingBaseUrl,
  sessionGrantedScopes,
  sharePairingInviteFile,
} from "./pairDevice.logic";

const POLL_INTERVAL_MS = 1_000;

type PairingFlowState =
  | { readonly phase: "creating" }
  | {
      readonly phase: "pending";
      readonly invite: PairingInvitePayload;
      readonly expiresAt: string;
    }
  | {
      readonly phase: "claimed";
      readonly invite: PairingInvitePayload;
      readonly claim: NonNullable<AuthPairingInviteStatus["claim"]>;
      readonly scopes: AuthPairingInviteStatus["scopes"];
    }
  | {
      readonly phase: "approved";
      readonly inviteId: string;
    }
  | {
      readonly phase: "terminal";
      readonly reason: "expired" | "denied" | "cancelled";
    }
  | {
      readonly phase: "error";
      readonly message: string;
    };

export function SettingsEnvironmentPairDeviceRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>) {
  return (
    <PairDeviceFlow key={route.params.environmentId} environmentId={route.params.environmentId} />
  );
}

function PairDeviceFlow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const connections = useRemoteConnections();
  const environment = connections.connectedEnvironments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const entry = useAtomValue(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  const prepared = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const connected = environment?.isEnabled === true && environment.connectionState === "connected";
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const relayStatusQuery = useEnvironmentQuery(
    connected && canReadAccess ? relayTunnelEnvironment.status({ environmentId, input: {} }) : null,
  );
  const [attempt, setAttempt] = useState(0);
  const [initialBaseUrl, setInitialBaseUrl] = useState<string | null>(null);

  const activeRouteId =
    connected && Option.isSome(prepared) ? connectionRouteId(prepared.value.target) : null;
  const relayPending =
    connected &&
    canReadAccess &&
    relayStatusQuery.isPending &&
    relayStatusQuery.data === null &&
    relayStatusQuery.error === null;
  const shareableBaseUrl = relayPending
    ? null
    : selectShareablePairingBaseUrl({
        relayStatus: relayStatusQuery.data,
        entry,
        activeRouteId,
      });

  const readyBaseUrl =
    environment && connected && canWriteAccess && !relayPending ? shareableBaseUrl : null;
  const sessionBaseUrl = initialBaseUrl ?? readyBaseUrl;
  if (initialBaseUrl === null && readyBaseUrl !== null) {
    setInitialBaseUrl(readyBaseUrl);
  }

  const environmentLabel = environment?.environmentLabel ?? gt("Environment");

  const handleRestart = () => {
    setAttempt((current) => current + 1);
    setInitialBaseUrl(readyBaseUrl);
  };

  const renderContent = () => {
    if (!environment) {
      return (
        <View className="gap-4">
          <View className="items-center gap-3 rounded-3xl bg-grouped-card p-6">
            <SymbolView
              name="exclamationmark.circle"
              size={36}
              tintColorClassName="accent-icon-muted"
            />
            <Text className="text-center text-base text-foreground-muted">
              <T>This environment is no longer saved on this device.</T>
            </Text>
          </View>
          <Button
            label={gt("Done", { $context: "button label, closes screen" })}
            tone="primary"
            fullWidth
            onPress={() => navigation.goBack()}
          />
        </View>
      );
    }

    if (sessionBaseUrl !== null) {
      return (
        <ActivePairingSession
          key={attempt}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          shareableBaseUrl={sessionBaseUrl}
          connected={connected}
          onRestart={handleRestart}
          onClose={() => navigation.goBack()}
        />
      );
    }

    if (!connected) {
      return (
        <View className="gap-4">
          <View className="items-center gap-3 rounded-3xl bg-grouped-card p-6">
            <SymbolView name="wifi.slash" size={36} tintColorClassName="accent-icon-muted" />
            <Text className="text-center text-lg font-ankiel-semibold text-foreground">
              <T>Environment disconnected</T>
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              <T>Connect this environment before pairing another device.</T>
            </Text>
          </View>
          <Button
            label={gt("Back to environment")}
            tone="primary"
            fullWidth
            onPress={() => navigation.goBack()}
          />
        </View>
      );
    }

    if (!canWriteAccess) {
      return (
        <View className="gap-4">
          <View className="items-center gap-3 rounded-3xl bg-grouped-card p-6">
            <SymbolView
              name="exclamationmark.circle"
              size={36}
              tintColorClassName="accent-icon-muted"
            />
            <Text className="text-center text-lg font-ankiel-semibold text-foreground">
              <T>Permission required</T>
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              <T>This connection does not have permission to pair other devices.</T>
            </Text>
          </View>
          <Button
            label={gt("Back to environment")}
            tone="primary"
            fullWidth
            onPress={() => navigation.goBack()}
          />
        </View>
      );
    }

    if (relayPending) {
      return (
        <View className="items-center gap-4 rounded-3xl bg-grouped-card px-6 py-10">
          <AppActivityIndicator size="large" colorClassName="accent-icon" />
          <View className="items-center gap-1">
            <Text className="text-base font-ankiel-medium text-foreground">
              <T>Preparing pairing invite…</T>
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              {gt("Setting up a one-time invite for {environment}.", {
                environment: environmentLabel,
              })}
            </Text>
          </View>
        </View>
      );
    }

    return (
      <View className="gap-4">
        <View className="items-center gap-3 rounded-3xl bg-grouped-card p-6">
          <SymbolView name="wifi.slash" size={36} tintColorClassName="accent-icon-muted" />
          <Text className="text-center text-lg font-ankiel-semibold text-foreground">
            <T>No shareable route found</T>
          </Text>
          <Text className="text-center text-sm text-foreground-muted">
            <T>Configure Cloudflare Relay or a network route before pairing another device.</T>
          </Text>
        </View>
        <Button
          label={gt("Configure routes")}
          tone="primary"
          fullWidth
          onPress={() => navigation.goBack()}
        />
      </View>
    );
  };

  return (
    <SettingsScreen title={gt("Pair a Device")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {renderContent()}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ActivePairingSession({
  environmentId,
  environmentLabel,
  shareableBaseUrl,
  connected,
  onRestart,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly shareableBaseUrl: string;
  readonly connected: boolean;
  readonly onRestart: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const handoffSupported = isHandoffSupported();

  const approveInvite = useAtomCommand(authEnvironment.approvePairingInvite, {
    reportFailure: false,
  });
  const denyInvite = useAtomCommand(authEnvironment.denyPairingInvite, {
    reportFailure: false,
  });

  // Snapshot label and route on session start so mid-flight updates do not recreate the invite.
  const [sessionLabel] = useState(environmentLabel);
  const [sessionBaseUrl] = useState(shareableBaseUrl);
  const [flow, setFlow] = useState<PairingFlowState>({ phase: "creating" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [sharingFile, setSharingFile] = useState(false);
  const [sharingLink, setSharingLink] = useState(false);
  const [submittingDecision, setSubmittingDecision] = useState<"approve" | "deny" | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const activeInviteIdRef = useRef<string | null>(null);
  const connectedRef = useRef(connected);
  const triggerPollNowRef = useRef<(() => void) | null>(null);
  const decisionInFlightRef = useRef(false);
  const claimedHapticForInviteRef = useRef<string | null>(null);

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- lets the polling loop observe network availability and wake on reconnection
  useEffect(() => {
    const wasConnected = connectedRef.current;
    connectedRef.current = connected;
    if (!wasConnected && connected) {
      triggerPollNowRef.current?.();
    }
  }, [connected]);

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- drives server pairing invite creation, Handoff advertisement, sequential status polling, AppState pause/resume, and unmount cancellation
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollInFlight = false;
    let refreshAfterPoll = false;
    let appIsActive = AppState.currentState === "active";
    let pollOnce: (() => Promise<void>) | undefined;
    activeInviteIdRef.current = null;
    decisionInFlightRef.current = false;

    const clearPollTimer = () => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const scheduleNextPoll = () => {
      if (cancelled || !appIsActive || activeInviteIdRef.current === null) return;
      clearPollTimer();
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void pollOnce?.();
      }, POLL_INTERVAL_MS);
    };

    const triggerImmediatePoll = () => {
      if (cancelled || !appIsActive || activeInviteIdRef.current === null) return;
      if (pollInFlight) {
        refreshAfterPoll = true;
        return;
      }
      clearPollTimer();
      void pollOnce?.();
    };

    triggerPollNowRef.current = triggerImmediatePoll;

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      const wasActive = appIsActive;
      appIsActive = nextState === "active";
      if (!appIsActive) {
        clearPollTimer();
        return;
      }
      if (!wasActive) {
        setNowMs(Date.now());
        triggerImmediatePoll();
      }
    });

    const start = async () => {
      const session = appAtomRegistry.get(environmentSession.sessionStateValueAtom(environmentId));
      const scopes = resolveDefaultPairingScopes(sessionGrantedScopes(session));
      const createResult = await runAtomCommand(
        appAtomRegistry,
        authEnvironment.createPairingInvite,
        {
          environmentId,
          input: scopes === undefined ? {} : { scopes },
        },
        { reportFailure: false },
      );
      if (cancelled) {
        if (createResult._tag === "Success") {
          void runAtomCommand(
            appAtomRegistry,
            authEnvironment.denyPairingInvite,
            {
              environmentId,
              input: { inviteId: createResult.value.inviteId },
            },
            { reportFailure: false },
          );
        }
        return;
      }
      if (createResult._tag !== "Success") {
        if (isAtomCommandInterrupted(createResult)) return;
        const failure = squashAtomCommandFailure(createResult);
        setFlow({
          phase: "error",
          message:
            failure instanceof Error
              ? (errorDisplayMessage(failure, m) ?? failure.message)
              : m(msg("Could not create a pairing invite. Try again.")),
        });
        return;
      }

      const created = createResult.value;
      const trimmedLabel = sessionLabel.trim();
      const invite: PairingInvitePayload = {
        version: 1,
        inviteId: created.inviteId,
        environmentId,
        baseUrl: sessionBaseUrl,
        ...(trimmedLabel.length > 0 ? { label: trimmedLabel } : {}),
        expiresAt: created.expiresAt,
      };
      activeInviteIdRef.current = created.inviteId;
      setNowMs(Date.now());
      setFlow({ phase: "pending", invite, expiresAt: created.expiresAt });

      if (isHandoffSupported()) {
        startPairingHandoffActivity({
          title: m(msg("Pair {environment}", { environment: sessionLabel })),
          invite,
        });
      }

      pollOnce = async () => {
        if (cancelled || pollInFlight || !appIsActive || activeInviteIdRef.current === null) return;
        if (decisionInFlightRef.current || !connectedRef.current) {
          scheduleNextPoll();
          return;
        }
        pollInFlight = true;
        refreshAfterPoll = false;
        const pollResult = await runAtomCommand(
          appAtomRegistry,
          authEnvironment.getPairingInvite,
          {
            environmentId,
            input: { inviteId: created.inviteId },
          },
          { reportFailure: false },
        );
        pollInFlight = false;
        if (cancelled || !appIsActive || activeInviteIdRef.current === null) return;
        if (decisionInFlightRef.current) {
          scheduleNextPoll();
          return;
        }
        if (refreshAfterPoll) {
          triggerImmediatePoll();
          return;
        }

        if (pollResult._tag === "Success") {
          const nextStatus = pollResult.value;
          if (nextStatus.status === "pending") {
            setFlow({ phase: "pending", invite, expiresAt: nextStatus.expiresAt });
            scheduleNextPoll();
            return;
          }
          if (nextStatus.status === "claimed" && nextStatus.claim) {
            if (claimedHapticForInviteRef.current !== created.inviteId) {
              claimedHapticForInviteRef.current = created.inviteId;
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
                () => undefined,
              );
            }
            setFlow({
              phase: "claimed",
              invite,
              claim: nextStatus.claim,
              scopes: nextStatus.scopes,
            });
            scheduleNextPoll();
            return;
          }
          if (nextStatus.status === "claimed") {
            scheduleNextPoll();
            return;
          }

          activeInviteIdRef.current = null;
          stopPairingHandoffActivity();
          if (nextStatus.status === "approved") {
            setFlow({ phase: "approved", inviteId: created.inviteId });
          } else {
            setFlow({ phase: "terminal", reason: nextStatus.status });
          }
          return;
        }

        if (!isAtomCommandInterrupted(pollResult)) {
          const classification = classifyPairingPollError(squashAtomCommandFailure(pollResult));
          if (classification.kind === "expired") {
            activeInviteIdRef.current = null;
            stopPairingHandoffActivity();
            setFlow({ phase: "terminal", reason: "expired" });
            return;
          }
          if (classification.kind === "permanent") {
            activeInviteIdRef.current = null;
            stopPairingHandoffActivity();
            setFlow({
              phase: "error",
              message: errorDisplayMessage(classification.error, m) ?? classification.error.message,
            });
            return;
          }
        }

        scheduleNextPoll();
      };

      scheduleNextPoll();
    };

    void start();

    return () => {
      cancelled = true;
      triggerPollNowRef.current = null;
      appStateSubscription.remove();
      clearPollTimer();
      stopPairingHandoffActivity();
      // iOS can keep transferring the file after the share sheet has closed.
      void cleanupPairingInviteCacheFiles();
      const inviteId = activeInviteIdRef.current;
      activeInviteIdRef.current = null;
      if (inviteId !== null) {
        void runAtomCommand(
          appAtomRegistry,
          authEnvironment.denyPairingInvite,
          {
            environmentId,
            input: { inviteId },
          },
          { reportFailure: false },
        );
      }
    };
  }, [environmentId, sessionLabel, sessionBaseUrl]);

  const tickingCountdown = flow.phase === "pending";

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- subscribes to a 1-second timer to update the live invite expiration countdown
  useEffect(() => {
    if (!tickingCountdown) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [tickingCountdown]);

  const handleCancelAndClose = () => {
    stopPairingHandoffActivity();
    const inviteId = activeInviteIdRef.current;
    activeInviteIdRef.current = null;
    if (inviteId !== null) {
      void denyInvite({ environmentId, input: { inviteId } });
    }
    onClose();
  };

  const handleShareFile = async (invite: PairingInvitePayload) => {
    if (sharingFile) return;
    setSharingFile(true);
    setActionError(null);
    const result = await settlePromise(() =>
      sharePairingInviteFile(invite, {
        dialogTitle: gt("Pair {environment}", { environment: environmentLabel }),
      }),
    );
    setSharingFile(false);
    if (AsyncResult.isFailure(result)) {
      const error = squashAtomCommandFailure(result);
      setActionError(
        error instanceof Error
          ? (errorDisplayMessage(error, m) ?? error.message)
          : gt("Could not share the pairing invite file."),
      );
    }
  };

  const handleShareLink = async (invite: PairingInvitePayload) => {
    if (sharingLink) return;
    setSharingLink(true);
    setActionError(null);
    const result = await settlePromise(() =>
      Share.share({
        message: buildPairingInviteAppLink(invite),
      }),
    );
    setSharingLink(false);
    if (AsyncResult.isFailure(result)) {
      const error = squashAtomCommandFailure(result);
      setActionError(
        error instanceof Error
          ? (errorDisplayMessage(error, m) ?? error.message)
          : gt("Could not share the pairing link."),
      );
    }
  };

  const handleApprove = async (inviteId: string, verificationCode: string) => {
    if (decisionInFlightRef.current) return;
    decisionInFlightRef.current = true;
    setSubmittingDecision("approve");
    setActionError(null);
    const result = await approveInvite({
      environmentId,
      input: { inviteId, verificationCode },
    });
    setSubmittingDecision(null);
    if (result._tag === "Success") {
      activeInviteIdRef.current = null;
      stopPairingHandoffActivity();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
        () => undefined,
      );
      setFlow({ phase: "approved", inviteId });
      return;
    }
    decisionInFlightRef.current = false;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setActionError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, m) ?? failure.message)
          : gt("Could not approve this pairing request."),
      );
    }
  };

  const handleDeny = async (inviteId: string) => {
    if (decisionInFlightRef.current) return;
    decisionInFlightRef.current = true;
    setSubmittingDecision("deny");
    setActionError(null);
    const result = await denyInvite({
      environmentId,
      input: { inviteId },
    });
    setSubmittingDecision(null);
    if (result._tag === "Success") {
      activeInviteIdRef.current = null;
      stopPairingHandoffActivity();
      setFlow({ phase: "terminal", reason: "denied" });
      return;
    }
    decisionInFlightRef.current = false;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setActionError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, m) ?? failure.message)
          : gt("Could not deny this pairing request."),
      );
    }
  };

  const reconnectingNotice = !connected ? (
    <View className="flex-row items-center justify-center gap-2 rounded-2xl bg-subtle px-4 py-2.5">
      <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
      <Text className="text-xs font-ankiel-medium text-foreground-muted">
        {gt("Reconnecting to {environment}...", { environment: environmentLabel })}
      </Text>
    </View>
  ) : null;

  if (flow.phase === "creating") {
    return (
      <View className="gap-4">
        {reconnectingNotice}
        <View className="items-center gap-4 rounded-3xl bg-grouped-card px-6 py-10">
          <AppActivityIndicator size="large" colorClassName="accent-icon" />
          <View className="items-center gap-1">
            <Text className="text-base font-ankiel-medium text-foreground">
              <T>Preparing pairing invite…</T>
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              {gt("Setting up a one-time invite for {environment}.", {
                environment: environmentLabel,
              })}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  if (flow.phase === "pending") {
    const remainingMs = Date.parse(flow.expiresAt) - nowMs;
    const expiresLabel = gt("Expires in {time}", {
      time: formatCountdown(remainingMs),
    });

    return (
      <View className="gap-5">
        {reconnectingNotice}
        <View className="gap-3 rounded-3xl bg-grouped-card p-5">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-row items-center gap-3">
              <View className="size-10 items-center justify-center rounded-2xl bg-subtle">
                <SymbolView name="laptopcomputer" size={22} tintColorClassName="accent-icon" />
              </View>
              <Text className="text-lg font-ankiel-semibold text-foreground">
                {handoffSupported ? <T>Ready for Handoff</T> : <T>Ready to pair</T>}
              </Text>
            </View>
            <StatusPill
              size="compact"
              label={expiresLabel}
              pillClassName="bg-subtle"
              textClassName="text-foreground-secondary"
            />
          </View>
          <Text className="text-sm text-foreground-muted">
            {handoffSupported ? (
              <T>
                Click <Var>{"Ankiel Code"}</Var> in your Mac's Dock to continue.
              </T>
            ) : (
              <T>Share the invite file or link to your other device, then confirm the code here.</T>
            )}
          </Text>
        </View>

        {actionError ? <ErrorBanner message={actionError} /> : null}

        <View className="gap-3">
          <Button
            label={Platform.OS === "ios" ? gt("AirDrop to Mac") : gt("Share invite file")}
            icon="square.and.arrow.up"
            tone="primary"
            fullWidth
            loading={sharingFile}
            disabled={sharingLink}
            onPress={() => {
              void handleShareFile(flow.invite);
            }}
          />
          <Button
            label={gt("Share link")}
            icon="link"
            tone="secondary"
            fullWidth
            loading={sharingLink}
            disabled={sharingFile}
            onPress={() => {
              void handleShareLink(flow.invite);
            }}
          />
        </View>

        <View className="items-center">
          <Button label={gt("Cancel")} tone="text" onPress={handleCancelAndClose} />
        </View>
      </View>
    );
  }

  if (flow.phase === "claimed") {
    const { claim } = flow;
    const fallbackName = formatClaimDeviceFallback(claim, messages);
    const deviceTitle = claim.clientLabel ?? fallbackName;
    const clientOs = claim.clientOs.trim();
    const deviceSubtitle = claim.clientLabel
      ? fallbackName
      : clientOs.length > 0 && clientOs.toLowerCase() !== "unknown" && fallbackName !== clientOs
        ? clientOs
        : null;
    const deviceIcon =
      claim.clientDeviceType === "mobile" || claim.clientDeviceType === "tablet"
        ? "iphone"
        : "desktopcomputer";
    const scopeSummary = isFullStandardClientScopeSet(flow.scopes)
      ? gt("Grants full client access to {environment}.", {
          environment: environmentLabel,
        })
      : gt(
          "{count, plural, one {Grants {count} permission to {environment}.} other {Grants {count} permissions to {environment}.}}",
          {
            count: flow.scopes.length,
            environment: environmentLabel,
          },
        );

    return (
      <View className="gap-5">
        {reconnectingNotice}
        <View className="gap-5 rounded-3xl bg-grouped-card p-5">
          <View className="flex-row items-center gap-3">
            <View className="size-11 items-center justify-center rounded-2xl bg-subtle">
              <SymbolView name={deviceIcon} size={22} tintColorClassName="accent-icon" />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text numberOfLines={1} className="text-lg font-ankiel-semibold text-foreground">
                {deviceTitle}
              </Text>
              {deviceSubtitle ? (
                <Text numberOfLines={1} className="text-sm text-foreground-muted">
                  {deviceSubtitle}
                </Text>
              ) : null}
            </View>
            <StatusPill
              size="compact"
              label={gt("Needs approval")}
              pillClassName="bg-subtle"
              textClassName="text-foreground-secondary"
            />
          </View>

          <View className="items-center gap-2 rounded-2xl bg-subtle px-4 py-5">
            <Text textRole="footnote" className="font-ankiel-medium text-foreground-muted">
              <T>Verification code</T>
            </Text>
            <Text
              selectable
              className="font-mono text-3xl font-ankiel-bold tracking-widest text-foreground"
            >
              {claim.verificationCode}
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              <T>Confirm this code matches your other device before approving.</T>
            </Text>
          </View>

          <Text className="text-center text-sm text-foreground-muted">{scopeSummary}</Text>
        </View>

        {actionError ? <ErrorBanner message={actionError} /> : null}

        <View className="gap-3">
          <Button
            label={gt("Approve", { $context: "verb, approve a device pairing request" })}
            icon="checkmark"
            tone="primary"
            fullWidth
            loading={submittingDecision === "approve"}
            disabled={submittingDecision !== null || !connected}
            onPress={() => {
              void handleApprove(flow.invite.inviteId, claim.verificationCode);
            }}
          />
          <Button
            label={gt("Deny", { $context: "verb, deny a device pairing request" })}
            icon="xmark"
            tone="secondary"
            fullWidth
            loading={submittingDecision === "deny"}
            disabled={submittingDecision !== null || !connected}
            onPress={() => {
              void handleDeny(flow.invite.inviteId);
            }}
          />
        </View>
      </View>
    );
  }

  if (flow.phase === "approved") {
    return (
      <View className="gap-5">
        <View className="items-center gap-3 rounded-3xl bg-grouped-card p-6">
          <SymbolView
            name="checkmark.circle.fill"
            size={44}
            tintColorClassName="accent-primary-text"
          />
          <Text className="text-center text-xl font-ankiel-semibold text-foreground">
            <T>Device paired</T>
          </Text>
          <Text className="text-center text-sm text-foreground-muted">
            <T>
              Your device is connecting now. You can manage or revoke its access anytime in Sharing
              & access.
            </T>
          </Text>
        </View>

        <View className="gap-3">
          <Button
            label={gt("Done", { $context: "button label, finishes pairing" })}
            tone="primary"
            fullWidth
            onPress={onClose}
          />
          <Button
            label={gt("Pair another device")}
            tone="secondary"
            fullWidth
            onPress={onRestart}
          />
        </View>
      </View>
    );
  }

  const terminalTitle =
    flow.phase === "error"
      ? gt("Could not start pairing")
      : flow.reason === "expired"
        ? gt("Pairing invite expired")
        : flow.reason === "denied"
          ? gt("Pairing request denied")
          : gt("Pairing cancelled");
  const terminalBody =
    flow.phase === "error"
      ? flow.message
      : flow.reason === "expired"
        ? gt("This invite timed out before another device completed pairing.")
        : flow.reason === "denied"
          ? gt("No access was granted to the requesting device.")
          : gt("The pairing invite was cancelled before completion.");
  const terminalIcon =
    flow.phase === "terminal" && flow.reason === "expired" ? "clock" : "exclamationmark.circle";

  return (
    <View className="gap-5">
      <View className="items-center gap-3 rounded-3xl bg-grouped-card p-6">
        <SymbolView name={terminalIcon} size={40} tintColorClassName="accent-icon-muted" />
        <Text className="text-center text-lg font-ankiel-semibold text-foreground">
          {terminalTitle}
        </Text>
        <Text className="text-center text-sm text-foreground-muted">{terminalBody}</Text>
      </View>

      <View className="gap-3">
        <Button
          label={gt("Try again")}
          icon="arrow.clockwise"
          tone="primary"
          fullWidth
          onPress={onRestart}
        />
        <Button
          label={gt("Done", { $context: "button label, closes screen" })}
          tone="secondary"
          fullWidth
          onPress={onClose}
        />
      </View>
    </View>
  );
}
