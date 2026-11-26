import { msg, T, useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionDiagnosis,
  connectionDiagnosisText,
  presentConnectionDiagnosis,
  type EnvironmentPresentation,
} from "@ankielcode/client-runtime/connection";
import type { EnvironmentId } from "@ankielcode/contracts";
import Constants from "expo-constants";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { environmentCatalog } from "../../connection/catalog";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

const HOP_MARK = { ok: "checkmark", failed: "xmark", unchecked: "minus" } as const;
const HOP_NOTE = {
  ok: null,
  failed: msg("Failed", { $context: "connection hop status" }),
  unchecked: msg("Not checked"),
} as const;

/** Same model as the web Settings row; null while connected, off, or not failed. */
export function useConnectionDiagnosis(
  environmentId: EnvironmentId,
  presentation: EnvironmentPresentation | null,
) {
  const messages = useMessages();
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  if (presentation === null || !presentation.entry.enabled) return { diagnosis: null, state };
  const phase = presentation.connection.phase;
  if (phase === "connected" || phase === "unsupported") return { diagnosis: null, state };
  const diagnosis = presentConnectionDiagnosis(
    {
      hostLabel: presentation.entry.target.label,
      state,
      clientVersion: Constants.expoConfig?.version,
      serverVersion: presentation.serverConfig?.environment.serverVersion,
    },
    messages,
  );
  return { diagnosis, state };
}

export function ConnectionDiagnosisDetails(props: {
  readonly hostLabel: string;
  readonly diagnosis: ConnectionDiagnosis;
}) {
  const gt = useGT();
  const m = useMessages();
  const { diagnosis } = props;
  return (
    <View className="gap-3">
      <View className="gap-0.5">
        {diagnosis.hops.map((hop) => {
          const note = HOP_NOTE[hop.result];
          return (
            <View key={hop.hop} className="flex-row items-center gap-2">
              <SymbolView
                name={HOP_MARK[hop.result]}
                size={12}
                tintColorClassName={
                  hop.result === "failed" ? "accent-danger-foreground" : "accent-icon-muted"
                }
              />
              <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
                {note === null ? hop.label : `${hop.label} · ${m(note)}`}
              </Text>
            </View>
          );
        })}
      </View>
      <View className="gap-0.5">
        <Text className="text-sm font-ankiel-bold text-foreground">
          <T>What to try</T>
        </Text>
        {diagnosis.steps.map((step, index) => (
          <Text key={step} className="text-sm text-foreground-muted">
            {`${index + 1}. ${step}`}
          </Text>
        ))}
      </View>
      <Text selectable className="font-mono text-xs text-foreground-muted">
        {diagnosis.facts.map(([label, value]) => `${label}: ${value}`).join("\n")}
      </Text>
      <Button
        label={gt("Copy diagnostics")}
        haptics={false}
        icon="doc.on.doc"
        onPress={() => {
          copyTextWithHaptic(connectionDiagnosisText(props.hostLabel, diagnosis), {
            target: "connection-diagnostics",
          });
        }}
      />
    </View>
  );
}
