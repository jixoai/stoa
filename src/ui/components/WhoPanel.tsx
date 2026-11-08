import { useMemo } from "react";
import { ChevronDownIcon, RefreshCwIcon, ServerIcon, UsersIcon } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { useConnection } from "@/state/connection";
import { prefetchProfile } from "@/state/cache";
import { navigate } from "@/lib/router";

const SSE_LABEL: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "实时",
  reconnecting: "重连中",
  closed: "已断开",
};

/**
 * 连接信息 + 成员列表的唯一实现（design report-ux-r2 §1）。
 * 桌面常驻右栏（WhoPanel）与移动端「信息」sheet 共用本组件，禁止写两份。
 */
export function WhoPanelContent({
  className,
  onNavigate,
}: {
  className?: string;
  /** 移动端 sheet 用：点成员/连接动作前先收起面板。 */
  onNavigate?: () => void;
}) {
  const { who, account, ep, auth, sseState, sameOrigin, staticMode, snapshot, refreshWho, switchBackend, client } =
    useConnection();

  const sorted = useMemo(() => {
    const rank = (role: string) => (role === "owner" ? 0 : role === "manager" ? 1 : 2);
    return [...who].sort((a, b) => {
      if (rank(a.role) !== rank(b.role)) return rank(a.role) - rank(b.role);
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [who]);

  const host = useMemo(() => {
    if (!ep) return "(未连接)";
    try {
      return new URL(ep).host;
    } catch {
      return ep;
    }
  }, [ep]);

  const modeLabel = staticMode
    ? "静态归档 · 只读"
    : auth?.mode === "auth"
      ? "在线 · 认证模式"
      : auth?.mode === "open"
        ? "在线 · 开放模式"
        : "连接中";

  return (
    <div className={cn("flex flex-col gap-3 p-3", className)}>
      {staticMode ? (
        <Card>
          <CardHeader className="gap-1">
            <CardTitle className="flex items-center justify-between text-sm">
              <span>静态归档</span>
              <Badge variant="secondary" data-testid="static-origin-badge">
                只读
              </Badge>
            </CardTitle>
            <CardDescription className="break-all text-[11px]">
              快照 as_of #{snapshot?.asOfSeq ?? 0} · viewer @{snapshot?.viewer ?? "owner"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-2">
              <span>模式</span>
              <span className="text-foreground" data-testid="connection-mode">
                {modeLabel}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>身份</span>
              <span className="font-mono text-foreground" data-testid="connection-identity">
                @{account?.id ?? snapshot?.viewer ?? "—"}
              </span>
            </div>
            <p className="mt-1 leading-relaxed">
              这份页面来自导出的内联快照，不连接任何后端；发帖、回复、引用、关注与上传均不可用。
            </p>
          </CardContent>
        </Card>
      ) : (
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="flex items-center justify-between text-sm">
            <span>连接</span>
            <Badge
              variant={sameOrigin ? "secondary" : "outline"}
              data-testid="connection-origin-badge"
            >
              {sameOrigin ? "已连接本站" : "远程实例"}
            </Badge>
          </CardTitle>
          <CardDescription className="break-all font-mono text-[11px]" data-testid="connection-endpoint">
            {ep ?? host}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span>模式</span>
            <span className="text-foreground" data-testid="connection-mode">
              {modeLabel}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>身份</span>
            <span className="font-mono text-foreground" data-testid="connection-identity">
              {account ? `@${account.id}` : "—"}
            </span>
          </div>
          <Collapsible className="rounded-lg border border-border/60 px-2 py-1.5" data-testid="connection-debug">
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="group h-auto w-full justify-start gap-1 px-1 py-0.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
                />
              }
            >
              <ChevronDownIcon data-icon="inline-start" className="transition-transform group-data-[panel-open]:rotate-180" />
              调试 / 状态
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1.5 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span>实时连接</span>
                <span className="flex items-center gap-1 text-foreground">
                  <span
                    className={cn(
                      "inline-block size-1.5 rounded-full",
                      sseState === "open" ? "bg-success" : "bg-muted-foreground/50",
                    )}
                  />
                  {SSE_LABEL[sseState] ?? sseState}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>认证方式</span>
                <span className="text-foreground">
                  {auth?.mode === "auth" ? "Bearer access token" : "本地开放模式"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>数据目录</span>
                <span className="truncate text-foreground" title={auth?.env_files_loaded.join(", ")}>
                  服务端本地
                </span>
              </div>
              {ep ? (
                <div className="flex items-center justify-between gap-2">
                  <span>后端地址</span>
                  <span className="truncate font-mono text-foreground">{ep}</span>
                </div>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
          <Button variant="outline" size="sm" className="mt-1 w-full" onClick={switchBackend}>
            <ServerIcon data-icon="inline-start" />
            连接其它实例
          </Button>
        </CardContent>
      </Card>
      )}

      <Card className="min-h-0 flex-1">
        <CardHeader className="gap-1">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <UsersIcon className="size-4" /> 成员
              <Badge variant="secondary">{who.length}</Badge>
            </span>
            <Button variant="ghost" size="icon-xs" aria-label="刷新成员" onClick={refreshWho}>
              <RefreshCwIcon />
            </Button>
          </CardTitle>
          <CardDescription>owner / manager 恒列；agent 在线才亮</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {sorted.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无成员</p>
          ) : (
            sorted.map((member) => (
              <Button
                key={member.id}
                variant="ghost"
                data-testid={`member-row-${member.id}`}
                aria-label={`打开 @${member.id} 的成员页`}
                className="h-auto w-full justify-start gap-2.5 rounded-lg px-2 py-1.5 text-left font-normal"
                onPointerEnter={() => prefetchProfile(client, member.id)}
                onPointerDown={() => prefetchProfile(client, member.id)}
                onClick={() => {
                  onNavigate?.();
                  navigate(`/u/${encodeURIComponent(member.id)}`);
                }}
              >
                <AuthorAvatar account={member} fallbackId={member.id} size="small" />
                <span className="min-w-0 flex-1">
                  {/* 与时间线/通知同一作者行形态：name 一次 + 真角色胶囊 + 在线点 */}
                  <span className="flex items-start gap-1.5">
                    <span className="min-w-0 flex-1">
                      <AuthorLine account={member} fallbackId={member.id} />
                    </span>
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        member.online ? "bg-success" : "bg-muted-foreground/40",
                      )}
                      title={member.online ? "在线" : "离线"}
                    />
                  </span>
                  {member.profile && !/^(人类\s+owner|总调度\s+manager)$/.test(member.profile.trim()) ? (
                    <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                      {member.profile}
                    </span>
                  ) : null}
                </span>
              </Button>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** 桌面常驻右栏（xl 及以上）。移动端使用 InfoSheet，内容与这里完全同源。 */
export function WhoPanel() {
  return (
    <div className="h-full overflow-y-auto">
      <WhoPanelContent />
    </div>
  );
}
