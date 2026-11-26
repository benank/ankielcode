import { thrownErrorMessage } from "@ankielcode/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@ankielcode/client-runtime/state/runtime";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type EnvironmentId,
} from "@ankielcode/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import { StatusPill } from "../../components/StatusPill";
import { connectionTone } from "../connection/connectionTone";
import { m as resolveMessage } from "../../i18n/messages";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useEnvironmentQuery } from "../../state/query";
import { relayTunnelEnvironment } from "../../state/relayTunnel";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function EnvironmentRelaySection({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canWriteAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const relayStatusQuery = useEnvironmentQuery(
    connected && canReadAccess ? relayTunnelEnvironment.status({ environmentId, input: {} }) : null,
  );
  const configureRelay = useAtomCommand(relayTunnelEnvironment.configure, {
    reportFailure: false,
  });
  const disconnectRelay = useAtomCommand(relayTunnelEnvironment.disconnect, {
    reportFailure: false,
  });

  const [editing, setEditing] = useState(false);
  const [setupInput, setSetupInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!connected || !canReadAccess) return null;

  const status = relayStatusQuery.data;
  const isLoading = relayStatusQuery.isPending && status === null;
  const queryError = relayStatusQuery.error;
  const isEnvManaged = status?.source === "env";
  const isConfigured = status?.configured === true;
  const isConnected = status?.connected === true;
  const publicBaseUrl = status?.publicBaseUrl ?? null;

  const openEditor = () => {
    setSetupInput("");
    setFormError(null);
    setRowError(null);
    setNotice(null);
    setEditing(true);
  };

  const closeEditor = () => {
    if (isSaving) return;
    setEditing(false);
    setSetupInput("");
    setFormError(null);
  };

  const handleSave = async (rawValue?: string) => {
    const trimmed = (rawValue ?? setupInput).trim();
    if (!trimmed) {
      setFormError(gt("Paste a relay setup string to continue."));
      return;
    }
    setIsSaving(true);
    setFormError(null);
    setRowError(null);
    setNotice(null);
    const result = await configureRelay({
      environmentId,
      input: { setup: trimmed },
    });
    setIsSaving(false);
    if (result._tag === "Success") {
      setSetupInput("");
      setEditing(false);
      setNotice(result.value.connected ? gt("Remote relay connected.") : gt("Remote relay saved."));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Could not configure remote relay.");
      setFormError(message);
    }
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    setRowError(null);
    setNotice(null);
    const result = await disconnectRelay({
      environmentId,
      input: {},
    });
    setIsDisconnecting(false);
    if (result._tag === "Success") {
      setEditing(false);
      setNotice(gt("Remote relay disconnected."));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Could not disconnect remote relay.");
      setRowError(message);
    }
  };

  const confirmDisconnect = () => {
    if (isDisconnecting) return;
    Dialog.confirm({
      title: gt("Disconnect remote relay?"),
      message: gt(
        "This stops the outbound relay tunnel and removes the saved relay secret from this machine. Devices connected through the relay will lose access until you reconnect.",
      ),
      confirmText: gt("Disconnect"),
      destructive: true,
      onConfirm: () => {
        void handleDisconnect();
      },
    });
  };

  const handleCopyUrl = async () => {
    if (!publicBaseUrl) return;
    const ok = await tryCopyTextWithHaptic(publicBaseUrl, { target: "relay URL" });
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_800);
    }
  };

  const description = isLoading
    ? gt("Loading…")
    : isConnected && publicBaseUrl
      ? publicBaseUrl
      : isConfigured
        ? (status.relayOrigin ?? gt("Connecting to remote relay…"))
        : gt("Connect a self-hosted Cloudflare Relay for remote and mobile access.");

  const activeError = rowError ?? queryError;

  return (
    <SettingsSection title={gt("Remote relay")}>
      <View className="gap-1.5 bg-grouped-card p-4">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-base font-ankiel-medium text-foreground">
            <T>Cloudflare Relay</T>
          </Text>
          {isConnected ? (
            <StatusPill size="compact" {...connectionTone("connected", messages)} />
          ) : isConfigured ? (
            <StatusPill size="compact" {...connectionTone("connecting", messages)} />
          ) : null}
        </View>
        <Text selectable className="text-sm text-foreground-muted">
          {description}
        </Text>
        {activeError ? (
          <Text selectable className="text-sm text-danger-foreground">
            {activeError}
          </Text>
        ) : isConfigured && !isConnected ? (
          status.lastError ? (
            <Text selectable className="text-sm text-danger-foreground">
              {status.lastError}
            </Text>
          ) : (
            <Text className="text-sm text-foreground-muted">
              <T>Connecting to relay…</T>
            </Text>
          )
        ) : null}
        {isEnvManaged ? (
          <Text className="text-xs text-foreground-muted">
            <T>Configured via environment variables.</T>
          </Text>
        ) : null}
        {notice ? <Text className="text-sm text-foreground-muted">{notice}</Text> : null}
      </View>

      {editing ? (
        <View className="gap-3 border-t border-border-subtle bg-grouped-card p-4">
          <Text className="text-sm font-ankiel-medium text-foreground">
            {isConfigured ? <T>Change remote relay</T> : <T>Connect remote relay</T>}
          </Text>
          <SecretTextInput
            accessibilityLabel={gt("Relay setup string")}
            placeholder="ankiel-relay://your-relay.workers.dev#secret"
            value={setupInput}
            onChangeText={(value) => {
              setSetupInput(value);
              if (formError) setFormError(null);
            }}
            onSubmitEditing={(value) => {
              void handleSave(value);
            }}
            editable={!isSaving}
            returnKeyType="done"
          />
          <Text className="text-xs text-foreground-muted">
            <T>
              Paste the setup string printed by your self-hosted Cloudflare Relay setup script (run
              npm run setup in the relay/ directory).
            </T>
          </Text>
          {formError ? (
            <Text selectable className="text-xs text-danger-foreground">
              {formError}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap items-center justify-end gap-2 pt-1">
            <Button
              label={gt("Cancel")}
              tone="secondary"
              size="compact"
              disabled={isSaving}
              onPress={closeEditor}
            />
            <Button
              label={isSaving ? gt("Connecting…") : gt("Connect")}
              tone="primary"
              size="compact"
              loading={isSaving}
              disabled={isSaving || setupInput.trim().length === 0}
              onPress={() => {
                void handleSave();
              }}
            />
          </View>
        </View>
      ) : null}

      {publicBaseUrl ? (
        <SettingsActionRow
          icon="doc.on.doc"
          label={copied ? gt("Copied") : gt("Copy relay URL")}
          onPress={() => {
            void handleCopyUrl();
          }}
        />
      ) : null}

      {!isEnvManaged && canWriteAccess && !editing ? (
        <SettingsActionRow
          icon="globe"
          label={isConfigured ? gt("Change remote relay") : gt("Connect remote relay")}
          disabled={isLoading || isDisconnecting}
          onPress={openEditor}
        />
      ) : null}

      {isConfigured && !isEnvManaged && canWriteAccess ? (
        <SettingsActionRow
          icon="xmark"
          label={isDisconnecting ? gt("Disconnecting…") : gt("Disconnect remote relay")}
          disabled={isSaving || isDisconnecting}
          loading={isDisconnecting}
          onPress={confirmDisconnect}
        />
      ) : null}
    </SettingsSection>
  );
}
