import { msg } from "gt-i18n";

/**
 * Whole sentences for each Ankiel MCP tool row, keyed by the tool's labels from
 * `@ankielcode/shared/ankielMcpToolPresentation`. Resolve with `{ status }`.
 */
export interface AnkielToolSentence {
  readonly detail: string;
}

export function ankielToolSentence(labels: ReadonlyArray<string>): AnkielToolSentence | undefined {
  return ANKIEL_TOOL_SENTENCES.get(labels.join("\n"));
}

const ANKIEL_TOOL_SENTENCES: ReadonlyMap<string, AnkielToolSentence> = new Map<
  string,
  AnkielToolSentence
>([
  [
    "Get\nGetting\nGot\norchestration capabilities",
    {
      detail: msg(
        "{status, select, inProgress {Getting orchestration capabilities} completed {Got orchestration capabilities} failed {Failed to get orchestration capabilities} declined {Declined to get orchestration capabilities} stopped {Stopped getting orchestration capabilities} other {Getting orchestration capabilities}}",
      ),
    },
  ],
  [
    "Delegate\nDelegating\nDelegated\na child task",
    {
      detail: msg(
        "{status, select, inProgress {Delegating a child task} completed {Delegated a child task} failed {Failed to delegate a child task} declined {Declined to delegate a child task} stopped {Stopped delegating a child task} other {Delegating a child task}}",
      ),
    },
  ],
  [
    "Get\nGetting\nGot\ndelegated task status",
    {
      detail: msg(
        "{status, select, inProgress {Getting delegated task status} completed {Got delegated task status} failed {Failed to get delegated task status} declined {Declined to get delegated task status} stopped {Stopped getting delegated task status} other {Getting delegated task status}}",
      ),
    },
  ],
  [
    "Cancel\nCanceling\nRequested cancellation of\na delegated task",
    {
      detail: msg(
        "{status, select, inProgress {Canceling a delegated task} completed {Requested cancellation of a delegated task} failed {Failed to cancel a delegated task} declined {Declined to cancel a delegated task} stopped {Stopped canceling a delegated task} other {Canceling a delegated task}}",
      ),
    },
  ],
  [
    "Schedule\nScheduling\nScheduled\na task",
    {
      detail: msg(
        "{status, select, inProgress {Scheduling a task} completed {Scheduled a task} failed {Failed to schedule a task} declined {Declined to schedule a task} stopped {Stopped scheduling a task} other {Scheduling a task}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\nscheduled tasks",
    {
      detail: msg(
        "{status, select, inProgress {Listing scheduled tasks} completed {Listed scheduled tasks} failed {Failed to list scheduled tasks} declined {Declined to list scheduled tasks} stopped {Stopped listing scheduled tasks} other {Listing scheduled tasks}}",
      ),
    },
  ],
  [
    "Update\nUpdating\nUpdated\na scheduled task",
    {
      detail: msg(
        "{status, select, inProgress {Updating a scheduled task} completed {Updated a scheduled task} failed {Failed to update a scheduled task} declined {Declined to update a scheduled task} stopped {Stopped updating a scheduled task} other {Updating a scheduled task}}",
      ),
    },
  ],
  [
    "Delete\nDeleting\nRequested deletion of\na scheduled task",
    {
      detail: msg(
        "{status, select, inProgress {Deleting a scheduled task} completed {Requested deletion of a scheduled task} failed {Failed to delete a scheduled task} declined {Declined to delete a scheduled task} stopped {Stopped deleting a scheduled task} other {Deleting a scheduled task}}",
      ),
    },
  ],
  [
    "Ask for\nAsking for\nAsked for\na secret",
    {
      detail: msg(
        "{status, select, inProgress {Asking for a secret} completed {Asked for a secret} failed {Failed to ask for a secret} declined {Declined to ask for a secret} stopped {Stopped asking for a secret} other {Asking for a secret}}",
      ),
    },
  ],
  [
    "Create\nCreating\nCreated\nAnkiel threads",
    {
      detail: msg(
        "{status, select, inProgress {Creating Ankiel threads} completed {Created Ankiel threads} failed {Failed to create Ankiel threads} declined {Declined to create Ankiel threads} stopped {Stopped creating Ankiel threads} other {Creating Ankiel threads}}",
      ),
    },
  ],
  [
    "Start\nStarting\nStarted\na Ankiel thread",
    {
      detail: msg(
        "{status, select, inProgress {Starting an Ankiel thread} completed {Started an Ankiel thread} failed {Failed to start an Ankiel thread} declined {Declined to start an Ankiel thread} stopped {Stopped starting an Ankiel thread} other {Starting an Ankiel thread}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\nAnkiel threads",
    {
      detail: msg(
        "{status, select, inProgress {Listing Ankiel threads} completed {Listed Ankiel threads} failed {Failed to list Ankiel threads} declined {Declined to list Ankiel threads} stopped {Stopped listing Ankiel threads} other {Listing Ankiel threads}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\na Ankiel thread",
    {
      detail: msg(
        "{status, select, inProgress {Reading an Ankiel thread} completed {Read an Ankiel thread} failed {Failed to read an Ankiel thread} declined {Declined to read an Ankiel thread} stopped {Stopped reading an Ankiel thread} other {Reading an Ankiel thread}}",
      ),
    },
  ],
  [
    "Send\nSending\nSent\nto an Ankiel thread",
    {
      detail: msg(
        "{status, select, inProgress {Sending to an Ankiel thread} completed {Sent to an Ankiel thread} failed {Failed to send to an Ankiel thread} declined {Declined to send to an Ankiel thread} stopped {Stopped sending to an Ankiel thread} other {Sending to an Ankiel thread}}",
      ),
    },
  ],
  [
    "Wait\nWaiting\nWaited\nfor an Ankiel thread",
    {
      detail: msg(
        "{status, select, inProgress {Waiting for an Ankiel thread} completed {Waited for an Ankiel thread} failed {Failed to wait for an Ankiel thread} declined {Declined to wait for an Ankiel thread} stopped {Stopped waiting for an Ankiel thread} other {Waiting for an Ankiel thread}}",
      ),
    },
  ],
  [
    "Stop\nStopping\nRequested a stop for\na workflow",
    {
      detail: msg(
        "{status, select, inProgress {Stopping a workflow} completed {Requested a stop for a workflow} failed {Failed to stop a workflow} declined {Declined to stop a workflow} stopped {Stopped stopping a workflow} other {Stopping a workflow}}",
      ),
    },
  ],
  [
    "Update\nUpdating\nUpdated\nbackground waits",
    {
      detail: msg(
        "{status, select, inProgress {Updating background waits} completed {Updated background waits} failed {Failed to update background waits} declined {Declined to update background waits} stopped {Stopped updating background waits} other {Updating background waits}}",
      ),
    },
  ],
  [
    "Interrupt\nInterrupting\nRequested an interrupt of\na Ankiel thread",
    {
      detail: msg(
        "{status, select, inProgress {Interrupting an Ankiel thread} completed {Requested an interrupt of an Ankiel thread} failed {Failed to interrupt an Ankiel thread} declined {Declined to interrupt an Ankiel thread} stopped {Stopped interrupting an Ankiel thread} other {Interrupting an Ankiel thread}}",
      ),
    },
  ],
  [
    "Hand off\nHanding off\nHanded off\nthread to a git worktree",
    {
      detail: msg(
        "{status, select, inProgress {Handing off thread to a git worktree} completed {Handed off thread to a git worktree} failed {Failed to hand off thread to a git worktree} declined {Declined to hand off thread to a git worktree} stopped {Stopped handing off thread to a git worktree} other {Handing off thread to a git worktree}}",
      ),
    },
  ],
  [
    "Get\nGetting\nGot\nthread worktree status",
    {
      detail: msg(
        "{status, select, inProgress {Getting thread worktree status} completed {Got thread worktree status} failed {Failed to get thread worktree status} declined {Declined to get thread worktree status} stopped {Stopped getting thread worktree status} other {Getting thread worktree status}}",
      ),
    },
  ],
  [
    "Get\nGetting\nGot\npreview browser status",
    {
      detail: msg(
        "{status, select, inProgress {Getting preview browser status} completed {Got preview browser status} failed {Failed to get preview browser status} declined {Declined to get preview browser status} stopped {Stopped getting preview browser status} other {Getting preview browser status}}",
      ),
    },
  ],
  [
    "Open\nOpening\nOpened\na page in the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Opening a page in the preview browser} completed {Opened a page in the preview browser} failed {Failed to open a page in the preview browser} declined {Declined to open a page in the preview browser} stopped {Stopped opening a page in the preview browser} other {Opening a page in the preview browser}}",
      ),
    },
  ],
  [
    "Navigate\nNavigating\nNavigated\nthe preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Navigating the preview browser} completed {Navigated the preview browser} failed {Failed to navigate the preview browser} declined {Declined to navigate the preview browser} stopped {Stopped navigating the preview browser} other {Navigating the preview browser}}",
      ),
    },
  ],
  [
    "Respond\nResponding\nResponded\nto a preview browser dialog",
    {
      detail: msg(
        "{status, select, inProgress {Responding to a preview browser dialog} completed {Responded to a preview browser dialog} failed {Failed to respond to a preview browser dialog} declined {Declined to respond to a preview browser dialog} stopped {Stopped responding to a preview browser dialog} other {Responding to a preview browser dialog}}",
      ),
    },
  ],
  [
    "Take a snapshot of\nTaking a snapshot of\nTook a snapshot of\nthe preview page",
    {
      detail: msg(
        "{status, select, inProgress {Taking a snapshot of the preview page} completed {Took a snapshot of the preview page} failed {Failed to take a snapshot of the preview page} declined {Declined to take a snapshot of the preview page} stopped {Stopped taking a snapshot of the preview page} other {Taking a snapshot of the preview page}}",
      ),
    },
  ],
  [
    "Use\nUsing\nUsed\nthe preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Using the preview browser} completed {Used the preview browser} failed {Failed to use the preview browser} declined {Declined to use the preview browser} stopped {Stopped using the preview browser} other {Using the preview browser}}",
      ),
    },
  ],
  [
    "Click\nClicking\nClicked\nin the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Clicking in the preview browser} completed {Clicked in the preview browser} failed {Failed to click in the preview browser} declined {Declined to click in the preview browser} stopped {Stopped clicking in the preview browser} other {Clicking in the preview browser}}",
      ),
    },
  ],
  [
    "Press\nPressing\nPressed\na key in the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Pressing a key in the preview browser} completed {Pressed a key in the preview browser} failed {Failed to press a key in the preview browser} declined {Declined to press a key in the preview browser} stopped {Stopped pressing a key in the preview browser} other {Pressing a key in the preview browser}}",
      ),
    },
  ],
  [
    "Type\nTyping\nTyped\nin the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Typing in the preview browser} completed {Typed in the preview browser} failed {Failed to type in the preview browser} declined {Declined to type in the preview browser} stopped {Stopped typing in the preview browser} other {Typing in the preview browser}}",
      ),
    },
  ],
  [
    "Hover\nHovering\nHovered\nin the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Hovering in the preview browser} completed {Hovered in the preview browser} failed {Failed to hover in the preview browser} declined {Declined to hover in the preview browser} stopped {Stopped hovering in the preview browser} other {Hovering in the preview browser}}",
      ),
    },
  ],
  [
    "Choose\nChoosing\nChose\nan option in the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Choosing an option in the preview browser} completed {Chose an option in the preview browser} failed {Failed to choose an option in the preview browser} declined {Declined to choose an option in the preview browser} stopped {Stopped choosing an option in the preview browser} other {Choosing an option in the preview browser}}",
      ),
    },
  ],
  [
    "Drag\nDragging\nDragged\nin the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Dragging in the preview browser} completed {Dragged in the preview browser} failed {Failed to drag in the preview browser} declined {Declined to drag in the preview browser} stopped {Stopped dragging in the preview browser} other {Dragging in the preview browser}}",
      ),
    },
  ],
  [
    "Upload\nUploading\nUploaded\nfiles to the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Uploading files to the preview browser} completed {Uploaded files to the preview browser} failed {Failed to upload files to the preview browser} declined {Declined to upload files to the preview browser} stopped {Stopped uploading files to the preview browser} other {Uploading files to the preview browser}}",
      ),
    },
  ],
  [
    "Scroll\nScrolling\nScrolled\nthe preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Scrolling the preview browser} completed {Scrolled the preview browser} failed {Failed to scroll the preview browser} declined {Declined to scroll the preview browser} stopped {Stopped scrolling the preview browser} other {Scrolling the preview browser}}",
      ),
    },
  ],
  [
    "Resize\nResizing\nResized\nthe preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Resizing the preview browser} completed {Resized the preview browser} failed {Failed to resize the preview browser} declined {Declined to resize the preview browser} stopped {Stopped resizing the preview browser} other {Resizing the preview browser}}",
      ),
    },
  ],
  [
    "Evaluate\nEvaluating\nEvaluated\nscript in the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Evaluating script in the preview browser} completed {Evaluated script in the preview browser} failed {Failed to evaluate script in the preview browser} declined {Declined to evaluate script in the preview browser} stopped {Stopped evaluating script in the preview browser} other {Evaluating script in the preview browser}}",
      ),
    },
  ],
  [
    "Wait\nWaiting\nWaited\nfor the preview page",
    {
      detail: msg(
        "{status, select, inProgress {Waiting for the preview page} completed {Waited for the preview page} failed {Failed to wait for the preview page} declined {Declined to wait for the preview page} stopped {Stopped waiting for the preview page} other {Waiting for the preview page}}",
      ),
    },
  ],
  [
    "Set\nSetting\nSet\npreview browser appearance",
    {
      detail: msg(
        "{status, select, inProgress {Setting preview browser appearance} completed {Set preview browser appearance} failed {Failed to set preview browser appearance} declined {Declined to set preview browser appearance} stopped {Stopped setting preview browser appearance} other {Setting preview browser appearance}}",
      ),
    },
  ],
  [
    "Start\nStarting\nStarted\nrecording the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Starting recording the preview browser} completed {Started recording the preview browser} failed {Failed to start recording the preview browser} declined {Declined to start recording the preview browser} stopped {Stopped starting recording the preview browser} other {Starting recording the preview browser}}",
      ),
    },
  ],
  [
    "Stop\nStopping\nStopped\nrecording the preview browser",
    {
      detail: msg(
        "{status, select, inProgress {Stopping recording the preview browser} completed {Stopped recording the preview browser} failed {Failed to stop recording the preview browser} declined {Declined to stop recording the preview browser} stopped {Stopped stopping recording the preview browser} other {Stopping recording the preview browser}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\nsimulators and emulators",
    {
      detail: msg(
        "{status, select, inProgress {Listing simulators and emulators} completed {Listed simulators and emulators} failed {Failed to list simulators and emulators} declined {Declined to list simulators and emulators} stopped {Stopped listing simulators and emulators} other {Listing simulators and emulators}}",
      ),
    },
  ],
  [
    "Open\nOpening\nOpened\na device in the Device panel",
    {
      detail: msg(
        "{status, select, inProgress {Opening a device in the Device panel} completed {Opened a device in the Device panel} failed {Failed to open a device in the Device panel} declined {Declined to open a device in the Device panel} stopped {Stopped opening a device in the Device panel} other {Opening a device in the Device panel}}",
      ),
    },
  ],
  [
    "Take a screenshot of\nTaking a screenshot of\nTook a screenshot of\nthe device",
    {
      detail: msg(
        "{status, select, inProgress {Taking a screenshot of the device} completed {Took a screenshot of the device} failed {Failed to take a screenshot of the device} declined {Declined to take a screenshot of the device} stopped {Stopped taking a screenshot of the device} other {Taking a screenshot of the device}}",
      ),
    },
  ],
  [
    "Close\nClosing\nClosed\na device",
    {
      detail: msg(
        "{status, select, inProgress {Closing a device} completed {Closed a device} failed {Failed to close a device} declined {Declined to close a device} stopped {Stopped closing a device} other {Closing a device}}",
      ),
    },
  ],
  [
    "Run\nRunning\nRequested a run of\na scheduled task",
    {
      detail: msg(
        "{status, select, inProgress {Running a scheduled task} completed {Requested a run of a scheduled task} failed {Failed to run a scheduled task} declined {Declined to run a scheduled task} stopped {Stopped running a scheduled task} other {Running a scheduled task}}",
      ),
    },
  ],
  [
    "Manage\nManaging\nManaged\nqueued messages",
    {
      detail: msg(
        "{status, select, inProgress {Managing queued messages} completed {Managed queued messages} failed {Failed to manage queued messages} declined {Declined to manage queued messages} stopped {Stopped managing queued messages} other {Managing queued messages}}",
      ),
    },
  ],
  [
    "Handle\nHandling\nHandled\npending questions",
    {
      detail: msg(
        "{status, select, inProgress {Handling pending questions} completed {Handled pending questions} failed {Failed to handle pending questions} declined {Declined to handle pending questions} stopped {Stopped handling pending questions} other {Handling pending questions}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\nqueued messages",
    {
      detail: msg(
        "{status, select, inProgress {Listing queued messages} completed {Listed queued messages} failed {Failed to list queued messages} declined {Declined to list queued messages} stopped {Stopped listing queued messages} other {Listing queued messages}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\na queued message",
    {
      detail: msg(
        "{status, select, inProgress {Reading a queued message} completed {Read a queued message} failed {Failed to read a queued message} declined {Declined to read a queued message} stopped {Stopped reading a queued message} other {Reading a queued message}}",
      ),
    },
  ],
  [
    "Edit\nEditing\nEdited\na queued message",
    {
      detail: msg(
        "{status, select, inProgress {Editing a queued message} completed {Edited a queued message} failed {Failed to edit a queued message} declined {Declined to edit a queued message} stopped {Stopped editing a queued message} other {Editing a queued message}}",
      ),
    },
  ],
  [
    "Cancel\nCanceling\nRequested cancellation of\na queued run",
    {
      detail: msg(
        "{status, select, inProgress {Canceling a queued run} completed {Requested cancellation of a queued run} failed {Failed to cancel a queued run} declined {Declined to cancel a queued run} stopped {Stopped canceling a queued run} other {Canceling a queued run}}",
      ),
    },
  ],
  [
    "Reorder\nReordering\nReordered\na queued run",
    {
      detail: msg(
        "{status, select, inProgress {Reordering a queued run} completed {Reordered a queued run} failed {Failed to reorder a queued run} declined {Declined to reorder a queued run} stopped {Stopped reordering a queued run} other {Reordering a queued run}}",
      ),
    },
  ],
  [
    "Steer with\nSteering with\nRequested steering with\na queued message",
    {
      detail: msg(
        "{status, select, inProgress {Steering with a queued message} completed {Requested steering with a queued message} failed {Failed to steer with a queued message} declined {Declined to steer with a queued message} stopped {Stopped steering with a queued message} other {Steering with a queued message}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\npending questions",
    {
      detail: msg(
        "{status, select, inProgress {Listing pending questions} completed {Listed pending questions} failed {Failed to list pending questions} declined {Declined to list pending questions} stopped {Stopped listing pending questions} other {Listing pending questions}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\npending questions",
    {
      detail: msg(
        "{status, select, inProgress {Reading pending questions} completed {Read pending questions} failed {Failed to read pending questions} declined {Declined to read pending questions} stopped {Stopped reading pending questions} other {Reading pending questions}}",
      ),
    },
  ],
  [
    "Answer\nAnswering\nAnswered\npending questions",
    {
      detail: msg(
        "{status, select, inProgress {Answering pending questions} completed {Answered pending questions} failed {Failed to answer pending questions} declined {Declined to answer pending questions} stopped {Stopped answering pending questions} other {Answering pending questions}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\nthread configuration",
    {
      detail: msg(
        "{status, select, inProgress {Reading thread configuration} completed {Read thread configuration} failed {Failed to read thread configuration} declined {Declined to read thread configuration} stopped {Stopped reading thread configuration} other {Reading thread configuration}}",
      ),
    },
  ],
  [
    "Use\nUsing\nUsed\nthread model settings",
    {
      detail: msg(
        "{status, select, inProgress {Using thread model settings} completed {Used thread model settings} failed {Failed to use thread model settings} declined {Declined to use thread model settings} stopped {Stopped using thread model settings} other {Using thread model settings}}",
      ),
    },
  ],
  [
    "Use\nUsing\nUsed\nthread transfers",
    {
      detail: msg(
        "{status, select, inProgress {Using thread transfers} completed {Used thread transfers} failed {Failed to use thread transfers} declined {Declined to use thread transfers} stopped {Stopped using thread transfers} other {Using thread transfers}}",
      ),
    },
  ],
  [
    "Fork\nForking\nRequested a fork of\nthis thread",
    {
      detail: msg(
        "{status, select, inProgress {Forking this thread} completed {Requested a fork of this thread} failed {Failed to fork this thread} declined {Declined to fork this thread} stopped {Stopped forking this thread} other {Forking this thread}}",
      ),
    },
  ],
  [
    "Merge\nMerging\nRequested a merge of\nthread context",
    {
      detail: msg(
        "{status, select, inProgress {Merging thread context} completed {Requested a merge of thread context} failed {Failed to merge thread context} declined {Declined to merge thread context} stopped {Stopped merging thread context} other {Merging thread context}}",
      ),
    },
  ],
  [
    "Search\nSearching\nSearched\nthread content",
    {
      detail: msg(
        "{status, select, inProgress {Searching thread content} completed {Searched thread content} failed {Failed to search thread content} declined {Declined to search thread content} stopped {Stopped searching thread content} other {Searching thread content}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\nthread transfers",
    {
      detail: msg(
        "{status, select, inProgress {Reading thread transfers} completed {Read thread transfers} failed {Failed to read thread transfers} declined {Declined to read thread transfers} stopped {Stopped reading thread transfers} other {Reading thread transfers}}",
      ),
    },
  ],
  [
    "Organize\nOrganizing\nOrganized\na thread",
    {
      detail: msg(
        "{status, select, inProgress {Organizing a thread} completed {Organized a thread} failed {Failed to organize a thread} declined {Declined to organize a thread} stopped {Stopped organizing a thread} other {Organizing a thread}}",
      ),
    },
  ],
  [
    "Update\nUpdating\nUpdated\nAnkiel thread metadata",
    {
      detail: msg(
        "{status, select, inProgress {Updating Ankiel thread metadata} completed {Updated Ankiel thread metadata} failed {Failed to update Ankiel thread metadata} declined {Declined to update Ankiel thread metadata} stopped {Stopped updating Ankiel thread metadata} other {Updating Ankiel thread metadata}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\nworkspace branches",
    {
      detail: msg(
        "{status, select, inProgress {Listing workspace branches} completed {Listed workspace branches} failed {Failed to list workspace branches} declined {Declined to list workspace branches} stopped {Stopped listing workspace branches} other {Listing workspace branches}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\npreview tabs",
    {
      detail: msg(
        "{status, select, inProgress {Listing preview tabs} completed {Listed preview tabs} failed {Failed to list preview tabs} declined {Declined to list preview tabs} stopped {Stopped listing preview tabs} other {Listing preview tabs}}",
      ),
    },
  ],
  [
    "Close\nClosing\nClosed\na preview tab",
    {
      detail: msg(
        "{status, select, inProgress {Closing a preview tab} completed {Closed a preview tab} failed {Failed to close a preview tab} declined {Declined to close a preview tab} stopped {Stopped closing a preview tab} other {Closing a preview tab}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\nenvironment preferences",
    {
      detail: msg(
        "{status, select, inProgress {Reading environment preferences} completed {Read environment preferences} failed {Failed to read environment preferences} declined {Declined to read environment preferences} stopped {Stopped reading environment preferences} other {Reading environment preferences}}",
      ),
    },
  ],
  [
    "Update\nUpdating\nUpdated\nenvironment preferences",
    {
      detail: msg(
        "{status, select, inProgress {Updating environment preferences} completed {Updated environment preferences} failed {Failed to update environment preferences} declined {Declined to update environment preferences} stopped {Stopped updating environment preferences} other {Updating environment preferences}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\nthemes",
    {
      detail: msg(
        "{status, select, inProgress {Reading themes} completed {Read themes} failed {Failed to read themes} declined {Declined to read themes} stopped {Stopped reading themes} other {Reading themes}}",
      ),
    },
  ],
  [
    "Set\nSetting\nSet\nthe theme",
    {
      detail: msg(
        "{status, select, inProgress {Setting the theme} completed {Set the theme} failed {Failed to set the theme} declined {Declined to set the theme} stopped {Stopped setting the theme} other {Setting the theme}}",
      ),
    },
  ],
  [
    "Launch\nLaunching\nLaunched\na project thread",
    {
      detail: msg(
        "{status, select, inProgress {Launching a project thread} completed {Launched a project thread} failed {Failed to launch a project thread} declined {Declined to launch a project thread} stopped {Stopped launching a project thread} other {Launching a project thread}}",
      ),
    },
  ],
  [
    "List\nListing\nListed\nprojects",
    {
      detail: msg(
        "{status, select, inProgress {Listing projects} completed {Listed projects} failed {Failed to list projects} declined {Declined to list projects} stopped {Stopped listing projects} other {Listing projects}}",
      ),
    },
  ],
  [
    "Read\nReading\nRead\na project",
    {
      detail: msg(
        "{status, select, inProgress {Reading a project} completed {Read a project} failed {Failed to read a project} declined {Declined to read a project} stopped {Stopped reading a project} other {Reading a project}}",
      ),
    },
  ],
  [
    "Register\nRegistering\nRegistered\na project",
    {
      detail: msg(
        "{status, select, inProgress {Registering a project} completed {Registered a project} failed {Failed to register a project} declined {Declined to register a project} stopped {Stopped registering a project} other {Registering a project}}",
      ),
    },
  ],
  [
    "Update\nUpdating\nUpdated\na project",
    {
      detail: msg(
        "{status, select, inProgress {Updating a project} completed {Updated a project} failed {Failed to update a project} declined {Declined to update a project} stopped {Stopped updating a project} other {Updating a project}}",
      ),
    },
  ],
  [
    "Delete\nDeleting\nDeleted\na project",
    {
      detail: msg(
        "{status, select, inProgress {Deleting a project} completed {Deleted a project} failed {Failed to delete a project} declined {Declined to delete a project} stopped {Stopped deleting a project} other {Deleting a project}}",
      ),
    },
  ],
  [
    "Clone\nCloning\nCloned\na repository",
    {
      detail: msg(
        "{status, select, inProgress {Cloning a repository} completed {Cloned a repository} failed {Failed to clone a repository} declined {Declined to clone a repository} stopped {Stopped cloning a repository} other {Cloning a repository}}",
      ),
    },
  ],
  [
    "Prepare\nPreparing\nPrepared\nan attachment upload",
    {
      detail: msg(
        "{status, select, inProgress {Preparing an attachment upload} completed {Prepared an attachment upload} failed {Failed to prepare an attachment upload} declined {Declined to prepare an attachment upload} stopped {Stopped preparing an attachment upload} other {Preparing an attachment upload}}",
      ),
    },
  ],
  [
    "Discard\nDiscarding\nDiscarded\na pending attachment",
    {
      detail: msg(
        "{status, select, inProgress {Discarding a pending attachment} completed {Discarded a pending attachment} failed {Failed to discard a pending attachment} declined {Declined to discard a pending attachment} stopped {Stopped discarding a pending attachment} other {Discarding a pending attachment}}",
      ),
    },
  ],
  [
    "Send\nSending\nSent\nattachments",
    {
      detail: msg(
        "{status, select, inProgress {Sending attachments} completed {Sent attachments} failed {Failed to send attachments} declined {Declined to send attachments} stopped {Stopped sending attachments} other {Sending attachments}}",
      ),
    },
  ],
  [
    "Preview\nPreviewing\nPreviewed\nan HTML page",
    {
      detail: msg(
        "{status, select, inProgress {Previewing an HTML page} completed {Previewed an HTML page} failed {Failed to preview an HTML page} declined {Declined to preview an HTML page} stopped {Stopped previewing an HTML page} other {Previewing an HTML page}}",
      ),
    },
  ],
  [
    "Render\nRendering\nRendered\nan HTML page",
    {
      detail: msg(
        "{status, select, inProgress {Rendering an HTML page} completed {Rendered an HTML page} failed {Failed to render an HTML page} declined {Declined to render an HTML page} stopped {Stopped rendering an HTML page} other {Rendering an HTML page}}",
      ),
    },
  ],
  [
    "Send\nSending\nSent\na message",
    {
      detail: msg(
        "{status, select, inProgress {Sending a message} completed {Sent a message} failed {Failed to send a message} declined {Declined to send a message} stopped {Stopped sending a message} other {Sending a message}}",
      ),
    },
  ],
]);
