/**
 * 全屏长文编辑器（report-longform D12/§5）：`#/compose?format=article` 的整页编辑器。
 *
 * - ≥1024px 左右分栏（左编辑、右实时预览各自滚动）；<1024px 官方 `Tabs`（撰写/预览）；
 * - 工具栏（官方 `DropdownMenu`）：四块插入模板（stats/steps/compare/callout）、插入图片
 *   （上传 `/api/media` 后插入 `![alt](/api/media/<hash>)`）；计数按 article 上限
 *   （512,000，`MAX_ARTICLE_CHARS`）；
 * - 校验：300ms 防抖 `parseArticle`；`error` 禁用提交并给「行/块/怎么修」，点击定位
 *   到 textarea 对应行；`warning`（未知块/未知 status/tone/截断）只提示；
 * - 草稿：`report.draft.v1:article:root`（引用场景 `article:quote:<id>`），防抖持久化、
 *   挂载恢复、发布成功后清除；
 * - 提交：`client.createPost({ body, kind:"article" })`，busy 门防双击，成功
 *   `navigate(postHref(first))`；静态归档只读（ComposePage 层拦截，本组件兜底）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type { PostView } from "@core/types";
import {
  ARTICLE_BLOCK_NAMES,
  articleBlockTemplate,
  articleSummary,
  parseArticle,
  type BlockIssue,
} from "@core/article";
import { MAX_ARTICLE_CHARS } from "@core/validation";
import { cn } from "cn";
import {
  ChevronDownIcon,
  ImagePlusIcon,
  Loader2Icon,
  PlusIcon,
  QuoteIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { AuthorLine } from "@/components/AuthorAvatar";
import { ArticleBody } from "@/components/ArticleBody";
import { ArticleMediaProvider } from "@/lib/article-media";
import { Markdown } from "@/components/Markdown";
import { toast } from "@/components/ui/toast";
import { useConnection } from "@/state/connection";
import { goBack, navigate, routeSource, usePageRoute } from "@/lib/router";
import { postHref } from "@/lib/post-href";
import { extractTags } from "@/lib/tags";

const DRAFT_NAMESPACE = "report.draft.v1:";
/** 草稿过大提示阈值（design §5.2；提交不依赖草稿）。 */
const DRAFT_WARN_CHARS = 400_000;

const BLOCK_LABELS: Record<(typeof ARTICLE_BLOCK_NAMES)[number], string> = {
  stats: "指标卡（stats）",
  steps: "步骤清单（steps）",
  compare: "前后对比（compare）",
  callout: "提示块（callout）",
};

function loadDraft(key: string): string {
  try {
    const raw = localStorage.getItem(`${DRAFT_NAMESPACE}${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as { body?: unknown };
      return typeof parsed.body === "string" ? parsed.body : "";
    }
  } catch {
    // private mode / 坏数据：按空草稿
  }
  return "";
}

function clearDraft(key: string): void {
  try {
    localStorage.removeItem(`${DRAFT_NAMESPACE}${key}`);
  } catch {
    // ignore
  }
}

/** 300ms 防抖（校验与草稿持久化共用；design §5.3）。 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** 错误的一句话修复建议（面板列 `line / block / fix`，design §5.3）。 */
function fixHint(message: string): string {
  if (/not valid JSON|single JSON object/i.test(message)) {
    return "把块体改成单个合法 JSON 对象（用 JSON 校验器检查逗号/引号）";
  }
  if (/is required/i.test(message)) return "补上提示的必填字段";
  if (/must be a string|must be an array|must be an object/i.test(message)) {
    return "按 schema 修正字段类型（字符串/数组/对象）";
  }
  if (/local \/api\/media/i.test(message)) return "把 media 换成上传后的 /api/media/<hash> 引用";
  if (/truncated/i.test(message)) return "精简内容到上限内（该字段已截断）";
  return "按提示修正该块内容";
}

/** 警告的一句话解释（未知块/未知枚举值/截断，design §5.3）。 */
function warningHint(message: string): string {
  if (/unsupported directive block/i.test(message)) return "该块类型当前版本不识别，仍会原样保存";
  if (/unknown status/i.test(message)) return "未知 status 将按 pending 显示";
  if (/unknown tone/i.test(message)) return "未知 tone 将按 info 显示";
  if (/unknown better/i.test(message)) return "未知 better 将忽略（不判方向）";
  if (/truncated/i.test(message)) return "超上限的内容已截断，建议精简";
  return message;
}

/**
 * 全屏长文编辑页（自含页面壳：页头返回/来源/引用上下文/静态只读都在本组件内，
 * 因为返回保护需要接页头返回按钮）。
 */
export function ArticleEditor() {
  const route = usePageRoute();
  const { client, staticMode } = useConnection();
  const quoteId = route.name === "compose" ? route.quote : null;
  const source = routeSource(route);
  const [quoted, setQuoted] = useState<PostView | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const draftKey = quoted ? `article:quote:${quoted.id}` : "article:root";
  const initial = useRef(loadDraft(draftKey));
  const [body, setBody] = useState(initial.current);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches,
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const submitted = useRef(false);

  // 引用上下文（与 ComposePage 的 note 引用同一取数路径）。
  useEffect(() => {
    if (!client || !quoteId) {
      setQuoted(null);
      setQuoteError(null);
      return;
    }
    let alive = true;
    setLoadingQuote(true);
    client
      .post(quoteId)
      .then((post) => {
        if (!alive) return;
        setQuoted(post);
        setQuoteError(null);
      })
      .catch((err: Error) => {
        if (alive) setQuoteError(err.message);
      })
      .finally(() => {
        if (alive) setLoadingQuote(false);
      });
    return () => {
      alive = false;
    };
  }, [client, quoteId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(mql.matches);
    update();
    mql.addEventListener?.("change", update);
    return () => mql.removeEventListener?.("change", update);
  }, []);

  // 草稿持久化（300ms 防抖；空正文清键——与 PostComposer 同一纪律）。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!body.trim()) {
        clearDraft(draftKey);
        return;
      }
      try {
        localStorage.setItem(`${DRAFT_NAMESPACE}${draftKey}`, JSON.stringify({ body }));
      } catch {
        // private mode / 超限：草稿非提交前提
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [body, draftKey]);

  // 校验（300ms 防抖 parseArticle；预览同源文档对象）。
  const validated = useDebounced(body, 300);
  const doc = useMemo(() => parseArticle(validated), [validated]);
  const issues = doc.issues;
  const errors = useMemo(() => issues.filter((issue) => issue.severity === "error"), [issues]);
  const warnings = useMemo(() => issues.filter((issue) => issue.severity === "warning"), [issues]);
  const htmlHint = useMemo(() => /<[a-zA-Z][^>]*>/.test(validated), [validated]);
  const draftTooLarge = body.length > DRAFT_WARN_CHARS;

  const dirty = body.trim().length > 0 && !submitted.current;

  // 返回保护（与 LeaveGuard/useBackClose 同一套「合成历史条目 + popstate」机制）：
  // 有未提交内容时拦截返回，弹确认；发布成功或空正文直接放行。
  const leaving = useRef(false);
  const atGuard = () =>
    Boolean((window.history.state as { __editorGuard?: boolean } | null)?.__editorGuard);
  const pushGuard = useCallback(() => {
    if (typeof window === "undefined") return;
    window.history.pushState({ ...(window.history.state ?? {}), __editorGuard: true }, "");
  }, []);
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    if (!atGuard()) pushGuard();
    const onPop = () => {
      // 「离开」时：守卫条目被弹出 → 继续退到真正的上一页。
      if (leaving.current) {
        goBack("/");
        return;
      }
      setConfirmLeave(true);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // 合成条目仍在栈顶（未按返回离开）时弹回，避免死条目（卸载中的同名 pop 被忽略）。
      if (atGuard()) {
        leaving.current = true;
        window.history.back();
      }
    };
  }, [dirty, pushGuard]);

  const leaveEditor = () => {
    setConfirmLeave(false);
    submitted.current = true;
    if (atGuard()) {
      // 守卫条目在栈顶：先弹它（popstate → onPop 的 leaving 分支再退一层）。
      leaving.current = true;
      window.history.back();
      return;
    }
    goBack("/");
  };

  const requestLeave = () => {
    if (dirty) setConfirmLeave(true);
    else navigate("/");
  };

  const insertAtCaret = useCallback(
    (text: string, caretInTemplate?: number) => {
      const el = textareaRef.current;
      const start = el ? el.selectionStart : body.length;
      const end = el ? el.selectionEnd : body.length;
      const before = body.slice(0, start);
      const after = body.slice(end);
      const prefix = before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      const suffix = after.length === 0 || after.startsWith("\n") ? "\n" : "\n\n";
      const next = `${before}${prefix}${text}${suffix}${after}`;
      setBody(next);
      const caret = before.length + prefix.length + (caretInTemplate ?? text.length);
      window.requestAnimationFrame(() => {
        const area = textareaRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(caret, caret);
      });
    },
    [body],
  );

  const insertBlock = (name: (typeof ARTICLE_BLOCK_NAMES)[number]) => {
    const template = articleBlockTemplate(name);
    // 光标落在模板 JSON 内（首个换行之后＝块体第一行）。
    insertAtCaret(template, template.indexOf("\n") + 1);
  };

  const insertImage = async (file: File) => {
    if (!client) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|svg)$/i.test(file.name)) {
      setError("只支持图片文件（png/jpg/webp/gif/svg）");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const uploaded = await client.uploadMedia(file);
      const alt = file.name.replace(/\.[^.]+$/, "");
      insertAtCaret(`![${alt}](/api/media/${uploaded.hash})`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  /** 点击错误条目 → 定位 textarea 对应行（design §5.3）。 */
  const locateIssue = (issue: BlockIssue) => {
    const area = textareaRef.current;
    if (!area) return;
    const lines = body.split("\n");
    const lineIndex = Math.max(0, Math.min(lines.length - 1, issue.line - 1));
    const pos = lines.slice(0, lineIndex).join("\n").length + (lineIndex > 0 ? 1 : 0);
    area.focus();
    area.setSelectionRange(pos, pos);
    area.scrollTop = Math.max(0, (lineIndex - 4) * 24);
  };

  const submit = async () => {
    if (!client || busy) return;
    if (staticMode) return;
    if (errors.length > 0) {
      setError("有校验错误未修复，不能发布");
      return;
    }
    if (!body.trim()) {
      setError("正文不能为空");
      return;
    }
    if (uploading) {
      setError("图片还在上传，请稍候");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.createPost({
        body,
        kind: "article",
        quote: quoted?.id ?? null,
        tags: extractTags(body),
      });
      submitted.current = true;
      clearDraft(draftKey);
      toast.add({
        type: "success",
        title: "长文已发布",
        description: "已跳转到文章视图",
        timeout: 3200,
      });
      const first = result.posts[0];
      if (first) navigate(postHref(first));
      else navigate("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value);

  const counter = (
    <InputGroupText
      className={cn("text-xs", body.length > MAX_ARTICLE_CHARS && "text-destructive")}
      data-testid="article-counter"
    >
      {body.length.toLocaleString()} / {MAX_ARTICLE_CHARS.toLocaleString()}
    </InputGroupText>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="outline" size="sm" data-testid="article-insert-block" />
          }
        >
          <PlusIcon data-icon="inline-start" />
          插入区块
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {/* 官方纪律：DropdownMenuLabel＝GroupLabel，必须在 DropdownMenuGroup 内 */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>指令块（P1 四块）</DropdownMenuLabel>
            {ARTICLE_BLOCK_NAMES.map((name) => (
              <DropdownMenuItem
                key={name}
                data-testid={`article-insert-${name}`}
                onClick={() => insertBlock(name)}
              >
                {BLOCK_LABELS[name]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>gallery / log（P2）</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="article-insert-image"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? (
          <Loader2Icon data-icon="inline-start" className="animate-spin" />
        ) : (
          <ImagePlusIcon data-icon="inline-start" />
        )}
        插入图片
      </Button>
      {counter}
    </div>
  );

  const editorPane = (
    <InputGroup className="h-auto flex-col items-stretch gap-0" data-testid="article-editor">
      <InputGroupAddon align="block-start" className="border-b border-border/60 px-2 py-1.5">
        {toolbar}
      </InputGroupAddon>
      <InputGroupTextarea
        ref={textareaRef}
        value={body}
        onChange={onChange}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={"# 标题\n\n正文（Markdown）…\n\n```fde2e:steps\n{ … }\n```"}
        className="min-h-[46dvh] flex-1 font-mono text-[13px] leading-6 lg:min-h-[60dvh]"
        data-testid="article-editor-input"
      />
      <InputGroupAddon align="block-end" className="flex-wrap gap-2 border-t border-border/60 px-2 py-1.5">
        <InputGroupText className="hidden text-xs sm:flex">
          Markdown + 指令块 · ⌘/Ctrl+Enter 发布
        </InputGroupText>
        <div className="ml-auto flex items-center gap-2">
          <InputGroupButton
            type="button"
            size="sm"
            data-testid="article-submit"
            disabled={busy || errors.length > 0 || !body.trim()}
            onClick={() => void submit()}
          >
            {busy ? (
              <Loader2Icon data-icon="inline-start" className="animate-spin" />
            ) : (
              <SendIcon data-icon="inline-start" />
            )}
            发布长文
          </InputGroupButton>
        </div>
      </InputGroupAddon>
    </InputGroup>
  );

  const previewPane = (
    <div
      className="min-h-[46dvh] overflow-y-auto rounded-xl bg-muted/20 px-3 py-2 lg:min-h-[60dvh]"
      data-testid="article-editor-preview"
    >
      {body.trim() ? (
        <ArticleMediaProvider media={[]}>
          <ArticleBody doc={doc} />
        </ArticleMediaProvider>
      ) : (
        <span className="text-sm text-muted-foreground">（空）</span>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="写长文"
        back
        onBack={requestLeave}
        backTestId="compose-back"
        source={
          quoteId ? (
            <span className="inline-flex items-center gap-1">
              <QuoteIcon className="size-3" /> 引用长文
            </span>
          ) : (
            `来自${source}`
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {staticMode ? (
          <Card className="gap-1 p-4 text-sm text-muted-foreground" data-testid="compose-readonly">
            <p className="font-medium text-foreground">静态归档 · 只读</p>
            <p>这份归档以导出时的快照为准，不能写长文、引用或上传图片。</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2 pb-4">
            <Input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              data-testid="article-image-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void insertImage(file);
              }}
            />

      {quoted ? (
        <Card className="relative gap-1 p-3" data-testid="article-editor-quote">
          <div className="flex items-start justify-between gap-2">
            <AuthorLine
              account={quoted.author_account}
              fallbackId={quoted.author}
              time={new Date(quoted.created_at).toLocaleString("zh-CN")}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setQuoted(null)}
              aria-label="移除引用"
            >
              <XIcon />
            </Button>
          </div>
          <div className="line-clamp-3 text-sm text-muted-foreground">
            {quoted.kind === "article" ? (
              <span>{articleSummary(quoted.body_md).title}</span>
            ) : (
              <Markdown source={quoted.body_md} className="[&_p]:my-0" />
            )}
          </div>
        </Card>
      ) : null}

      {errors.length > 0 ? (
        <Alert variant="destructive" data-testid="article-errors">
          <AlertTitle>
            {errors.length} 处错误：修复后才能发布
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 flex flex-col gap-1">
              {errors.slice(0, 8).map((issue, index) => (
                <li key={index}>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto justify-start p-0 text-left text-sm text-destructive"
                    data-testid="article-error-item"
                    data-line={issue.line}
                    data-block={issue.block}
                    onClick={() => locateIssue(issue)}
                  >
                    第 {issue.line} 行 · 块 #{issue.block}：{issue.message}
                  </Button>
                  <span className="block text-xs text-muted-foreground">{fixHint(issue.message)}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {warnings.length > 0 || htmlHint ? (
        <Alert data-testid="article-warnings" className="text-status-interrupted">
          <AlertTitle>提示（不阻止发布）</AlertTitle>
          <AlertDescription className="text-foreground/90">
            <ul className="flex flex-col gap-0.5 text-xs">
              {warnings.slice(0, 6).map((issue, index) => (
                <li key={index} data-testid="article-warning-item">
                  第 {issue.line} 行 · 块 #{issue.block}：{warningHint(issue.message)}
                </li>
              ))}
              {htmlHint ? (
                <li data-testid="article-html-hint">HTML 标签不会被解释（按纯文本显示）</li>
              ) : null}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {draftTooLarge ? (
        <Alert data-testid="article-draft-large">
          <AlertDescription>草稿过大（{body.length.toLocaleString()} 字符），本地可能无法保存；提交仍可进行。</AlertDescription>
        </Alert>
      ) : null}

      {wide ? (
        <div className="grid grid-cols-2 items-start gap-3" data-testid="article-editor-split">
          {editorPane}
          {previewPane}
        </div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "write" | "preview")}
          className="gap-2"
        >
          <TabsList aria-label="撰写与预览" data-testid="article-editor-tabs">
            <TabsTrigger value="write">撰写</TabsTrigger>
            <TabsTrigger value="preview">预览</TabsTrigger>
          </TabsList>
          <TabsContent value="write">{editorPane}</TabsContent>
          <TabsContent value="preview">{previewPane}</TabsContent>
        </Tabs>
      )}

      {error ? (
        <Alert variant="destructive" data-testid="article-editor-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Dialog open={confirmLeave} onOpenChange={(open) => {
        if (open) {
          setConfirmLeave(true);
          return;
        }
        setConfirmLeave(false);
        // 留下：重新压一层守卫条目（返回键仍受保护）。
        if (dirty) pushGuard();
      }}>
        <DialogContent data-testid="article-leave-confirm">
          <DialogHeader>
            <DialogTitle>离开编辑器？</DialogTitle>
            <DialogDescription>未提交的正文会保留在本机草稿里。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="article-leave-cancel"
              onClick={() => {
                setConfirmLeave(false);
                pushGuard();
              }}
            >
              留下
            </Button>
            <Button
              data-testid="article-leave-ok"
              onClick={leaveEditor}
            >
              离开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
          </div>
        )}
      </div>

      <div className="mt-1 px-1 text-xs leading-relaxed text-muted-foreground">
        长文上限 512,000 字符；「插入区块」用 fde2e 指令块（stats / steps / compare / callout）。
      </div>
    </div>
  );
}
