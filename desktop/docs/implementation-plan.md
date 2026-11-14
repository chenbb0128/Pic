# 订单素材台基础架构实施计划

> **For agentic workers:** 按本清单在当前会话逐项执行；用户已要求在当前项目目录内创建子项目。不创建 worktree、不自动提交、不联网安装依赖。

**Goal:** 建立独立 Flutter Windows 客户端及订单、原图、多模板关联的可运行基础。

**Architecture:** 领域模型和仓库契约独立于 Flutter，ChangeNotifier 管理录单操作，本地 JSON 实现持久化。平台能力通过 Windows 通道注入。

**Tech Stack:** Flutter / Dart / Windows C++，仅 SDK 依赖。

**Spec:** `desktop/docs/design.md`

## Global Constraints

- Windows EXE；所有新增代码位于 desktop/，不修改现有业务。
- 不新增第三方生产依赖，不联网安装。
- 原文件逐字节保留，接收到文件不表示已经确认是 EVA 原图。
- 测试限定桌面子项目，不运行既有 Web/Go 全量检查。

## Tasks

- [x] 1. 用本机 SDK 创建 Windows 宿主与 Flutter 包，移除示例计数器及非必要默认依赖；写入项目启动说明。
- [x] 2. 先写订单关联和文件仓库行为测试，再实现 domain/ 与 data/：多模板关联、源文件独立、字节保留、JSON 重开与损坏报告。
- [x] 3. 实现 application/ 控制器，覆盖异步保存失败保留状态；使用串行忙碌状态避免切单及写入竞态。
- [x] 4. 实现 app/ 依赖装配、订单工作台与模板选择；Windows 平台通道支持文件选择、置顶及普通文件拖入。
- [x] 5. 格式化、静态分析、14 项直接相关测试及 Windows Debug 编译；记录 EVA 原图与虚拟文件尚未人工验证的边界。

## 验证命令

在 desktop/ 执行：

```powershell
flutter pub get --offline
dart format --output=none --set-exit-if-changed lib test
flutter analyze --no-pub
flutter test --no-pub test/domain test/data test/application test/workbench_test.dart
flutter build windows --debug --no-pub
```

若离线缓存或 Windows 工具链缺失，保留源码并明确报告；联网安装前取得用户确认。
