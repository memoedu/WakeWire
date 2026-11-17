import {
  type ArticlePublisher,
  type ArticleReader,
  type ArticleReview,
  type ArticleState,
  mentionIdentity,
  saveReviewDraft,
  scanArticles,
  snapshotArticle,
  validateArticle,
} from "./remnote-zhihu.js";

export function reviewIssue(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  for (const [pattern, label] of [
    [/^sync_/u, "双向同步存在待处理的冲突或格式问题，已保留双方内容，请查看同步反馈。"],
    [/knowledge base/u, "当前 RemNote 连接的是另一个知识库，目标文章库未连接。"],
    [/mention|profile_changed/u, "标准艾特的账号无法明确核验，请确认被提及者。"],
    [
      /cloud draft changed|author edits|review draft/u,
      "知乎草稿已有人工修改或仍待人工审核，已保留您的修改。",
    ],
    [/hierarchy|list levels/u, "正文层级超出知乎可保真显示范围。"],
    [/table_of_contents/u, "知乎原生目录设置未通过保存核验，已暂停该篇发布。"],
    [/link_card/u, "知乎卡片的类型、目标地址或标题未通过核验，已暂停该篇发布。"],
    [/equation|latex|math/iu, "公式数据或 LaTeX 保真核验失败，已暂停该篇发布。"],
    [/link_unsupported|reference_unresolved/u, "超链接或内部引用未能完整转换，请核对原稿。"],
    [/native_element_unsupported/u, "正文包含尚不支持的原生富文本元素，请核对该篇格式。"],
    [/readback mismatch/u, "知乎草稿保存后的正文或格式与原稿不一致，已停止发布。"],
    [/duplicate/u, "内容与已发布文章重复。"],
    [/title/u, "文章标题为空、换行或超过字数限制。"],
    [/body|character/u, "正文为空或超出知乎字数限制。"],
    [/source changed/u, "审核期间原稿发生变化，请重新审核。"],
    [/account|column|login|cookie|Login/u, "知乎登录账号或专栏权限未通过核验。"],
    [/remnote|MCP|bridge/iu, "RemNote 连接或源内容读取失败。"],
    [/draft creation|draft ID/u, "草稿创建结果尚未确认，请先核查，不能重新创建。"],
  ] as const)
    if (pattern.test(message)) return label;
  return "格式或发布条件核验未通过，原稿已保留，请查看运行详情。";
}

export async function auditArticles(options: {
  remnote: ArticleReader;
  publisher: ArticlePublisher;
  documentRemId: string;
  accountId: string;
  columnId: string;
  state: ArticleState;
  save: () => void;
  now: Date;
  slot: string;
  seriesStartDate: string;
  publishedTagRemId?: string;
  aiGeneratedTagRemId?: string;
}): Promise<{
  status: string;
  reviewed: number;
  approved: number;
  blocked: number;
  published: number;
  archived: number;
}> {
  const { state, publisher } = options;
  const scan = await scanArticles(
    options.remnote,
    options.documentRemId,
    options.publishedTagRemId,
    options.aiGeneratedTagRemId,
  );
  delete state.reviewFailure;
  const completed = new Set(state.receipts.map((r) => r.source.remId));
  state.reviews ??= [];
  const sources = scan.sources.filter((s) => !completed.has(s.remId));
  const selected = new Set([...sources.map((s) => s.remId), ...scan.blocked]);
  for (const old of state.reviews)
    if (!selected.has(old.sourceRemId) && ["blocked", "approved"].includes(old.status))
      old.status = "withdrawn";
  const record = (review: ArticleReview) => {
    const existing = state.reviews?.find(
      (r) => r.sourceRemId === review.sourceRemId && r.slot === review.slot,
    );
    if (existing) Object.assign(existing, review);
    else state.reviews?.push(review);
    options.save();
  };
  let approved = 0;
  for (const source of sources) {
    const review: ArticleReview = {
      sourceRemId: source.remId,
      title: source.nodes[0]?.text ?? "待发布文章",
      slot: options.slot,
      checkedAt: options.now.toISOString(),
      fingerprint: source.fingerprint,
      status: "blocked",
      issues: [],
    };
    try {
      if (
        state.syncFeedback?.articles.some(
          (r) => r.sourceRemId === source.remId && r.status === "blocked",
        )
      )
        throw new Error("sync_conflict_requires_review");
      const oldDraft = state.drafts?.find((d) => d.source.remId === source.remId);
      if (oldDraft && oldDraft.reviewMode !== "automatic" && oldDraft.status !== "published")
        throw new Error("manual review draft was preserved");
      const prepared = await publisher.prepare(source.nodes);
      validateArticle(source, prepared, state);
      // This is a draft-only operation. The existing creation/write fences remain authoritative.
      const saved = await saveReviewDraft({
        ...options,
        now: new Date(options.slot),
        sourceRemId: source.remId,
        reviewMode: "automatic",
      });
      const draft = state.drafts?.find((d) => d.source.remId === source.remId);
      if (!draft || draft.source.fingerprint !== source.fingerprint)
        throw new Error("source changed during review");
      if (mentionIdentity(prepared.mentionBindings) !== mentionIdentity(draft.mentionBindings))
        throw new Error("mention identity changed during review");
      const fresh = await snapshotArticle(
        options.remnote,
        source.remId,
        Boolean(source.tagTrigger),
        options.aiGeneratedTagRemId,
        source.nativeRichText,
      );
      if (fresh.fingerprint !== source.fingerprint || fresh.parentRemId !== source.parentRemId)
        throw new Error("source changed during review");
      draft.reviewMode = "automatic";
      draft.status = "ready";
      Object.assign(review, {
        title: saved.title,
        draftId: saved.id,
        editorUrl: saved.editorUrl,
        status: "approved",
      });
      for (const prior of state.reviews)
        if (prior.sourceRemId === source.remId && prior.status === "blocked")
          prior.status = "resolved";
      approved++;
    } catch (error) {
      review.issues = [reviewIssue(error)];
      const draft = state.drafts?.find((d) => d.source.remId === source.remId);
      if (draft?.draftId) {
        review.draftId = draft.draftId;
        review.editorUrl = draft.editorUrl ?? `https://zhuanlan.zhihu.com/p/${draft.draftId}/edit`;
      }
    }
    record(review);
  }
  for (const sourceRemId of scan.blocked) {
    let title = "来源结构待核对";
    try {
      title = (await options.remnote.read(sourceRemId)).title.replace(/^%/u, "").trim() || title;
    } catch {
      /* Keep the source untouched if metadata cannot be read. */
    }
    record({
      sourceRemId,
      title,
      slot: options.slot,
      checkedAt: options.now.toISOString(),
      status: "blocked",
      issues: ["来源存在重叠标记或不支持的内容，未创建可发布稿件。"],
    });
  }
  const blocked = sources.length - approved + scan.blocked.length;
  options.save();
  return {
    status: blocked ? "blocked" : approved ? "review-approved" : "empty",
    reviewed: sources.length + scan.blocked.length,
    approved,
    blocked,
    published: 0,
    archived: 0,
  };
}

export function articleFeedback(state: ArticleState, now: Date, phase: string, slot?: string) {
  const syncEntries = (state.syncFeedback?.articles ?? []).filter(
    (r) =>
      r.status === "blocked" ||
      (r.status === "revision-approved" && (!slot || r.publicationSlot === slot)),
  );
  const syncBlocked = new Set(
    syncEntries.filter((r) => r.status === "blocked").map((r) => r.sourceRemId),
  );
  const completed = new Set(
    state.receipts.filter((r) => r.stage !== "submitting").map((r) => r.source.remId),
  );
  const articles = (state.reviews ?? [])
    .filter(
      (r) =>
        !completed.has(r.sourceRemId) &&
        !syncBlocked.has(r.sourceRemId) &&
        (r.status === "blocked" || (r.status === "approved" && (!slot || r.slot === slot))),
    )
    .map((r) => ({
      title: r.title,
      publicationSlot: r.slot,
      checkedAt: r.checkedAt,
      status: r.status,
      issues: r.issues,
      ...(r.editorUrl ? { editorUrl: r.editorUrl } : {}),
    }));
  const generalIssues = [
    ...(state.reviewFailure ? [state.reviewFailure.issue] : []),
    ...state.receipts
      .filter((r) => r.stage !== "archived")
      .map((r) =>
        r.stage === "verified"
          ? `《${r.title}》已发布（${r.url}）；${r.archiveIssue ?? "RemNote 归档待完成。"}`
          : `《${r.title}》的既有发布记录尚未完成核验或归档，请先核对；系统不会重复发布。`,
      ),
  ];
  const synchronization = syncEntries.map((r) => ({
    title: `${r.status === "revision-approved" ? "修订：" : ""}${r.title}`,
    publicationSlot: r.publicationSlot,
    checkedAt: state.syncFeedback?.updatedAt,
    status: r.status === "blocked" ? "blocked" : "approved",
    issues: r.issues.map((code) => syncIssue(code)),
    ...(r.editorUrl ? { editorUrl: r.editorUrl } : {}),
    ...(r.url ? { url: r.url } : {}),
  }));
  const issues =
    articles.filter((r) => r.status === "blocked").length +
    synchronization.filter((r) => r.status === "blocked").length +
    generalIssues.length;
  return {
    updatedAt: now.toISOString(),
    phase,
    ...(slot ? { publicationSlot: slot } : {}),
    articles: [...articles, ...synchronization],
    issues,
    generalIssues,
  };
}

function syncIssue(code: string): string {
  if (/settings|columns/.test(code))
    return "原文的封面、评论或专栏等设置暂不能保真更新，已保留原文。";
  if (/same_node/.test(code)) return "两端修改了同一个节点，请选择或合并双方内容。";
  if (/structure|sibling|blank/.test(code))
    return "层级、节点顺序或空行存在无法安全合并的差异，请核对。";
  if (/deletion/.test(code)) return "检测到删除或无法确认身份的替换，已保留原节点。";
  if (/preview_edited/.test(code)) return "修订草稿已有人工修改，请核对修订版本。";
  if (/pending|unknown/.test(code))
    return "上次同步或修订结果尚未确认，已停止重放，等待核对原记录。";
  return "同步格式、来源或连接核验未通过，双方内容已保留。";
}
