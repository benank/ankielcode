import { describe, expect, it, vi } from "vite-plus/test";

import { recentThreadsDockMenu, recentThreadsJumpList } from "./DesktopRecentThreads.ts";

const threads = [
  { environmentId: "env-1", threadId: "thread-1", title: "Fix the build" },
  { environmentId: "env 2", threadId: "thread-2", title: "x".repeat(120) },
];

describe("recentThreadsDockMenu", () => {
  it("lists threads under a header and opens each one's thread link", () => {
    const open = vi.fn();
    const menu = recentThreadsDockMenu(threads, open);
    expect(menu.map((item) => [item.label, item.enabled])).toEqual([
      ["Recent Threads", false],
      ["Fix the build", undefined],
      [`${"x".repeat(79)}…`, undefined],
    ]);
    (menu[2]!.click as () => void)();
    expect(open).toHaveBeenCalledExactlyOnceWith("ankielcode://thread/env%202/thread-2");
  });

  it("is empty without threads, and leaves out ids the app would not open", () => {
    expect(recentThreadsDockMenu([], vi.fn())).toEqual([]);
    expect(
      recentThreadsDockMenu([{ environmentId: " env", threadId: "..", title: "Bad" }], vi.fn()),
    ).toEqual([]);
  });
});

describe("recentThreadsJumpList", () => {
  const launch = { program: "C:\\Ankiel\\Ankiel Code.exe", leadingArgs: [] };

  it("relaunches the app with each thread link", () => {
    const [category] = recentThreadsJumpList(threads, launch, []) ?? [];
    expect(category).toMatchObject({ type: "custom", name: "Recent Threads" });
    expect(category?.items?.[0]).toMatchObject({
      type: "task",
      title: "Fix the build",
      program: launch.program,
      args: '"ankielcode://thread/env-1/thread-1"',
    });
  });

  it("passes an unpackaged build's app path before the link", () => {
    const [category] =
      recentThreadsJumpList(threads, { ...launch, leadingArgs: ["C:\\src\\app"] }, []) ?? [];
    expect(category?.items?.[0]?.args).toBe('"C:\\src\\app" "ankielcode://thread/env-1/thread-1"');
  });

  it("leaves out items the user removed, and clears the list when nothing is left", () => {
    const removed = [{ type: "task" as const, args: '"ankielcode://thread/env-1/thread-1"' }];
    const [category] = recentThreadsJumpList(threads, launch, removed) ?? [];
    expect(category?.items?.map((item) => item.args)).toEqual([
      '"ankielcode://thread/env%202/thread-2"',
    ]);
    expect(recentThreadsJumpList(threads.slice(0, 1), launch, removed)).toBeNull();
  });
});
