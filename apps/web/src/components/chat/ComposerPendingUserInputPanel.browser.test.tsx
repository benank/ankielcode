import { EnvironmentId, RuntimeRequestId, ThreadId } from "@ankielcode/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { PendingUserInputDraftAnswer } from "@ankielcode/client-runtime/state/pending-user-input";
import type { PendingUserInput } from "../../session-logic";
import { Select, SelectTrigger } from "../ui/select";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-shortcuts"),
  createdAt: "2026-10-31T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [
    {
      id: "question",
      header: "Rollout",
      question: "How should this ship?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: true,
    },
  ],
};

it.each<{ focus: string; control: ReactNode; toggles: boolean }>([
  { focus: "a page button", control: <button type="button" aria-label="Focused" />, toggles: true },
  {
    focus: "a dialog",
    control: (
      <div role="dialog">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a popup",
    control: (
      <div data-slot="menu-popup">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a menu",
    control: (
      <div role="menu">
        <button type="button" role="menuitem" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a select",
    control: (
      <select aria-label="Focused">
        <option>One</option>
      </select>
    ),
    toggles: false,
  },
  {
    focus: "a closed select menu",
    control: (
      <Select>
        <SelectTrigger aria-label="Focused" />
      </Select>
    ),
    toggles: false,
  },
  {
    focus: "a device screen that takes the key",
    control: (
      <div
        role="application"
        aria-label="Focused"
        tabIndex={0}
        onKeyDown={(event) => event.preventDefault()}
      />
    ),
    toggles: false,
  },
])(
  "digit shortcut with focus in $focus toggles an option: $toggles",
  async ({ control, toggles }) => {
    const onToggleOption = vi.fn();
    await using screen = await render(
      <>
        {control}
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt]}
          cwd={undefined}
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={onToggleOption}
          onAdvance={vi.fn()}
          onDismiss={vi.fn()}
        />
      </>,
    );
    await expect.element(screen.getByText("Incremental")).toBeVisible();
    screen.getByLabelText("Focused").element().focus();

    await userEvent.keyboard("1");

    expect(onToggleOption.mock.calls).toEqual(toggles ? [["question", "Incremental"]] : []);
  },
);

it("selects an option on click without answering", async () => {
  const onToggleOption = vi.fn();
  const onAdvance = vi.fn();
  await using screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        { ...prompt, questions: [{ ...prompt.questions[0]!, multiSelect: false }] },
      ]}
      cwd={undefined}
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={vi.fn()}
    />,
  );

  await screen.getByRole("button", { name: /Incremental/ }).click();
  expect(onToggleOption.mock.calls).toEqual([["question", "Incremental"]]);
  expect(onAdvance).not.toHaveBeenCalled();
});

it("chooses a focused option with Enter, and submits on Enter once it is chosen", async () => {
  const onToggleOption = vi.fn();
  const onAdvance = vi.fn();
  const singleSelect = { ...prompt, questions: [{ ...prompt.questions[0]!, multiSelect: false }] };
  const panel = (answers: Record<string, PendingUserInputDraftAnswer>) => (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[singleSelect]}
      cwd={undefined}
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={answers}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={vi.fn()}
    />
  );
  await using screen = await render(panel({}));
  const option = screen.getByRole("button", { name: /Incremental/ });
  option.element().focus();

  await userEvent.keyboard("{Enter}");
  expect(onToggleOption.mock.calls).toEqual([["question", "Incremental"]]);
  expect(onAdvance).not.toHaveBeenCalled();

  await screen.rerender(panel({ question: { selectedOptionValues: ["Incremental"] } }));
  option.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onAdvance).toHaveBeenCalledOnce();
});
