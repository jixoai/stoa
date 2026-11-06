/** 展示层格式化（时间/缩写）；不放业务判断。 */

export function fullTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

export function timeShort(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
  });
}

export function dateTimeShort(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return Array.from(trimmed).slice(0, 2).join("").toUpperCase();
}

export function displayCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "owner";
    case "manager":
      return "manager";
    default:
      return "agent";
  }
}

export function safeText(value: string | null | undefined): string {
  return value ?? "";
}
