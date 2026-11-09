/**
 * 指令块渲染件（report-longform §4.4 P1 四块：stats / steps / compare / callout）。
 *
 * 纪律：
 * - 视觉件全部来自官方 shadcn 收编件（`src/ui/components/ui/*`：Card / Badge /
 *   Alert / Tabs / Button / Skeleton）＋ lucide 单色图标；组合层只做布局与数据接线；
 * - 色彩只用主题令牌（`text-success` / `text-destructive` / `text-status-interrupted`
 *   等语义色），无硬编码 hex、无自定义底色；
 * - 每个块根节点带 `data-article-block="<name>"`（QA/审计定位用）；
 * - 数据已由 `parseArticle` 校验/截断（超限记 warning），渲染件只做展示，不再解析。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CalloutData,
  CompareData,
  MediaSide,
  StatsData,
  StatsItem,
  StepItem,
  StepStatus,
  StepsData,
} from "@core/article";
import { cn } from "cn";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ImageOffIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnection } from "@/state/connection";
import { useMediaUrl, mediaKind } from "@/lib/media";
import { useArticleMediaRefs, useArticleViewer } from "@/lib/article-media";

// ── 共享小件 ────────────────────────────────────────────────────────────────

/** `(min-width: Npx)` 的订阅（compare 断点 860px；SSR 首帧按窄屏渲染）。 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener?.("change", update);
    return () => mql.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

/**
 * 块内媒体（`/api/media/<hash>`）：显示走 `useMediaUrl`（认证 blob / 静态相对
 * 路径），点击打开既有 `ImageViewer`（手势/关闭全复用）。加载失败给占位，不报错。
 */
function BlockMedia({
  url,
  alt,
  className,
  imageClassName,
}: {
  url: string;
  alt?: string;
  className?: string;
  imageClassName?: string;
}) {
  const { client } = useConnection();
  const resolveRef = useArticleMediaRefs();
  const viewer = useArticleViewer();
  const ref = resolveRef(url);
  const state = useMediaUrl(client, ref?.hash || null);
  if (!ref) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
        <ImageOffIcon className="mr-2 size-4" /> 媒体引用无效
      </div>
    );
  }
  const kind = mediaKind(ref.ext);
  if (state.loading) return <Skeleton className={cn("h-40 w-full rounded-lg", className)} />;
  if (!state.url || state.error) {
    return (
      <div
        data-testid="block-media-unavailable"
        className="flex h-24 items-center justify-center gap-2 rounded-lg bg-muted text-xs text-muted-foreground"
      >
        <ImageOffIcon className="size-4" /> 媒体不可用
      </div>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="block-media"
      aria-label={alt ? `查看媒体：${alt}` : "查看媒体"}
      className={cn("block h-auto w-full cursor-zoom-in rounded-lg p-0 hover:bg-transparent", className)}
      onClick={(event) => {
        event.stopPropagation();
        viewer.open([ref]);
      }}
    >
      {kind === "video" ? (
        <video
          src={`${state.url}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          aria-label={alt ? `视频 ${alt}` : "视频"}
          className={cn("w-full rounded-lg bg-black object-cover", imageClassName)}
        />
      ) : (
        <img
          src={state.url}
          alt={alt ?? ""}
          loading="lazy"
          className={cn("w-full rounded-lg object-cover", imageClassName)}
        />
      )}
    </Button>
  );
}

// ── stats ───────────────────────────────────────────────────────────────────

const STATS_TONE_CLASS: Record<StatsItem["tone"], string> = {
  neutral: "text-foreground",
  success: "text-success",
  warn: "text-status-interrupted",
  danger: "text-destructive",
};

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDelta(delta: number): string {
  const rounded = Math.abs(delta) >= 10 ? Math.round(delta) : Math.round(delta * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function StatsItemCard({ item }: { item: StatsItem }) {
  const main =
    item.value ?? (item.before !== undefined && item.after !== undefined ? `${item.before} → ${item.after}` : "");
  const transform =
    item.value !== undefined && item.before !== undefined && item.after !== undefined
      ? `${item.before} → ${item.after}`
      : null;
  const before = parseNumber(item.before);
  const after = parseNumber(item.after);
  const delta =
    item.before !== undefined && item.after !== undefined && before !== null && after !== null && before !== 0
      ? ((after - before) / before) * 100
      : null;
  const improved =
    item.better !== null && delta !== null && delta !== 0
      ? item.better === "lower"
        ? delta < 0
        : delta > 0
      : null;
  return (
    <Card className="gap-1 py-2.5" data-testid="stats-item">
      <CardContent className="px-3">
        <div className="truncate text-[11px] text-muted-foreground" title={item.label}>
          {item.label}
        </div>
        <div
          className={cn("mt-0.5 text-lg leading-6 font-semibold tabular-nums", STATS_TONE_CLASS[item.tone])}
          data-testid="stats-value"
          data-tone={item.tone}
        >
          {main}
          {item.unit && main ? (
            <span className="ml-0.5 text-xs font-normal text-muted-foreground">{item.unit}</span>
          ) : null}
        </div>
        {transform || delta !== null ? (
          <div
            className={cn(
              "mt-0.5 text-xs text-muted-foreground",
              improved === true && "text-success",
              improved === false && "text-destructive",
            )}
            data-testid="stats-delta"
            data-direction={improved === null ? undefined : improved ? "better" : "worse"}
          >
            {transform ?? ""}
            {transform && item.unit ? ` ${item.unit}` : ""}
            {delta !== null ? `${transform ? " · " : ""}${formatDelta(delta)}` : ""}
          </div>
        ) : null}
        {item.hint ? (
          <div className="mt-0.5 text-xs text-muted-foreground" data-testid="stats-hint">
            {item.hint}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function StatsBlock({ data }: { data: StatsData }) {
  return (
    <div className="my-4" data-article-block="stats">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="stats-grid">
        {data.items.map((item, index) => (
          <StatsItemCard key={index} item={item} />
        ))}
      </div>
    </div>
  );
}

// ── steps ───────────────────────────────────────────────────────────────────

const STEP_STATUS_META: Record<StepStatus, { label: string; className: string }> = {
  done: { label: "完成", className: "border-success/40 bg-success/10 text-success" },
  failed: { label: "失败", className: "border-destructive/40 bg-destructive/10 text-destructive" },
  degraded: {
    label: "降级",
    className: "border-status-interrupted/40 bg-status-interrupted/10 text-status-interrupted",
  },
  skipped: { label: "跳过", className: "border-border bg-muted text-muted-foreground" },
  pending: { label: "待定", className: "border-border text-foreground" },
};

function StepRow({ step }: { step: StepItem }) {
  const meta = STEP_STATUS_META[step.status];
  return (
    <div
      className="flex gap-3 px-3 py-3"
      data-testid="step-row"
      data-status={step.status}
    >
      <Badge
        variant="outline"
        className={cn("mt-0.5 shrink-0", meta.className)}
        data-testid="step-status"
      >
        {meta.label}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-6 font-medium">{step.title}</p>
        {step.expect ? (
          <p className="mt-0.5 text-sm text-muted-foreground" data-testid="step-expect">
            {step.expect}
          </p>
        ) : null}
        {step.detail ? (
          <p className="mt-0.5 text-sm text-muted-foreground" data-testid="step-detail">
            {step.detail}
          </p>
        ) : null}
        {step.command ? (
          <pre
            className="mt-2 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
            data-testid="step-command"
          >
            <code>{step.command}</code>
          </pre>
        ) : null}
        {step.output ? (
          <pre
            className="mt-2 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
            data-testid="step-output"
          >
            <code>{step.output}</code>
          </pre>
        ) : null}
        {step.media ? (
          <div className="mt-2 max-w-xl">
            <BlockMedia url={step.media} alt={step.mediaAlt} imageClassName="max-h-80" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function StepsBlock({ data }: { data: StepsData }) {
  return (
    <Card className="my-4 gap-0 overflow-hidden py-0" data-article-block="steps">
      <CardContent className="divide-y divide-border/60 px-0" data-testid="steps-list">
        {data.steps.map((step, index) => (
          <StepRow key={index} step={step} />
        ))}
      </CardContent>
    </Card>
  );
}

// ── compare ─────────────────────────────────────────────────────────────────

function CompareSide({ side, fallbackLabel }: { side: MediaSide; fallbackLabel: string }) {
  return (
    <figure className="min-w-0 flex-1" data-testid="compare-side">
      <BlockMedia url={side.media} alt={side.label ?? side.caption ?? fallbackLabel} imageClassName="max-h-96" />
      <figcaption className="mt-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{side.label ?? fallbackLabel}</span>
        {side.viewport ? <span className="ml-1.5">{side.viewport}</span> : null}
        {side.caption ? <span className="mt-0.5 block">{side.caption}</span> : null}
      </figcaption>
    </figure>
  );
}

export function CompareBlock({ data }: { data: CompareData }) {
  const wide = useMediaQuery("(min-width: 860px)");
  const mismatch = Boolean(
    data.before.viewport && data.after.viewport && data.before.viewport !== data.after.viewport,
  );
  return (
    <div
      className="my-4"
      data-article-block="compare"
      data-viewport-mismatch={mismatch ? "1" : undefined}
      role="group"
      aria-label={data.title ?? "前后对比"}
    >
      {data.title ? <p className="mb-2 text-[15px] font-medium">{data.title}</p> : null}
      {wide ? (
        <div className="flex items-start gap-3" data-testid="compare-grid">
          <CompareSide side={data.before} fallbackLabel="Before" />
          <CompareSide side={data.after} fallbackLabel="After" />
        </div>
      ) : (
        // <860px：一次一张（Before/After 切换），不上下堆两张巨图（design §4.4）。
        <Tabs defaultValue="before" className="gap-2" data-testid="compare-switch">
          <TabsList aria-label="前后对比切换">
            <TabsTrigger value="before" data-testid="compare-tab-before">
              Before
            </TabsTrigger>
            <TabsTrigger value="after" data-testid="compare-tab-after">
              After
            </TabsTrigger>
          </TabsList>
          <TabsContent value="before">
            <CompareSide side={data.before} fallbackLabel="Before" />
          </TabsContent>
          <TabsContent value="after">
            <CompareSide side={data.after} fallbackLabel="After" />
          </TabsContent>
        </Tabs>
      )}
      {mismatch ? (
        <p className="mt-1.5 text-xs text-status-interrupted" data-testid="compare-viewport-warning">
          两侧视口不一致（{data.before.viewport} vs {data.after.viewport}）
        </p>
      ) : null}
      {data.note ? <p className="mt-1.5 text-sm text-muted-foreground">{data.note}</p> : null}
    </div>
  );
}

// ── callout ─────────────────────────────────────────────────────────────────

const CALLOUT_META: Record<CalloutData["tone"], { icon: ReactNode; className: string; label: string }> = {
  info: { icon: <InfoIcon />, className: "text-link", label: "提示" },
  warn: { icon: <TriangleAlertIcon />, className: "text-status-interrupted", label: "注意" },
  success: { icon: <CircleCheckIcon />, className: "text-success", label: "结论" },
  danger: { icon: <CircleAlertIcon />, className: "text-destructive", label: "风险" },
};

export function CalloutBlock({ data }: { data: CalloutData }) {
  const meta = CALLOUT_META[data.tone];
  return (
    <div className="my-4" data-article-block="callout" data-tone={data.tone}>
      <Alert className={meta.className} data-testid="callout">
        {meta.icon}
        <AlertTitle data-testid="callout-title">{data.title ?? meta.label}</AlertTitle>
        <AlertDescription className="text-foreground/90">
          {data.body ? (
            <p className="leading-6" data-testid="callout-body">
              {data.body}
            </p>
          ) : null}
          {data.items.length > 0 ? (
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5" data-testid="callout-items">
              {data.items.map((item, index) => (
                <li key={index} className="leading-6">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
          {data.code ? (
            <pre
              className="mt-2 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-foreground"
              data-testid="callout-code"
            >
              <code>{data.code}</code>
            </pre>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** 便捷分派：ArticleBody 用（保持一处 import）。 */
export const ARTICLE_BLOCK_RENDERERS = {
  stats: (data: StatsData) => <StatsBlock data={data} />,
  steps: (data: StepsData) => <StepsBlock data={data} />,
  compare: (data: CompareData) => <CompareBlock data={data} />,
  callout: (data: CalloutData) => <CalloutBlock data={data} />,
} as const;
