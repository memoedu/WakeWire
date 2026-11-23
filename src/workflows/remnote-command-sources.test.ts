import { describe, expect, it, vi } from "vitest";
import { maintenanceBatch, verifyFrozenCommand } from "./remnote-command-batch.js";
import {
  CommandSourceSchema,
  findLegacyReceipt,
  MaintenanceDocumentsSchema,
  maintenanceInstructions,
  scanCommandSource,
  verifyCommandSource,
} from "./remnote-command-sources.js";
import { eventIdFor, type RemNode, type RemNoteReader, scanTodo } from "./remnote-todo.js";
import { pendingRepairDisposition } from "./remnote-todo-cli.js";

it("holds every batch member while mapping repair failures only to the affected items", () => {
  const ids = ["ready", "blocked", "waiting"];
  expect(
    pendingRepairDisposition(ids, {
      ready: false,
      readyIds: ["ready"],
      blocked: [
        { remId: "blocked", message: "independent review failed" },
        { remId: "unrelated", message: "other document" },
      ],
    }),
  ).toEqual({
    waiting: ids,
    errors: [{ remId: "blocked", message: "independent review failed" }],
  });
  expect(pendingRepairDisposition(ids, { ready: true })).toEqual({ waiting: [], errors: [] });
});

function fixture(extra: RemNode[] = []): RemNoteReader {
  const nodes: RemNode[] = [
    { remId: "root", title: "维护根", remType: "document" },
    { remId: "doc", title: "某工作流", remType: "document", parentRemId: "root" },
    { remId: "task", title: "%保留原文", parentRemId: "doc" },
    { remId: "detail", title: "$x^2$\n另一行", parentRemId: "task" },
    { remId: "done", title: "已完成 ", parentRemId: "doc" },
    { remId: "archived", title: "%旧事项", parentRemId: "done" },
    { remId: "deferred", title: "暂不处理", parentRemId: "doc" },
    { remId: "deferred-task", title: "%暂不执行", parentRemId: "deferred" },
    { remId: "legacy-deferred", title: "暂时不做", parentRemId: "doc" },
    { remId: "legacy-deferred-task", title: "%旧暂存", parentRemId: "legacy-deferred" },
    { remId: "routine", title: "%%暂不投递", parentRemId: "doc" },
    { remId: "other", title: "其他 Document", remType: "document", parentRemId: "doc" },
    { remId: "other-task", title: "%独立范围", parentRemId: "other" },
    ...extra,
  ];
  return {
    children: async (parent) => ({ children: nodes.filter((n) => n.parentRemId === parent) }),
    read: async (id) => {
      const node = nodes.find((n) => n.remId === id);
      if (!node) throw new Error("missing");
      return node;
    },
    create: vi.fn(),
    move: vi.fn(),
    updateTitle: vi.fn(),
  };
}

describe("shared RemNote command sources", () => {
  it("sends ordered neighboring roots together and splits only at empty leaf siblings", async () => {
    const separator = { remId: "separator", title: " ", parentRemId: "pending" };
    const remnote = fixture([
      { remId: "pending", title: "待发送", parentRemId: "doc" },
      { remId: "lead", title: "", parentRemId: "pending" },
      { remId: "a", title: "第一项", parentRemId: "pending" },
      { remId: "child", title: "细节", parentRemId: "a" },
      { remId: "empty-parent", title: "", parentRemId: "pending" },
      { remId: "detail2", title: "有内容", parentRemId: "empty-parent" },
      separator,
      { remId: "separator2", title: "", parentRemId: "pending" },
      { remId: "b", title: "另一条命令", parentRemId: "pending" },
    ]);
    const source = CommandSourceSchema.parse({ documentRemId: "doc", title: "一次性命令" });
    const { pendingGroups } = await scanCommandSource(remnote, source, new Set());
    expect(pendingGroups.map((group) => group.map((task) => task.taskRemId))).toEqual([
      ["a", "empty-parent"],
      ["b"],
    ]);
    const batch = maintenanceBatch(pendingGroups[0] ?? [], true);
    if (!batch) throw Error("missing batch");
    expect(batch.prompt).toBe("- 第一项\n  - 细节\n\n- \n  - 有内容");
    await expect(verifyFrozenCommand(remnote, batch)).resolves.toBeUndefined();
    separator.title = "新内容";
    await expect(verifyFrozenCommand(remnote, batch)).rejects.toThrow("分组已变化");
  });
  it.each(["failed", "held", "delivered"])(
    "preserves old %s receipts across root and route migration",
    async (status) => {
      const source = CommandSourceSchema.parse({
        documentRemId: "new",
        title: "新入口",
        legacyReceipts: [
          { documentRemId: "old-todo", routeId: "ordinary" },
          { documentRemId: "old-maintenance", routeId: "maintenance" },
        ],
      });
      const receipt = {
        id: "old",
        status,
        threadId: null,
        turnId: null,
        dispatchStarted: status !== "held",
      };
      const lookup = vi.fn(async (_route: string, event: string) =>
        event === eventIdFor("old-maintenance", "task") ? receipt : undefined,
      );
      expect(await findLegacyReceipt(source, "task", lookup)).toEqual(receipt);
      expect(lookup.mock.calls).toEqual([
        ["ordinary", eventIdFor("old-todo", "task")],
        ["maintenance", eventIdFor("old-maintenance", "task")],
      ]);
    },
  );
  it("exports identical originals and identities; only maintenance adds separate instructions", async () => {
    const remnote = fixture();
    const ordinary = CommandSourceSchema.parse({ documentRemId: "doc", title: "命令" });
    const maintenance = {
      ...ordinary,
      scope: "与 RemNote 有关的操作和插件开发；具体实现按任务查找。",
    };
    const a = await scanCommandSource(remnote, ordinary, new Set(["other"]));
    const b = await scanCommandSource(remnote, maintenance, new Set(["other"]));
    const raw = await scanTodo(
      remnote,
      "doc",
      undefined,
      new Set(["other", "done", "deferred", "legacy-deferred"]),
    );
    expect(a.tasks).toEqual(raw.tasks);
    expect(a.tasks.map((t) => t.taskRemId)).toEqual(["task"]);
    expect(b.tasks.map(({ developerInstructions: _, ...task }) => task)).toEqual(a.tasks);
    expect(b.tasks[0]?.developerInstructions).toContain(maintenance.scope);
    expect(maintenanceInstructions(ordinary)).toBeUndefined();
    expect(remnote.create).not.toHaveBeenCalled();
    expect(remnote.move).not.toHaveBeenCalled();
    expect(remnote.updateTitle).not.toHaveBeenCalled();
  });

  it("accepts multiple-project descriptions without enforcing a single repository and rejects duplicate identities", () => {
    const config = {
      rootRemId: "root",
      documents: [{ documentRemId: "doc", title: "组合", scope: "项目甲、项目乙及其配套工作流" }],
    };
    expect(MaintenanceDocumentsSchema.parse(config).documents).toHaveLength(1);
    expect(
      MaintenanceDocumentsSchema.safeParse({
        ...config,
        documents: [...config.documents, ...config.documents],
      }).success,
    ).toBe(false);
    expect(MaintenanceDocumentsSchema.safeParse({ ...config, rootRemId: "doc" }).success).toBe(
      false,
    );
  });

  it("validates exact Document identity and ancestry before scanning", async () => {
    const remnote = fixture();
    const source = CommandSourceSchema.parse({ documentRemId: "doc", title: "某工作流" });
    await expect(verifyCommandSource(remnote, source, "root")).resolves.toBeUndefined();
    await expect(verifyCommandSource(remnote, source, "elsewhere")).rejects.toThrow("outside");
    await expect(
      verifyCommandSource(remnote, { ...source, documentRemId: "task" }),
    ).rejects.toThrow("Document");
  });
});
