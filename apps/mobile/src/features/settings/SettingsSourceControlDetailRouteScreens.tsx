import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { sourceControlClients } from "@ankielcode/client-runtime/source-control-clients";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SourceControlProviderKind,
} from "@ankielcode/contracts";
import * as Option from "effect/Option";
import { T, useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  SourceControlHostFieldsForm,
  SourceControlTokenForm,
  sourceControlProviderSummary,
} from "./components/SourceControlProvidersSection";
import { AppSignInRow } from "./components/SourceControlSignInSection";
import type { SettingsTarget } from "./settings-environment-filter";

/** The environment a detail page edits, once it is connected, and whether this session may. */
function useDetailEnvironment(environmentId: EnvironmentId) {
  const { environments } = useEnvironments();
  const environment = environments.find(
    (entry): entry is SettingsTarget =>
      entry.environmentId === environmentId &&
      entry.connection.phase === "connected" &&
      entry.serverConfig !== null,
  );
  const writable = useEnvironmentsWithScope(
    environment ? [environment] : [],
    AuthSettingsWriteScope,
  );
  return { environment, canWrite: writable.has(environmentId) };
}

function DetailPage(props: { readonly title: string; readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={props.title}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </SettingsScreen>
  );
}

const Unavailable = () => (
  <Text className="px-2 text-base text-foreground-muted">
    <T>Connect this environment to change its settings.</T>
  </Text>
);

export function SettingsSourceControlProviderRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly kind: SourceControlProviderKind;
}>) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, kind } = route.params;
  const { environment, canWrite } = useDetailEnvironment(environmentId);
  const definition = sourceControlClients.find(kind);
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const item = discovery.data?.sourceControlProviders.find((entry) => entry.kind === kind);
  const credentials = definition?.credentials;
  const appSignIn = item?.appSignIn === true ? credentials?.appSignIn : undefined;
  const disabled = !canWrite || !canUpdate;
  return (
    <DetailPage
      title={
        definition?.label ??
        gt("Provider", { $context: "settings page of one source control provider" })
      }
    >
      {!environment || !definition ? (
        <Unavailable />
      ) : (
        <>
          {item ? (
            <Text selectable className="px-2 text-sm text-foreground-muted">
              {[Option.getOrNull(item.version), sourceControlProviderSummary(item, messages)]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
          {appSignIn ? (
            <SettingsSection
              title={gt("Sign in", { $context: "settings section title" })}
              footer={gt("A far higher API rate limit than a personal token or CLI login.")}
            >
              <AppSignInRow
                environment={environment}
                label={appSignIn.appName}
                definition={definition}
                appSignIn={appSignIn}
                disabled={disabled}
              />
            </SettingsSection>
          ) : null}
          {!credentials && definition.settings ? (
            <SettingsSection title={gt("Credentials")}>
              <SourceControlHostFieldsForm
                environment={environment}
                definition={definition}
                settings={definition.settings}
                disabled={disabled}
                onSaved={discovery.refresh}
              />
            </SettingsSection>
          ) : null}
          {credentials ? (
            <SettingsSection
              title={
                appSignIn
                  ? gt("Or use your own credentials")
                  : gt("Token", { $context: "access token field" })
              }
            >
              <SourceControlTokenForm
                environment={environment}
                definition={definition}
                credentials={credentials}
                disabled={disabled}
                onSaved={discovery.refresh}
              />
            </SettingsSection>
          ) : null}
        </>
      )}
    </DetailPage>
  );
}
