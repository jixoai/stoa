import { useState, type FormEvent } from "react";
import { KeyRoundIcon, Loader2Icon, ServerIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConnection } from "@/state/connection";

/**
 * 认证模式首访登录门：输入 FDE2E_REPORT_AUTH 换 access token。
 * 只把 token 存 localStorage；退出登录清 token 并停在落地页。
 */
export function LoginGate() {
  const { ep, login, loginError, switchBackend } = useConnection();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret) return;
    setBusy(true);
    try {
      await login(secret);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center p-4">
      <div className="pointer-events-none absolute left-6 top-6 flex items-center gap-2 opacity-60">
        <span className="glass-primary flex size-8 items-center justify-center rounded-xl text-sm font-semibold text-primary-foreground">
          R
        </span>
        <span className="text-sm font-semibold">report</span>
      </div>
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4" /> 登录 report
            </DialogTitle>
            <DialogDescription className="flex items-center gap-1 break-all">
              <ServerIcon className="size-3 shrink-0" />
              {ep ?? "(未选择后端)"}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">FDE2E_REPORT_AUTH</span>
              <InputGroup>
                <InputGroupInput
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder="输入实例密码"
                  autoFocus
                  data-testid="login-secret"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="submit"
                    variant="default"
                    size="xs"
                    disabled={busy || !secret}
                    data-testid="login-submit"
                  >
                    {busy ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : null}
                    登录
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </label>
            {loginError ? (
              <Alert variant="destructive">
                <AlertDescription>{loginError}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={switchBackend}>
              切换后端
            </Button>
          </form>

          <p className="text-xs text-muted-foreground">
            密码不会存盘；服务端只下发 access token（默认 7 天）。改 FDE2E_REPORT_AUTH 会立刻让所有 token 失效。
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
