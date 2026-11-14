# 基础架构验证记录

日期：2026-11-14（Asia/Shanghai）。

## 已完成

- 本机已有 Flutter 3.47.7 / Dart 3.13.5，SDK 在 PATH 外，使用其缓存工具执行；未安装 SDK。
- 依赖通过 `pub get --offline` 解析，沿用本机 `pub.flutter-io.cn` 缓存。生产仅依赖 Flutter SDK。
- `dart format lib test` 完成，最终检查无格式变化。
- `flutter analyze --no-pub`：No issues found。
- `flutter test --no-pub test/domain test/data test/application test/workbench_test.dart`：14 项全部通过。
- `flutter build windows --debug --no-pub`：成功，产物 `build/windows/x64/runner/Debug/pic_order_desktop.exe`。
- 只读审查发现的“首次保存失败会阻断订单列表”问题已复现并修复；新单改为暂存目录写完整后发布，复核关闭该问题。

## 测试覆盖

空订单号拒绝、订单号前导零、多模板独立关联、原图字节保留且不依赖源路径、同号订单复用、首次保存失败隔离、中断暂存目录隔离、损坏主记录恢复、双份损坏报错、非图片拒绝、目录越界拒绝、保存失败保留关联与重试、写入中阻止切单、无订单导入拒绝，以及真实工作台录单/导图/关联落盘流程。

## 尚未验证

- 没有在用户 EVA 客服会话中拖图；不能据此声明 EVA 已适配，也不能声明拖入文件一定是客户原图。
- Windows 原生接口已编译，尚未人工操作原生文件选择器、跨应用拖入及窗口置顶。
- 未生成 Release 安装包、签名或自动更新。
- 未运行现有 Web/Go 测试或改动其业务实现；新增 desktop/ 已从网页 Docker 构建上下文排除。

请先用测试订单完成一次 EVA 拖图与“下载原图”文件字节对比，再接入真实制作流程。

## EVA 首次拖图诊断增量

用户截图确认普通本地文件格式未被提供；此证据不足以区分虚拟文件、图片链接或位图。新增 IDataObject 格式枚举与本地 `diagnostics/last_drag.json` 记录，仅保存格式名称、编号、传输类型和 HRESULT，不读取图片、HTML 或 URL 内容。

- 本轮仅运行 `test/platform/windows_desktop_gateway_test.dart`：2 项通过。
- `flutter analyze --no-pub lib/platform lib/app test/platform`：No issues found。
- Windows Release 编译通过，已通过桌面入口启动该版本，等待用户再次拖图取得实际格式。
- 尚未根据真实格式适配 EVA；不把诊断构建声明为 EVA 拖图修复。

## EVA 虚拟文件接入增量

后续拖拽记录确认 `FileGroupDescriptorW + FileContents`（HGLOBAL）。已实现虚拟文件的 HGLOBAL/IStream 接收、按声明长度写入、文件名与截断校验、保存后确认清理接收缓存，并编译 Windows Debug 新版、正常关闭诊断版后打开新版。原生7项边界检查及本次直接相关3项通道/工作台检查通过；不扩大测试范围。

按用户最新要求，后续实际功能验收由用户手动完成，不再自动操作窗口或增加复杂测试。待确认：EVA真实图片拖入成功、模板对应关系重开恢复，以及与下载原图的文件一致性。现阶段不宣称已完成 EVA 真实原图验收。

## 直接拖图自动取原图

发现源图地址带 `imageView2/2/w/582/h/738/q/80` 参数。针对同一张图请求已观察到的同源未缩放地址，得到4,798,128字节，与 `image_1794594471200.png` 的SHA-256完全一致。通过产品采用的Dart下载器又做了一次功能性比对：`Downloaded bytes: 4798128; identical to EVA download: true`。

已接入拖入链接读取、已知源地址规范化、原图下载、失败拒绝降级、下载期间阻止切单和缓存确认清理。仅执行本次模块静态分析与Windows Release编译，无新增复杂测试或全量回归。当前用户运行的旧版不自动重启；新版位于 `build/windows/x64/runner/Release/pic_order_desktop.exe`。尚待用户重新拖一张图完成整条链路验收；旧缩略图未自动覆盖。
