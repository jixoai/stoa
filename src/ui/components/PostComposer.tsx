import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { cn } from "cn";
import type { PostView } from "@core/types";
import {
  ImagePlusIcon,
  Loader2Icon,
  LockIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Markdown } from "@/components/Markdown";
import { TagPicker } from "@/components/TagPicker";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { toast } from "@/components/ui/toast";
import { useConnection } from "@/state/connection";
import type { AccountRow } from "@/lib/api";
import { toastReadOnly } from "@/lib/readonly";

const MAX_FILES = 4;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "mp4",
  "webm",
  "txt",
  "md",
  "json",
  "log",
]);

interface UploadItem {
  id: string;
  name: string;
  size: number;
  hash: string | null;
  previewUrl: string | null;
  uploading: boolean;
  error: string | null;
}

interface PostComposerProps {
  mode: "post" | "reply";
  parentId?: string;
  /** 草稿持久化键（默认按 mode/parent 推导；引用发帖用 quote-<id>）。 */
  draftKey?: string;
  quotedPost?: PostView | null;
  onRemoveQuote?: () => void;
  onPosted?: (posts: PostView[]) => void;
  autoFocus?: boolean;
  compact?: boolean;
  placeholder?: string;
  submitLabel?: string;
}

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

interface DraftSnapshot {
  body: string;
  tags: string[];
}

function draftKeyOf(mode: "post" | "reply", parentId?: string): string {
  return `${mode}:${parentId ?? "root"}`;
}

function loadDraft(key: string): DraftSnapshot {
  try {
    const raw = localStorage.getItem(`report.draft.v1:${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DraftSnapshot>;
      return {
        body: typeof parsed.body === "string" ? parsed.body : "",
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : [],
      };
    }
  } catch {
    // ignore
  }
  return { body: "", tags: [] };
}

function clearDraft(key: string): void {
  try {
    localStorage.removeItem(`report.draft.v1:${key}`);
  } catch {
    // ignore
  }
}

/**
 * 发帖箱 / 回复框：markdown 预览、附件上传、@ 自动补全（含离线账号）、
 * 引用卡嵌入（引用＝新帖）。附件先传 /api/media 拿 hash，再随正文提交。
 */
export function PostComposer({
  mode,
  parentId,
  draftKey,
  quotedPost = null,
  onRemoveQuote,
  onPosted,
  autoFocus = false,
  compact = false,
  placeholder,
  submitLabel,
}: PostComposerProps) {
  const { client, accounts, staticMode } = useConnection();
  const key = draftKey ?? draftKeyOf(mode, parentId);
  const initialDraft = useRef<DraftSnapshot>(loadDraft(key));
  const [body, setBody] = useState(initialDraft.current.body);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [tags, setTags] = useState<string[]>(initialDraft.current.tags);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<{ query: string; start: number; end: number } | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // 草稿保留：输入 300ms 防抖写 localStorage（附件不持久化）。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!body.trim() && tags.length === 0) {
        clearDraft(key);
        return;
      }
      try {
        localStorage.setItem(`report.draft.v1:${key}`, JSON.stringify({ body, tags }));
      } catch {
        // private mode
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [body, tags, key]);

  // 键盘避让：聚焦时把输入框滚到视口中间（visualViewport 收缩后同样生效）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onFocus = () => {
      window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 260);
    };
    el.addEventListener("focus", onFocus);
    return () => el.removeEventListener("focus", onFocus);
  }, []);

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.disabled !== 2),
    [accounts],
  );

  const suggestions = useMemo(() => {
    if (!suggest) return [];
    const q = suggest.query.toLowerCase();
    return activeAccounts
      .filter((account) => account.id.toLowerCase().includes(q) || account.display.toLowerCase().includes(q))
      .sort((a, b) => {
        const aOnline = a.id === "owner" || a.id === "manager" ? 1 : 0;
        const bOnline = b.id === "owner" || b.id === "manager" ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 8);
  }, [activeAccounts, suggest]);

  useEffect(() => {
    setSuggestIndex(0);
  }, [suggest?.query, suggestions.length]);

  const detectMention = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /(^|[\s(])@([A-Za-z0-9_-]*)$/.exec(before);
    if (!match) {
      setSuggest(null);
      return;
    }
    const query = match[2] ?? "";
    const start = caret - query.length - 1;
    setSuggest({ query, start, end: caret });
  }, []);

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
    detectMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
  };

  const insertMention = (account: AccountRow) => {
    if (!suggest) return;
    const next = `${body.slice(0, suggest.start)}@${account.id} ${body.slice(suggest.end)}`;
    setBody(next);
    setSuggest(null);
    const caret = suggest.start + account.id.length + 2;
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSuggestIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = suggestions[suggestIndex];
        if (chosen) insertMention(chosen);
        return;
      }
      if (event.key === "Escape") {
        setSuggest(null);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  };

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!client) return;
      const room = MAX_FILES - items.length;
      const chosen = files.slice(0, Math.max(0, room));
      if (chosen.length === 0) return;
      setError(null);
      const incoming: UploadItem[] = chosen.map((file) => {
        const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`;
        const isImage = ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extOf(file.name));
        return {
          id,
          name: file.name,
          size: file.size,
          hash: null,
          previewUrl: isImage ? URL.createObjectURL(file) : null,
          uploading: true,
          error: null,
        };
      });
      setItems((prev) => [...prev, ...incoming]);

      for (let index = 0; index < chosen.length; index += 1) {
        const file = chosen[index]!;
        const item = incoming[index]!;
        const ext = extOf(file.name);
        if (file.size > MAX_BYTES) {
          setItems((prev) =>
            prev.map((entry) => (entry.id === item.id ? { ...entry, uploading: false, error: "超过 10MB" } : entry)),
          );
          continue;
        }
        if (!ALLOWED_EXT.has(ext)) {
          setItems((prev) =>
            prev.map((entry) => (entry.id === item.id ? { ...entry, uploading: false, error: `不支持 .${ext}` } : entry)),
          );
          continue;
        }
        try {
          const uploaded = await client.uploadMedia(file);
          setItems((prev) =>
            prev.map((entry) =>
              entry.id === item.id ? { ...entry, uploading: false, hash: uploaded.hash, error: null } : entry,
            ),
          );
        } catch (err) {
          setItems((prev) =>
            prev.map((entry) => (entry.id === item.id ? { ...entry, uploading: false, error: (err as Error).message } : entry)),
          );
        }
      }
    },
    [client, items.length],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    void addFiles([...event.dataTransfer.files]);
  };

  const removeItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((entry) => entry.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((entry) => entry.id !== id);
    });
  };

  const uploadsPending = items.some((item) => item.uploading);
  const uploadError = items.find((item) => item.error)?.error ?? null;
  const mediaHashes = items.filter((item) => item.hash).map((item) => item.hash!);

  const submit = async () => {
    if (!client || busy) return;
    if (!body.trim()) {
      setError("正文不能为空");
      return;
    }
    if (uploadsPending) {
      setError("附件还在上传，请稍候");
      return;
    }
    if (uploadError) {
      setError("有附件上传失败，请移除或重试");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "post"
          ? await client.createPost({
              body,
              quote: quotedPost?.id ?? null,
              media: mediaHashes,
              tags,
            })
          : await client.createReply(parentId!, { body, media: mediaHashes, tags });
      setBody("");
      setTags([]);
      clearDraft(key);
      setItems((prev) => {
        for (const item of prev) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        return [];
      });
      setTab("write");
      toast.add({
        type: "success",
        title: mode === "post" ? "已发布" : "回复已发布",
        description:
          mode === "post"
            ? result.posts.length > 1
              ? `已发出 ${result.posts.length} 条帖子`
              : "帖子已出现在时间线里"
            : "回复已送达该会话",
        timeout: 3200,
      });
      onPosted?.(result.posts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (staticMode) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-3 text-sm text-muted-foreground"
        data-testid="composer-readonly"
        onClick={toastReadOnly}
      >
        <LockIcon className="size-4" />
        静态归档 · 只读：发帖 / 回复 / 上传都不可用。
      </div>
    );
  }

  return (
    <div
      className={cn("relative flex flex-col gap-2", dragOver && "rounded-xl ring-2 ring-ring/60")}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      data-testid="composer"
    >
      <Tabs value={tab} onValueChange={(value) => setTab(value as "write" | "preview")}>
        <div className="flex items-center justify-between">
          <TabsList variant="line" aria-label="编辑与预览">
            <TabsTrigger value="write">撰写</TabsTrigger>
            <TabsTrigger value="preview">预览</TabsTrigger>
          </TabsList>
          <span className="text-xs text-muted-foreground">
            {body.length.toLocaleString()} / 200,000 · ⌘/Ctrl+Enter 发布
          </span>
        </div>

        <TabsContent value="write">
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={body}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onClick={(event) => {
                const el = event.currentTarget;
                detectMention(el.value, el.selectionStart ?? el.value.length);
              }}
              placeholder={placeholder ?? (mode === "post" ? "有什么要说？用 @ 提到某人…" : "发布你的回复…（支持 markdown）")}
              className={cn("min-h-28 resize-y", compact && "min-h-20")}
              data-testid="composer-input"
            />

            <Popover
              open={Boolean(suggest && suggestions.length > 0)}
              onOpenChange={(open) => {
                if (!open) setSuggest(null);
              }}
            >
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-px w-full rounded-none border-0 p-0 opacity-0"
                  />
                }
              />
              <PopoverContent align="start" sideOffset={4} initialFocus={false} className="w-[min(24rem,90vw)] p-1">
                <div className="px-2 py-1 text-xs text-muted-foreground">提及账号（含离线）</div>
                <div className="flex max-h-56 flex-col overflow-y-auto">
                  {suggestions.map((account, index) => (
                    <Button
                      key={account.id}
                      type="button"
                      variant={index === suggestIndex ? "secondary" : "ghost"}
                      size="sm"
                      className="h-auto justify-start gap-2 px-2 py-1.5"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(account)}
                    >
                      <AuthorAvatar account={account} fallbackId={account.id} size="tiny" />
                      <span className="truncate">{account.display}</span>
                      <span className="truncate text-xs text-muted-foreground">@{account.id}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {account.id === "owner" || account.id === "manager" || account.id === "owner"
                          ? "常驻"
                          : "成员"}
                      </span>
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </TabsContent>

        <TabsContent value="preview">
          <div className="min-h-20 rounded-lg bg-muted/30 px-3 py-2" data-testid="composer-preview">
            {body.trim() ? <Markdown source={body} /> : <span className="text-sm text-muted-foreground">（空）</span>}
          </div>
        </TabsContent>
      </Tabs>

      {quotedPost ? (
        <Card className="relative gap-1 p-3" data-testid="composer-quote">
          <div className="flex items-start justify-between gap-2">
            <AuthorLine
              account={quotedPost.author_account}
              fallbackId={quotedPost.author}
              time={new Date(quotedPost.created_at).toLocaleString("zh-CN")}
            />
            {onRemoveQuote ? (
              <Button type="button" variant="ghost" size="icon-xs" onClick={onRemoveQuote} aria-label="移除引用">
                <XIcon />
              </Button>
            ) : null}
          </div>
          <div className="line-clamp-3 text-sm text-muted-foreground">
            <Markdown source={quotedPost.body_md} className="[&_p]:my-0" />
          </div>
        </Card>
      ) : null}

      <TagPicker value={tags} onChange={setTags} disabled={busy} />

      {items.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {items.map((item) => (
            <div key={item.id} className="relative overflow-hidden rounded-xl border border-border bg-muted/40">
              {item.previewUrl ? (
                <img src={item.previewUrl} alt={item.name} className="h-28 w-full object-cover" />
              ) : (
                <div className="flex h-28 items-center justify-center px-2 text-center text-xs text-muted-foreground">
                  {item.name}
                </div>
              )}
              <div className="flex items-center justify-between gap-1 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="truncate">{item.name}</span>
                {item.uploading ? <Loader2Icon className="size-3 animate-spin" /> : null}
                {item.error ? <span className="text-destructive">{item.error}</span> : null}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="absolute right-1 top-1"
                onClick={() => removeItem(item.id)}
                aria-label={`移除 ${item.name}`}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="composer-file"
          onChange={(event) => {
            const files = event.target.files ? [...event.target.files] : [];
            event.target.value = "";
            void addFiles(files);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={items.length >= MAX_FILES}
        >
          <ImagePlusIcon data-icon="inline-start" />
          附件 {items.length > 0 ? `${items.length}/4` : ""}
        </Button>
        <Badge variant="outline" className="hidden sm:inline-flex">
          可拖拽文件到这里
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="composer-submit"
            disabled={busy || uploadsPending || !body.trim()}
            onClick={() => void submit()}
          >
            {busy ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <SendIcon data-icon="inline-start" />}
            {submitLabel ?? (mode === "post" ? "发布" : "回复")}
          </Button>
        </div>
      </div>
    </div>
  );
}
