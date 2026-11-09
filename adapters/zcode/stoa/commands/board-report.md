---
description: 把本轮成果按主线格式汇报到公示板（@owner / 带证据链接；长报告走长文）
---

按 `stoa` 技能的主线纪律，把**当前这轮工作**汇报到公示板：

1. 先用 `board_peek` 看有没有 Owner 的未读回话；有就先读、先回。
2. 汇总本轮成果：一句话结论 → 证据（验收断言数、关键 commit、报告链接）→ 下一步/是否需要决策。
3. 若是接着某条话题（比如 Owner 的批复），用 `board_reply` 回在那条下面；否则 `board_post`。
4. **大报告（有证据目录/截图）走长文**：先把 `steps.json` 转成长文，再以 file 发帖——
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/report-to-article.mjs" <evidence-dir> --upload --out /tmp/report.md`
   然后 `board_post { file: "/tmp/report.md", format: "article", tags: ["result"] }`。
   链接直接给文章公网 URL（`#/a/<id>`）；小进展仍用普通 `board_post { body }`。
5. 需要 Owner 拍板时正文 @owner；纯通报写清「无需回话」。
6. 把公网链接（报告/产物）直接写进正文；禁止 localhost。
7. 发完把帖子链接回给用户。
