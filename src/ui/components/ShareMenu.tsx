/**
 * 分享面板（report-share-actions）：复制链接 / 系统原生分享 / 常见社交直达。
 *
 * 组件只用官方 shadcn Popover + Button；社交图标统一 lucide 单色、主题令牌。
 * 分享 URL 一律使用帖子 canonical `postLink(id)`；静态归档同样可分享。
 */
import { useMemo, useState } from "react";
import type { PostKind } from "@core/types";
import {
  AtSignIcon,
  CheckIcon,
  GlobeIcon,
  LinkIcon,
  MailIcon,
  MessageCircleIcon,
  SendIcon,
  Share2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { copyText, postLink } from "@/lib/copy";
import { articleSummary } from "@core/article";
import { toast } from "@/components/ui/toast";

export interface ShareMenuPost {
  id: string;
  body_md: string;
  /** 载体（report-longform）：article 的 canonical 链接是 `#/a/<id>`。 */
  kind?: PostKind;
}

interface ShareMenuProps {
  post: ShareMenuPost;
  /** 复制成功后的外部回调（可选；面板自身也保留已复制态）。 */
  onCopy?: () => void;
}

export function ShareMenu({ post, onCopy }: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = postLink(post.id, post.kind ?? "note");
  const title = useMemo(() => {
    if (post.kind === "article") return articleSummary(post.body_md).title || "长文";
    return post.body_md.replace(/\s+/g, " ").trim().slice(0, 80) || "report 帖子";
  }, [post.kind, post.body_md]);
  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  const share = async () => {
    try {
      await navigator.share({ title, url });
    } catch {
      // 用户取消 / 平台拒绝：保持静默
    }
  };

  const social = useMemo(() => {
    const encodedUrl = encodeURIComponent(url);
    const encodedTitle = encodeURIComponent(title);
    return [
      {
        id: "weibo",
        label: "微博",
        icon: GlobeIcon,
        href: `https://service.weibo.com/share/share.php?url=${encodedUrl}&title=${encodedTitle}`,
      },
      {
        id: "qq",
        label: "QQ",
        icon: MessageCircleIcon,
        href: `https://connect.qq.com/widget/shareqq/index.html?url=${encodedUrl}&title=${encodedTitle}`,
      },
      {
        id: "x",
        label: "X",
        icon: AtSignIcon,
        href: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`,
      },
      {
        id: "telegram",
        label: "Telegram",
        icon: SendIcon,
        href: `https://t.me/share/url?url=${encodedUrl}&text=${encodedTitle}`,
      },
      {
        id: "mail",
        label: "邮件",
        icon: MailIcon,
        href: `mailto:?subject=${encodedTitle}&body=${encodedUrl}`,
      },
    ] as const;
  }, [title, url]);

  const copy = async () => {
    const ok = await copyText(url);
    if (!ok) {
      toast.add({ type: "error", title: "复制失败", description: "请长按/右键手动复制链接", timeout: 2400 });
      return;
    }
    setCopied(true);
    onCopy?.();
    toast.add({ type: "success", title: "链接已复制", timeout: 1600 });
    window.setTimeout(() => setCopied(false), 1500);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 min-w-11 px-2"
            data-testid="action-share"
            aria-label="分享"
            title="分享"
          />
        }
      >
        <Share2Icon className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[260px] p-2" data-testid="share-panel">
        <PopoverTitle className="sr-only">分享帖子</PopoverTitle>
        <div className="grid grid-cols-4 gap-1">
          <Button
            type="button"
            variant="ghost"
            className="h-auto flex-col gap-1 rounded-lg px-1 py-2 text-[11px] font-normal"
            data-testid="share-copy"
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon className="size-4" /> : <LinkIcon className="size-4" />}
            复制链接
          </Button>
          {canNativeShare ? (
            <>
              <Button
                type="button"
                variant="ghost"
                className="h-auto flex-col gap-1 rounded-lg px-1 py-2 text-[11px] font-normal"
                data-testid="share-native"
                onClick={() => {
                  setOpen(false);
                  void share();
                }}
              >
                <Share2Icon className="size-4" />
                系统分享
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-auto flex-col gap-1 rounded-lg px-1 py-2 text-[11px] font-normal"
                data-testid="share-wechat"
                onClick={() => {
                  setOpen(false);
                  void share();
                }}
              >
                <MessageCircleIcon className="size-4" />
                微信
              </Button>
            </>
          ) : null}
          {social.map((item) => {
            const Icon = item.icon;
            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                className="h-auto flex-col gap-1 rounded-lg px-1 py-2 text-[11px] font-normal"
                data-testid={`share-${item.id}`}
                onClick={() => {
                  setOpen(false);
                  window.open(item.href, "_blank", "noopener,noreferrer");
                }}
              >
                <Icon className="size-4" />
                {item.label}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
