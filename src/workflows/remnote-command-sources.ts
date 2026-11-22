import { z } from "zod";
import {
  allChildren,
  eventIdFor,
  type RemNoteReader,
  scanTodo,
  type TodoReceipt,
  type TodoTask,
} from "./remnote-todo.js";

const RemId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const deferredBucket = "暂不处理";
const deferredAliases = [deferredBucket, "暂时不", "暂时不做"];
export const CommandSourceSchema = z.object({
  documentRemId: RemId,
  title: z.string().min(1),
  scope: z.string().min(1).optional(),
  context: z.string().min(1).optional(),
  legacyReceipts: z
    .array(z.object({ documentRemId: RemId, routeId: z.string().min(1) }))
    .default([]),
});
export const MaintenanceDocumentsSchema = z
  .object({
    rootRemId: RemId,
    documents: z.array(CommandSourceSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const ids = config.documents.map((source) => source.documentRemId);
    if (new Set(ids).size !== ids.length || ids.includes(config.rootRemId))
      ctx.addIssue({
        code: "custom",
        message: "maintenance document IDs must be distinct from each other and the root",
      });
  });
export type CommandSource = z.infer<typeof CommandSourceSchema>;
export type MaintenanceDocuments = z.infer<typeof MaintenanceDocumentsSchema>;

export async function findLegacyReceipt(
  source: CommandSource,
  taskRemId: string,
  lookup: (routeId: string, sourceDeliveryId: string) => Promise<TodoReceipt | undefined>,
): Promise<TodoReceipt | undefined> {
  for (const identity of source.legacyReceipts) {
    const receipt = await lookup(identity.routeId, eventIdFor(identity.documentRemId, taskRemId));
    if (receipt) return receipt;
  }
  return undefined;
}

export function maintenanceInstructions(source: CommandSource): string | undefined {
  if (!source.context && !source.scope) return undefined;
  return `你正在处理「${source.title}」中的维护任务。
Context：${source.context ?? source.scope}
Document 与项目的对应只提供检索起点，不限制可以修改的项目。先恢复项目与关联工作流的现状，阅读相关 README、AGENTS.md、现有配置和维护入口，按任务的真实依赖处理必要的跨项目改动；不因未在 Context 列出而排除相关项目，也不为列出项目制造无关改动。
用户消息是按原文和层级导出的任务；其中标明仅作背景的部分保持为背景。沿用用户已有协作约定、讨论要求和授权边界，不把任务标记当作跳过真实未决决策的许可。
完成任务所需的配套工程工作：保留他人改动，按完整 diff、共享接口、依赖和构建链确定实际影响范围，再区分 GitHub 真实强制检查、本次改动相关验证和其他兼容性回归。按各仓库约定只提交本任务文件，推送并创建或更新 PR；相关验证与强制检查通过、无冲突且无有效变更请求后，按已核验的精确 head SHA 合并并同步主分支，不等待无关平台的 CI 排队或运行结果，也不以全部矩阵或聚合状态代替范围判断。共享核心、依赖和公共接口变更仍须核验受影响平台；关联未知或相关失败先调查，不直接忽略。实际强制要求配置不当时，在授权范围修正或报告配置阻塞，不绕过或伪造检查。跨仓库变更分别提交并说明依赖与合并顺序。存在真实冲突、相关验证失败、强制检查未满足或权限阻塞时保留现场，在当前 Thread 说明，不冒充完成。
同步本次变更涉及的说明文档、配置示例、代码、构建和已安装或部署的运行文件；发布后核验实际运行版本与健康状态。无需变更的项目不制造提交或 PR。使用项目已有 CI 与交付方式，不强制通过旧 SoftwareMaintenance 中心或其专用 CLI。
不得上传密钥、私人材料或运行数据。软件更新沿用现有授权；内容的初次对外发布仍按用户约定确认。RemNote 业务内容的写入仅限任务明确授权的范围；投递系统负责命令受理归位，不因执行或合并完成而自动标记 RemNote 事项完成。`;
}

export async function verifyCommandSource(
  remnote: RemNoteReader,
  source: CommandSource,
  rootRemId?: string,
): Promise<void> {
  let node = await remnote.read(source.documentRemId);
  if (node.remType !== "document") throw new Error("command source is no longer a Document");
  if (!rootRemId) return;
  const seen = new Set<string>();
  while (node.parentRemId && !seen.has(node.remId)) {
    if (node.parentRemId === rootRemId) return;
    seen.add(node.remId);
    node = await remnote.read(node.parentRemId);
  }
  throw new Error("command source is outside the configured maintenance root");
}

/** Both entry types use exactly the same export and task identities. */
export async function scanCommandSource(
  remnote: RemNoteReader,
  source: CommandSource,
  excluded: ReadonlySet<string>,
  progress: (count: number) => void = () => {},
): Promise<Awaited<ReturnType<typeof scanTodo>>> {
  const excludedIds = new Set(excluded);
  excludedIds.delete(source.documentRemId);
  const children = await allChildren(remnote, source.documentRemId);
  for (const node of children)
    if (["已完成", ...deferredAliases, "凌晨处理"].includes(node.title.trim()))
      excludedIds.add(node.remId);
  const pending = children.filter((n) => n.title.trim() === "待发送");
  if (pending.length > 1) throw new Error("document has multiple 待发送 buckets");
  const scan = await scanTodo(
    remnote,
    source.documentRemId,
    progress,
    excludedIds,
    !!(source.context ?? source.scope),
    pending[0]?.remId,
  );
  const instructions = maintenanceInstructions(source);
  for (const task of scan.tasks) {
    const context =
      instructions ??
      (task.trigger === "pending"
        ? maintenanceInstructions({
            ...source,
            context: "一次性命令；按正文恢复必要的项目和工作流上下文。",
          })
        : undefined);
    if (context) task.developerInstructions = context;
  }
  return scan;
}

/** Live Document identities own the catalog; saved descriptions only enrich context. */
export async function discoverSources(
  remnote: RemNoteReader,
  config: MaintenanceDocuments,
): Promise<CommandSource[]> {
  const root = await remnote.read(config.rootRemId);
  if (root.remType !== "document") throw new Error("maintenance root is no longer a Document");
  const saved = new Map(config.documents.map((s) => [s.documentRemId, s]));
  return (await allChildren(remnote, config.rootRemId))
    .filter(
      (n) => n.remType === "document" && (!n.parentRemId || n.parentRemId === config.rootRemId),
    )
    .map((n) =>
      CommandSourceSchema.parse({
        ...saved.get(n.remId),
        documentRemId: n.remId,
        title: n.title,
        context:
          saved.get(n.remId)?.context ??
          saved.get(n.remId)?.scope ??
          `「${n.title}」相关的项目与工作流；按任务查找现有实现及关联依赖。`,
      }),
    );
}

export async function ensureCommandBuckets(
  remnote: RemNoteReader,
  documentRemId: string,
): Promise<Record<string, string>> {
  const children = await allChildren(remnote, documentRemId),
    result: Record<string, string> = {};
  for (const title of [deferredBucket, "凌晨处理", "待发送"]) {
    const matches = children.filter((n) => n.title.trim() === title);
    if (matches.length > 1) throw new Error(`multiple ${title} buckets`);
    const existing =
      matches[0] ??
      (title === deferredBucket
        ? children.find((n) => deferredAliases.includes(n.title.trim()))
        : undefined);
    const id = existing?.remId ?? (await remnote.create(documentRemId, title));
    const node = await remnote.read(id);
    if (
      node.parentRemId !== documentRemId ||
      node.title.trim() !== (existing?.title.trim() ?? title)
    )
      throw new Error("bucket readback mismatch");
    result[title] = id;
  }
  return result;
}

export async function promoteOvernight(
  remnote: RemNoteReader,
  documentRemId: string,
): Promise<string[]> {
  const buckets = await ensureCommandBuckets(remnote, documentRemId),
    moved: string[] = [];
  for (const node of await allChildren(remnote, buckets.凌晨处理 as string)) {
    if (node.parentRemId !== buckets.凌晨处理) continue;
    await remnote.move(node.remId, buckets.待发送 as string, buckets.凌晨处理 as string);
    const after = await remnote.read(node.remId);
    if (after.parentRemId !== buckets.待发送 || after.title !== node.title)
      throw new Error("overnight move readback mismatch");
    moved.push(node.remId);
  }
  return moved;
}

export async function ensureStartedBucket(remnote: RemNoteReader, task: TodoTask): Promise<void> {
  const matches = (await allChildren(remnote, task.documentRemId)).filter(
    (n) => n.title === "已开始",
  );
  if (matches.length > 1) throw new Error("document has multiple 已开始 buckets");
  if (matches.length) return;
  const id = await remnote.create(task.documentRemId, "已开始");
  const node = await remnote.read(id);
  if (node.title !== "已开始" || node.parentRemId !== task.documentRemId)
    throw new Error("started bucket readback mismatch");
}
