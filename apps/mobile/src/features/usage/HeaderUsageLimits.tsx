import { providerClients } from "@ankielcode/client-runtime/provider-clients";
import { normalizeProviderAccentColor } from "@ankielcode/client-runtime/state/provider-instance-display";
import type { ServerProvider, ServerProviderUsageWindow } from "@ankielcode/contracts";
import {
  collectExternalUsageLinks,
  collectLimitAccounts,
  remainingPercent,
} from "@ankielcode/shared/usageLimits";
import { collectLimitNotices } from "@ankielcode/shared/usageLimitsCopy";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Circle, Svg } from "react-native-svg";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { environmentPresentations } from "../../state/presentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  connectedLimitPresentations,
  highestUsagePercent,
  shortPlanLabel,
} from "./headerUsageLimits.logic";
import { resetLabels, useRefreshLimits } from "./UsageLimitsSection";
import { usageProviderKind, useProviderColors } from "./usageProviders";

const RING_RADIUS = 7.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function HeaderUsageLimitsButton() {
  const gt = useGT();
  const navigation = useNavigation();
  const { themeVariables } = useAppearancePreferences();
  const allPresentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const presentations = connectedLimitPresentations(allPresentations);
  const accounts = collectLimitAccounts(presentations);
  const highestUsage = highestUsagePercent(accounts);

  const summary =
    highestUsage === undefined
      ? gt("Provider usage limits")
      : gt("Provider usage limits · highest usage {percent}%", {
          percent: Math.round(highestUsage),
        });

  const clampedUsage = highestUsage === undefined ? 0 : Math.min(Math.max(highestUsage, 0), 100);
  const progressOffset = RING_CIRCUMFERENCE * (1 - clampedUsage / 100);
  const activeStroke =
    highestUsage !== undefined && highestUsage >= 90
      ? themeVariables["--color-danger-foreground"]
      : themeVariables["--color-foreground"];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={summary}
      hitSlop={6}
      onPress={() => {
        void Haptics.selectionAsync();
        navigation.navigate("UsageLimits");
      }}
      className="size-9 items-center justify-center rounded-full active:opacity-60 android:size-10"
    >
      <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
        <Circle
          cx={10}
          cy={10}
          r={RING_RADIUS}
          stroke={themeVariables["--color-foreground-muted"]}
          strokeOpacity={0.35}
          strokeWidth={2.5}
          strokeDasharray={highestUsage === undefined ? "2 2" : undefined}
        />
        {highestUsage !== undefined && highestUsage > 0 ? (
          <Circle
            cx={10}
            cy={10}
            r={RING_RADIUS}
            stroke={activeStroke}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            strokeDashoffset={progressOffset}
            originX={10}
            originY={10}
            rotation={-90}
          />
        ) : null}
      </Svg>
    </Pressable>
  );
}

function useCompactBarColor(driver: ServerProvider["driver"]): string | null {
  const colors = useProviderColors();
  const kind = usageProviderKind(driver);
  return kind ? colors[kind] : null;
}

function RedactedEmail({ value }: { readonly value: string }) {
  const [revealed, setRevealed] = useState(false);
  const gt = useGT();
  return (
    <Pressable
      className="shrink active:opacity-60"
      accessibilityRole="button"
      accessibilityLabel={revealed ? gt("Hide account email") : gt("Reveal account email")}
      onPress={() => setRevealed((current) => !current)}
    >
      <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
        {revealed ? value : "••••••@••••••"}
      </Text>
    </Pressable>
  );
}

function CompactWindowRow({
  window,
  color,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string | null;
  readonly now: number;
}) {
  const m = useMessages();
  const remaining = remainingPercent(window);
  const resets = resetLabels(window, now, m)?.compact;
  return (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm text-foreground">{window.label}</Text>
        <Text className="text-xs font-ankiel-medium tabular-nums text-foreground">
          <T>
            <Var>{remaining}</Var>% left
          </T>
        </Text>
      </View>
      <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle">
        <View
          className={
            remaining <= 10
              ? "h-full rounded-full bg-red-500"
              : remaining <= 30
                ? "h-full rounded-full bg-amber-500"
                : "h-full rounded-full bg-foreground"
          }
          style={[{ flex: remaining }, remaining > 30 && color ? { backgroundColor: color } : null]}
        />
        <View style={{ flex: 100 - remaining }} />
      </View>
      {resets ? (
        <Text className="text-right text-xs tabular-nums text-foreground-tertiary">{resets}</Text>
      ) : null}
    </View>
  );
}

function CompactAccountCard({
  account,
  now,
  first,
}: {
  readonly account: ReturnType<typeof collectLimitAccounts>[number];
  readonly now: number;
  readonly first: boolean;
}) {
  const providerColor = useCompactBarColor(account.driver);
  const color = normalizeProviderAccentColor(account.accentColor) ?? providerColor;
  const name = account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver;
  return (
    <View className={first ? "gap-2.5 py-3" : "gap-2.5 border-t border-border-subtle py-3"}>
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={account.driver} size={16} />
        <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text className="shrink text-sm font-ankiel-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          {account.plan ? (
            <Text className="shrink-0 text-xs text-foreground-muted" numberOfLines={1}>
              {shortPlanLabel(account.plan)}
            </Text>
          ) : null}
          {account.displayName === null && account.email ? (
            <RedactedEmail value={account.email} />
          ) : null}
        </View>
      </View>
      <View className="gap-2.5">
        {account.limits.windows.map((window) => (
          <CompactWindowRow key={window.id} window={window} color={color} now={now} />
        ))}
      </View>
    </View>
  );
}

export function UsageLimitsSheet() {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const allPresentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const presentations = connectedLimitPresentations(allPresentations);
  const accounts = collectLimitAccounts(presentations);
  const notices = collectLimitNotices(presentations, m, false);
  const externalLinks = collectExternalUsageLinks(presentations, (provider) => provider);
  const { now, refreshing, refresh } = useRefreshLimits(null, true);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title={gt("Provider usage limits")}
        onClose={() => navigation.goBack()}
        actions={[
          {
            accessibilityLabel: gt("Refresh usage limits"),
            icon: "arrow.clockwise",
            loading: refreshing,
            onPress: () => {
              void refresh();
            },
          },
        ]}
      />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pb-6"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                void refresh();
              }}
            />
          }
        >
          {accounts.map((account, index) => (
            <CompactAccountCard key={account.key} account={account} now={now} first={index === 0} />
          ))}
          {externalLinks.map((link) => (
            <View
              key={link.url}
              className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border-subtle py-3"
            >
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
                {link.accounts.join(", ")}
              </Text>
              <Button
                label={link.label}
                tone="secondary"
                size="compact"
                onPress={() => {
                  void tryOpenExternalUrl(link.url);
                }}
              />
            </View>
          ))}
          {notices.map((notice) => (
            <Text
              key={notice}
              className="border-t border-border-subtle py-3 text-xs text-foreground-muted"
            >
              {notice}
            </Text>
          ))}
          {accounts.length === 0 && externalLinks.length === 0 && notices.length === 0 ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              <T>No provider limits reported.</T>
            </Text>
          ) : null}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
