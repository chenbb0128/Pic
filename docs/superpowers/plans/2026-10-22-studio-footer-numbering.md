# 自动排版底部编号实施计划

**目标与已确认方案：** 沿用爱心星星的底部编号流程。每个画板独立启用、填写和复制编号；默认启用，底部另加 3mm，不改内容尺寸或排版。预览、总览和 PNG 一致；正式导出校验空编号，实际发起下载后清空对应编号，生成图片或下载水印图不清空。开发阶段先保留本地，后续用户已明确授权提交并 push。

**技术方案：** Vue 3 + Canvas。保留 `paper` 作为排版尺寸，另算输出纸张；编号字段随画板快照保存。共用绘制函数负责底部文字，所有导出路径共用编号校验。

## 实施步骤（当前会话内执行）

- [x] 在 `web/src/pages/StudioWorkspacePage.test.ts` 补尺寸、快照、预览与下载流程测试；旧测试 fixture 显式关闭编号，运行新测试确认缺失功能导致失败。
- [x] 在 `web/src/services/studioNumbering.ts` 实现 3mm 输出尺寸及底部文字绘制，复用星星字体、内边距和长文本缩放规则；补直接单测。
- [x] 修改 `web/src/pages/StudioWorkspacePage.vue` 的画板快照、输出尺寸、预览坐标与编号 UI；新建剩余画板的编号留空，编辑编号不触发重排。
- [x] 接入单张及全部画板导出校验；仅实际下载成功后清空对应编号，保留已生成文件可重复下载；下载失败不清空。
- [x] 运行本次编号及现有预览、批量导出、总览的相关测试子集，检查 diff；不跑全量回归、不新增依赖、不 push。

**验证记录：** 20 项相关测试通过；编号绘制服务的定向 TypeScript 检查通过；Vite 页面模块 HTTP 200；只读代码审查未发现实际缺陷。未执行全量回归或生产构建。用户授权 push 后，再次运行相同的 20 项相关测试，全部通过。

**验证命令：** 在 `web` 执行 `node_modules/.bin/vitest.cmd run src/services/studioNumbering.test.ts --configLoader native`，以及 `node_modules/.bin/vitest.cmd run src/pages/StudioWorkspacePage.test.ts -t "底部编号|exports all populated|validates saved|draws each thumbnail|preview tools" --configLoader native`。
