import { useGT } from "gt-react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

export function ConnectionTraceId({
  traceId,
  activation = "press",
}: {
  readonly traceId: string;
  readonly activation?: "press" | "longPress";
}) {
  const gt = useGT();
  const copy = () => copyTextWithHaptic(traceId, { target: "connection-trace-id" });
  return (
    <>
      {" "}
      {gt("Trace ID:")}{" "}
      <Text
        accessibilityHint={
          activation === "longPress"
            ? gt("Long press to copy the trace ID")
            : gt("Copies the trace ID")
        }
        accessibilityLabel={gt("Copy trace ID {traceId}", { traceId })}
        accessibilityRole="button"
        accessibilityActions={[{ name: "activate", label: gt("Copy trace ID") }]}
        onAccessibilityAction={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.actionName === "activate") copy();
        }}
        className="text-foreground-muted underline decoration-dotted"
        onLongPress={
          activation === "longPress"
            ? (event) => {
                event.stopPropagation();
                copy();
              }
            : undefined
        }
        onPress={(event) => {
          event.stopPropagation();
          if (activation === "press") copy();
        }}
      >
        {traceId}
      </Text>
    </>
  );
}
