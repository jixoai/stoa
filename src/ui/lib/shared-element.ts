/**
 * 共享元素「意图命名」：点击谁，谁就是主体。
 *
 * 为什么不在渲染期给列表卡片预置 `view-transition-name`：
 * - 同一帖可能在同一屏出现多次（例如两条通知指向同一帖）。名字重复会让浏览器放弃整次
 *   转场；只给第一条登记又会出现「点第二条、动画从第一条飞过去」。
 * - 正确语义是「被点击的那个主体元素参与形变」：点击处理器里把名字打到该卡片的头像/
 *   作者行上，转场快照读到的就是它；其余同名的旧名字在打标前清掉。
 *
 * 目标页（焦点帖/成员页头）继续用静态 `sharedId`，名字与这里一致（按帖子/账号 id）。
 */

const AVATAR_ATTR = "data-shared-avatar";
const AUTHOR_ATTR = "data-shared-author";
const HOST_ATTR = "data-shared-host";
const MARK_ATTR = "data-vt-intent";
const CLEAR_MS = 1200;

let clearTimer: number | null = null;

export function clearSharedSubject(): void {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }
  for (const el of document.querySelectorAll<HTMLElement>(`[${MARK_ATTR}]`)) {
    el.style.removeProperty("view-transition-name");
    delete el.dataset.vtIntent;
  }
}

/**
 * 把共享名打到 `host` 内的主体元素上（头像 + 作者行），命名与目标页一致：
 * `vt-avatar-<subject>` / `vt-author-<subject>`。
 */
export function markSharedSubject(host: Element | null, subject: string | null | undefined): void {
  clearSharedSubject();
  if (!host || !subject) return;
  // 只认「最近宿主」：列表卡片里可能嵌套另一张卡片（通知行嵌帖子预览），
  // 若两层都登记同一个名字，浏览器会以重复名整次放弃转场。
  const scoped = (attr: string) =>
    [...host.querySelectorAll<HTMLElement>(`[${attr}]`)].find(
      (el) => el.closest(`[${HOST_ATTR}]`) === host,
    ) ?? null;
  const avatar = scoped(AVATAR_ATTR);
  const author = scoped(AUTHOR_ATTR);
  if (avatar) {
    avatar.style.setProperty("view-transition-name", `vt-avatar-${subject}`);
    avatar.dataset.vtIntent = "avatar";
  }
  if (author) {
    author.style.setProperty("view-transition-name", `vt-author-${subject}`);
    author.dataset.vtIntent = "author";
  }
  // 旧快照在转场开始时已拍下；动画结束后清掉，避免残留名字参与下一次转场。
  clearTimer = window.setTimeout(clearSharedSubject, CLEAR_MS);
}
