import { useMemo } from "react";
import { RefreshCwIcon, UsersIcon } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { useConnection } from "@/state/connection";
import { roleLabel } from "@/lib/format";

const SSE_LABEL: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "实时",
  reconnecting: "重连中",
  closed: "已断开",
};

export function WhoPanel() {
  const { who, account, ep, auth, sseState, refreshWho } = useConnection();

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

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="flex items-center justify-between text-sm">
            <span>连接</span>
            <Badge variant={sseState === "open" ? "secondary" : "outline"}>
              <span
                className={cn(
                  "mr-1 inline-block size-1.5 rounded-full",
                  sseState === "open" ? "bg-success" : "bg-muted-foreground/50",
                )}
              />
              SSE {SSE_LABEL[sseState] ?? sseState}
            </Badge>
          </CardTitle>
          <CardDescription className="break-all font-mono text-[11px]">{host}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span>身份</span>
            <span className="font-mono text-foreground">{account ? `@${account.id}` : "—"}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>认证</span>
            <span className="text-foreground">
              {auth?.mode === "auth" ? "Bearer / access token" : "OPEN MODE（声明式身份）"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>数据目录</span>
            <span className="truncate text-foreground" title={auth?.env_files_loaded.join(", ")}>
              服务端本地
            </span>
          </div>
        </CardContent>
      </Card>

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
              <div key={member.id} className="flex items-start gap-2.5">
                <AuthorAvatar account={member} fallbackId={member.id} size="small" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{member.display}</span>
                    <span className="truncate text-[11px] text-muted-foreground">@{member.id}</span>
                    <span
                      className={cn(
                        "ml-auto size-1.5 shrink-0 rounded-full",
                        member.online ? "bg-success" : "bg-muted-foreground/40",
                      )}
                      title={member.online ? "在线" : "离线"}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground">
                      {member.role === "owner" || member.role === "manager" ? "常驻" : roleLabel(member.role)}
                    </span>
                  </div>
                  {member.profile ? (
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{member.profile}</p>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
