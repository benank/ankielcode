import { Button } from "../../components/ui/Button";
import { QuestionAttachments } from "./QuestionAttachments";
import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@ankielcode/contracts";
import type { ThreadUserInputQuestion } from "@ankielcode/client-runtime/state/thread-requests";
import {
  markdownProseDirection,
  textDirection,
  type TextDirection,
} from "@ankielcode/shared/textDirection";
import { useNavigation } from "@react-navigation/native";
import { Plural, T, useGT, Var } from "gt-react-native";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { PixelStatus } from "../../components/PixelStatus";
import { cn } from "../../lib/cn";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import {
  fileRoutePathSegments,
  resolveFileLinkPath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";
import { useLiveThreadLinkLabels } from "../../state/entities";
import {
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "@ankielcode/client-runtime/state/pending-user-input";
import type { PendingUserInput } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  readonly maxHeight: DerivedValue<number>;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onStopThread?: () => void;
  readonly cardProgress: SharedValue<number>;
  readonly cardCoverage: SharedValue<number>;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
  readonly onDismiss: () => Promise<unknown>;
}

function proseDirectionStyle(text: string, setDirection: TextDirection | undefined) {
  const direction = textDirection(text);
  return {
    ...(direction ? { direction, writingDirection: direction } : null),
    textAlign: (direction === "rtl") === (setDirection === "rtl") ? "left" : "right",
  } as const;
}

function QuestionText(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
  readonly setDirection: TextDirection | undefined;
  readonly preserveSoftBreaks?: boolean;
}) {
  const styles = useMarkdownPreviewStyles();
  const markdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const openLink = (href: string) => {
    const link = resolveMarkdownLinkPresentation(href);
    if (link.kind !== "file") {
      void openPullRequest(href);
      return;
    }
    const path = resolveFileLinkPath(props.workspaceRoot, link.path);
    if (path === null) return;
    navigation.navigate("ThreadFile", {
      environmentId: String(props.environmentId),
      threadId: String(props.threadId),
      path: fileRoutePathSegments(
        resolveWorkspaceRelativeFilePath(props.workspaceRoot, path) ?? path,
      ),
      ...(link.line ? { line: String(link.line) } : {}),
    });
  };
  return (
    <SelectableMarkdownText
      markdown={markdown}
      textStyle={styles.nativeTextStyle}
      writingDirection={markdownProseDirection(markdown)}
      // Android's renderer aligns relative to each paragraph's direction.
      textAlign={
        Platform.OS === "android" ? undefined : props.setDirection === "rtl" ? "right" : "left"
      }
      onLinkPress={openLink}
      preserveSoftBreaks={props.preserveSoftBreaks}
    />
  );
}

function OptionIndicator(props: { readonly multiSelect: boolean; readonly selected: boolean }) {
  if (props.multiSelect) {
    return (
      <View
        className={cn(
          "size-5 items-center justify-center rounded-md border-[1.5px]",
          props.selected ? "border-foreground bg-foreground" : "border-foreground-muted",
        )}
      >
        {props.selected ? (
          <SymbolView name="checkmark" size={11} weight="bold" tintColorClassName="accent-screen" />
        ) : null}
      </View>
    );
  }
  return (
    <View
      className={cn(
        "size-5 items-center justify-center rounded-full border-[1.5px]",
        props.selected ? "border-foreground" : "border-foreground-muted",
      )}
    >
      {props.selected ? <View className="size-2.5 rounded-full bg-foreground" /> : null}
    </View>
  );
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const gt = useGT();
  const questionCount = props.pendingUserInput.questions.length;
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseDisabled = !canRespond || isResponding;
  // One question per page; the page resets when a new request takes the card.
  const requestId = props.pendingUserInput.requestId;
  const [page, setPage] = useState({ requestId, index: 0 });
  const questionIndex =
    page.requestId === requestId ? Math.min(page.index, Math.max(0, questionCount - 1)) : 0;
  const question = props.pendingUserInput.questions[questionIndex];
  const isLastQuestion = questionIndex >= questionCount - 1;
  const questionAnswered =
    question !== undefined &&
    resolvePendingUserInputAnswer(question, props.drafts[question.id]) !== null;
  const goToQuestion = (index: number) => setPage({ requestId, index });
  const setDirection = markdownProseDirection(
    props.pendingUserInput.questions
      .flatMap((question) => [
        question.header,
        question.question,
        ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
      ])
      .join(" "),
  );

  const { cardCoverage, cardProgress, maxHeight } = props;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  const cardHeight = useSharedValue(0);
  const notifyCoverage = () => {
    // The card resizes with the keyboard every frame, so easing each sample would leave the
    // feed inset and floating controls trailing it.
    cardCoverage.set(Math.max(0, cardHeightRef.current - barHeightRef.current));
  };
  const handleBarLayout = (event: LayoutChangeEvent) => {
    barHeightRef.current = event.nativeEvent.layout.height;
    notifyCoverage();
  };
  const handleCardLayout = (event: LayoutChangeEvent) => {
    cardHeightRef.current = event.nativeEvent.layout.height;
    cardHeight.set(event.nativeEvent.layout.height);
    notifyCoverage();
  };
  const cardAnimatedStyle = useAnimatedStyle(() => {
    const progress = cardProgress.value;
    const travel = Platform.OS === "android" ? cardCoverage.value : cardHeight.value;
    return {
      maxHeight: maxHeight.value,
      opacity:
        Platform.OS === "android"
          ? Math.min(1, (progress * cardHeight.value) / Math.max(1, cardHeight.value - travel))
          : 1,
      transform: [{ translateY: (1 - progress) * travel }],
    };
  });
  // Android hit-tests inside the parent; its height is also the space the card takes below the feed.
  const androidBoundsStyle = useAnimatedStyle(() => ({
    paddingTop: cardCoverage.value * cardProgress.value,
  }));
  const overlayHeightStyle = useAnimatedStyle(() => ({ height: maxHeight.value }));

  const stopButton = props.onStopThread ? (
    <ControlPill
      accessibilityLabel={gt("Stop", { $context: "verb, stops the thread" })}
      icon="stop.fill"
      className="h-9 w-9"
      disabled={!props.canOperateThread}
      onPress={props.onStopThread}
    />
  ) : null;
  const bar = (
    <View
      onLayout={handleBarLayout}
      pointerEvents={props.collapsed ? "auto" : "none"}
      accessibilityElementsHidden={!props.collapsed}
      importantForAccessibility={props.collapsed ? "auto" : "no-hide-descendants"}
      className="flex-row items-center gap-2 rounded-full border border-border bg-card-alt py-1.5 pl-4 pr-1.5"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt(
          "{count, plural, one {Expand user input, {count} question} other {Expand user input, {count} questions}}",
          { count: questionCount },
        )}
        onPress={props.onToggleCollapsed}
        className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <PixelStatus kind="attention" />
        <Text className="font-ankiel-medium text-sm text-foreground">
          <T>User input needed</T>
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
          <T>
            <Plural
              n={questionCount}
              one={
                <>
                  <Var>{questionCount}</Var> question
                </>
              }
              other={
                <>
                  <Var>{questionCount}</Var> questions
                </>
              }
            />
          </T>
        </Text>
        <View className="flex-1" />
        <SymbolView
          name="chevron.up"
          size={12}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
      {stopButton}
    </View>
  );
  const card = (
    <Animated.View
      onLayout={handleCardLayout}
      pointerEvents={props.collapsed ? "none" : "auto"}
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      className="overflow-hidden gap-2.5 rounded-card border border-border bg-card-alt p-4"
      style={cardAnimatedStyle}
    >
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Collapse user input")}
          onPress={props.onToggleCollapsed}
          className="min-h-9 flex-1 flex-row items-center gap-2 active:opacity-70"
        >
          <PixelStatus kind="attention" />
          <Text
            numberOfLines={1}
            className="min-w-0 shrink font-ankiel-medium text-sm text-foreground"
            style={
              question?.header ? proseDirectionStyle(question.header, setDirection) : undefined
            }
          >
            {question?.header ? question.header : <T>User input needed</T>}
          </Text>
          <View className="flex-1" />
          {questionCount > 1 ? (
            <Text className="font-sans text-xs tabular-nums text-foreground-muted">
              {gt("{position} of {total}", { position: questionIndex + 1, total: questionCount })}
            </Text>
          ) : null}
          <SymbolView
            name="chevron.down"
            size={12}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </Pressable>
        {stopButton}
      </View>
      <ScrollView
        key={question?.id}
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-3 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            <T>
              The provider process for this request is no longer available. Interrupt or restart the
              run to continue.
            </T>
          </Text>
        ) : null}
        {question ? (
          <>
            <QuestionText
              markdown={question.question}
              environmentId={props.environmentId}
              threadId={props.threadId}
              workspaceRoot={props.workspaceRoot}
              setDirection={setDirection}
              preserveSoftBreaks
            />
            {question.options.length > 0 ? (
              <View className="overflow-hidden rounded-2xl border border-border bg-card">
                {question.options.map((option, optionIndex) => {
                  const optionValue = option.value ?? option.label.trim();
                  const selected = isPendingUserInputOptionSelected(
                    question,
                    props.drafts[question.id],
                    optionValue,
                  );
                  const description =
                    option.description !== option.label ? option.description : undefined;
                  return (
                    <Pressable
                      key={optionValue}
                      accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                      accessibilityState={{ checked: selected, disabled: responseDisabled }}
                      disabled={responseDisabled}
                      className={cn(
                        "min-h-12 flex-row items-start gap-3 px-3.5 py-3 active:bg-subtle",
                        optionIndex > 0 && "border-t border-border",
                      )}
                      onPress={() => props.onSelectOption(requestId, question, optionValue)}
                    >
                      <View className="h-5 justify-center">
                        <OptionIndicator multiSelect={question.multiSelect} selected={selected} />
                      </View>
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text
                          className="font-ankiel-medium text-sm text-foreground"
                          style={proseDirectionStyle(option.label, setDirection)}
                        >
                          {option.label}
                        </Text>
                        {description ? (
                          <Text
                            className="font-sans text-sm leading-5 text-foreground-muted"
                            style={proseDirectionStyle(description, setDirection)}
                          >
                            {description}
                          </Text>
                        ) : null}
                        {option.preview ? (
                          <QuestionText
                            markdown={option.preview}
                            environmentId={props.environmentId}
                            threadId={props.threadId}
                            workspaceRoot={props.workspaceRoot}
                            setDirection={setDirection}
                            preserveSoftBreaks
                          />
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {question.allowCustomAnswer !== false ? (
              <QuestionAttachments
                key={`${requestId}:${question.id}`}
                requestId={requestId}
                question={question}
                questions={props.pendingUserInput.questions}
                disabled={responseDisabled}
                value={props.drafts[question.id]?.customAnswer ?? ""}
                onChangeText={(value) => props.onChangeCustomAnswer(requestId, question.id, value)}
                onInputFocusChange={props.onInputFocusChange}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <View className="flex-row items-center gap-2">
        {questionIndex > 0 ? (
          <Button
            label={gt("Previous", { $context: "button that goes to the previous question" })}
            tone="text"
            size="compact"
            disabled={isResponding}
            onPress={() => goToQuestion(questionIndex - 1)}
          />
        ) : props.pendingUserInput.dismissible ? (
          <Button
            label={gt("Dismiss")}
            accessibilityLabel={gt("Dismiss without answering")}
            tone="text"
            size="compact"
            disabled={isResponding}
            onPress={() => void props.onDismiss()}
          />
        ) : null}
        <View className="flex-1" />
        {isLastQuestion ? (
          <Button
            label={gt("Submit", { $context: "verb, submits answers" })}
            accessibilityLabel={gt("Submit answers")}
            tone="primary"
            size="compact"
            loading={isResponding}
            disabled={!props.canOperateThread || responseDisabled || props.answers === null}
            onPress={() => void props.onSubmit()}
          />
        ) : (
          <Button
            label={gt("Next", { $context: "button that goes to the next question" })}
            tone="primary"
            size="compact"
            disabled={responseDisabled || !questionAnswered}
            onPress={() => goToQuestion(questionIndex + 1)}
          />
        )}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          <T>This connection cannot submit answers.</T>
        </Text>
      ) : null}
    </Animated.View>
  );
  return (
    <Animated.View
      className="relative"
      style={Platform.OS === "android" ? androidBoundsStyle : undefined}
      onLayout={props.onLayout}
    >
      {bar}
      <Animated.View
        pointerEvents={props.collapsed ? "none" : "box-none"}
        className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
        style={overlayHeightStyle}
      >
        {card}
      </Animated.View>
    </Animated.View>
  );
}
