import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PushAlertKind, PushStatus } from "@ankielcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useEffect, useState } from "react";
import { AppState, Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { pushEnvironment } from "../../state/push";
import { useEnvironmentQuery } from "../../state/query";
import {
  environmentConnectedAtom,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  preparePushNotifications,
  pushDeviceStatusAtom,
  pushSupportedOnPlatform,
  readPushPermission,
  type PushPermission,
} from "../agent-awareness/pushRegistration";
import { PUSH_ALERT_KINDS, pushAlertKinds } from "../agent-awareness/pushRegistrationPlan";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const KIND_LABELS: Readonly<Record<PushAlertKind, string>> = {
  completed: msg("Finished", { $context: "push alert kind: an agent finished its work" }),
  failed: msg("Failed", { $context: "push alert kind: an agent's run failed" }),
  approval: msg("Needs approval", { $context: "push alert kind" }),
  input: msg("Needs input", { $context: "push alert kind" }),
};

export function SettingsNotificationsRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {pushSupportedOnPlatform ? (
          <PushSettings />
        ) : (
          <Text className="px-2 text-sm text-foreground-muted">
            <T>Push alerts aren't available on Android yet.</T>
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function usePushPermission() {
  const [permission, setPermission] = useState<PushPermission | null>(null);
  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- mirrors the system permission, which can change in iOS Settings while this page is open
  useEffect(() => {
    let active = true;
    const read = () => {
      void readPushPermission()
        .then((next) => {
          if (active) setPermission(next);
        })
        .catch(() => undefined);
    };
    read();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return [permission, setPermission] as const;
}

function PushSettings() {
  const gt = useGT();
  const m = useMessages();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const deviceStatus = useAtomValue(pushDeviceStatusAtom);
  const [permission, setPermission] = usePushPermission();
  const [preparing, setPreparing] = useState(false);
  const { savedConnectionsById } = useSavedRemoteConnections();

  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const enabled = preferences.pushNotificationsEnabled === true;
  const kinds = pushAlertKinds(preferences);
  const unavailable = deviceStatus === "unavailable";

  const turnOn = async () => {
    setPreparing(true);
    const result = await preparePushNotifications().catch(() => "unavailable" as const);
    if (result !== "unavailable") setPermission(result);
    if (result === "granted") await savePreferences({ pushNotificationsEnabled: true });
    setPreparing(false);
  };

  const setKind = (kind: PushAlertKind, on: boolean) => {
    const next = on ? [...kinds, kind] : kinds.filter((candidate) => candidate !== kind);
    void savePreferences({
      pushNotificationKinds: PUSH_ALERT_KINDS.filter((value) => next.includes(value)),
    });
  };

  return (
    <>
      <SettingsSection
        footer={unavailable ? gt("Push notifications aren't available in this build.") : undefined}
      >
        <SettingsSwitchRow
          icon="bell.badge"
          label={gt("Push notifications")}
          subtitle={gt("Get an alert when an agent finishes, fails or needs you.")}
          value={enabled}
          disabled={!preferencesReady || preparing}
          onValueChange={(value) => {
            if (value) void turnOn();
            else void savePreferences({ pushNotificationsEnabled: false });
          }}
        />
      </SettingsSection>

      {permission === "denied" ? (
        <SettingsSection
          footer={gt("Notifications are turned off for Ankiel Code in iOS Settings.")}
        >
          <ListActionRow
            icon="gearshape"
            label={gt("Open notification settings")}
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        </SettingsSection>
      ) : null}

      {enabled ? (
        <SettingsSection
          title={gt("Alerts", { $context: "settings section listing which push alerts to send" })}
        >
          {PUSH_ALERT_KINDS.map((kind) => (
            <SettingsSwitchRow
              key={kind}
              label={m(KIND_LABELS[kind])}
              value={kinds.includes(kind)}
              disabled={!preferencesReady}
              onValueChange={(value) => setKind(kind, value)}
            />
          ))}
        </SettingsSection>
      ) : null}

      {enabled && Object.keys(savedConnectionsById).length > 0 ? (
        <SettingsSection title={gt("Computers")}>
          {Object.values(savedConnectionsById).map((connection) => (
            <PushEnvironmentStatusRow
              key={connection.environmentId}
              environmentId={connection.environmentId}
              label={connection.environmentLabel}
            />
          ))}
        </SettingsSection>
      ) : null}

      <Text className="px-2 text-sm text-foreground-muted">
        <T>
          Alerts are delivered through each computer's own Cloudflare relay, so a computer without a
          relay can't send them. They stay quiet while the app is open.
        </T>
      </Text>
    </>
  );
}

function pushStatusLabel(status: PushStatus | null, connected: boolean) {
  if (!connected) return msg("Not connected", { $context: "push notification status" });
  if (status === null) return msg("Checking…", { $context: "push notification status" });
  if (!status.relayConfigured) return msg("Relay not set up on this computer");
  if (!status.relayConnected) return msg("Relay offline");
  if (!status.available.ios) return msg("Relay has no push key");
  return status.registration === null
    ? msg("Not registered yet", { $context: "push notification status" })
    : msg("On", { $context: "push notification status" });
}

function PushEnvironmentStatusRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const m = useMessages();
  const connected = useAtomValue(environmentConnectedAtom(props.environmentId));
  const query = useEnvironmentQuery(
    connected ? pushEnvironment.status({ environmentId: props.environmentId, input: {} }) : null,
  );
  const detail =
    connected && query.error !== null ? query.error : m(pushStatusLabel(query.data, connected));
  return (
    <View className="bg-grouped-card">
      <ListRowLayout icon="desktopcomputer" label={props.label} description={detail} />
    </View>
  );
}
