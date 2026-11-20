# 订单素材台设计

## 目标与范围

独立 Flutter Windows 客户端，负责客户订单号、原始图片和制作模板的人工关联。一个订单有多张图片，每张图片可以关联多个模板；一张图片与一个模板构成一份制作任务。当前仅建立录单基础，不接入现有 Vue/Go 服务、不负责排版或生成打印图。

## 操作与数据

新建或打开订单 → 导入图片 → 选中图片 → 勾选多个模板 → 自动保存。模板目录初始提供 A08 糖果版和 A03 爱心星星混合版，保留模板管理入口。新图片初始无关联，不继承上一张图的选择。订单号按字符串保存，允许前导零；以内部 ID 作为目录名，订单号不参与路径拼接。

原始文件逐字节复制到应用数据目录，界面直接读取本地副本，不改变文件格式或压缩重编码。源路径可以删除，重启后仍应可用。接收到文件不代表已经确认是 EVA 原图，图片记录单独保存来源和原图核验状态；核验前界面明确显示未核验。模板关联引用图片 ID，不复制图片文件。

## 模块与依赖方向

```text
app/                          启动、主题和依赖装配
features/orders/domain/       订单、图片、模板关联与仓库契约（纯 Dart）
features/orders/application/  录单控制器、串行操作、保存/失败状态
features/orders/data/         JSON 快照与原始文件复制
features/orders/presentation/ 订单工作台和可复用视图
features/templates/           模板模型与目录
platform/                     Windows 通道、文件选择、拖入事件、置顶
windows/runner/               Flutter 标准宿主和 Windows API 适配
```

依赖从界面指向应用服务和领域契约，数据实现由启动层注入。领域模型不依赖 Flutter、文件系统或平台插件。采用 Flutter SDK 自带 ChangeNotifier 和构造注入，不新增第三方生产包。MVP 使用本地 JSON，仓库契约允许未来替换为 SQLite。

## 本地存储与错误

默认目录为 `%LOCALAPPDATA%/Xiaoxingtie/OrderMaterials`，测试通过临时目录注入。每单独立目录，内有 `order.json` 和 `originals/`；记录格式带 schemaVersion。新单先写入 `pending/` 下的唯一临时目录，完整快照落盘后再移动到 `orders/`，首次写入中断不会阻断已有订单。已有订单保存写临时文件，Windows 通过可恢复备份替换快照，读取时可回退上一份完整快照。损坏数据报错，不当作空列表覆盖。先复制原图再提交元数据，写入失败最多留下未引用副本，不删除已接收原图。导入、模板变更和切单操作串行处理，保存成功后再更新已保存状态。

## Windows 与 EVA 边界

使用自有 MethodChannel 封装选择本地图片、窗口置顶、普通文件拖入及 EVA 的 FileGroupDescriptorW/FileContents 虚拟文件，平台适配与订单领域隔离。虚拟内容支持 HGLOBAL/IStream，按描述长度保留字节，先写入本机 incoming/；订单持久化成功后再确认清理，仅删除本次桥接层实际创建的接收缓存。失败或退出前未完成导入时保留完整接收文件。校验文件名与描述长度，拒绝越界文件名和截断内容；单次最多128个、单个最大512 MB。不会自动访问图片链接或把位图截图当作原图。文件拖入成功不等于 EVA 原图验证通过，需与下载原图实际比较。

## 验证

### EVA 原图获取增量

已确认聊天图片地址使用 qimg.xiaohongshu.com/arkgoods/<图片ID>，带 imageView2/ 缩放处理。平台通道将本次拖入的文件路径与URL放在同一消息内，WindowsDesktopGateway负责读取并调用EvaOriginalImageLoader；后者仅允许已验证图片域名和路径，校验文件名ID一致，移除明确缩图参数、保留其他参数并下载完整文件。OrderController.importPreparedPaths 在下载和保存期间统一保持忙碌，避免切单竞态。获取失败不降级导入识别出的EVA缩略图。适配不读取EVA缓存或登录态；缓存读取仅用于本轮人工定位已知图片的URL，未成为产品依赖。

已验证一张同图未缩放文件与EVA下载的4,798,128字节原图SHA-256及完整字节一致。这个结果只证明当前图片源和样本，不代表所有未知图片源都已适配。

只运行桌面子项目的直接相关测试与静态分析：图片可多模板关联、空订单号拒绝、序列化重开、原文件字节不变且脱离源路径可用、损坏数据不静默丢弃、控制器保存失败保留状态。Windows 宿主构建验证通道可编译；EVA 拖图另做人工验收，不以单元测试代替。

## 排单接入（千帆客服侧，CDP 直连）

千帆客服右键图片点击「进入排单」后，订单素材台**自身**完成捕获与入库（无外部注入器进程）：

- 前置条件：千帆客服工作台以 `--remote-debugging-port=9222` 启动（桌面快捷方式「排单小助手 / 千帆客服工作台(排单版)」负责）。
- `PaidanCdpInjector` 周期扫描 `http://127.0.0.1:9222/json/list`，对每个客服工作台页面建立 CDP WebSocket 连接，注入内置资产 `assets/paidan_core.js`：右键图片 → 融合进平台菜单的「进入排单」项 → 页面内抓取原图（对 arkgoods 链接去掉 imageView2/ 缩图参数，与 EVA 拖入同款规则）→ 经 `qianfanBridge` binding 回流。
- 捕获按订单号找单或建单（同号复用）入库，来源标记为 `ImageSource.paidan`；临时文件先写 `incoming/`，成功后删除，失败保留供人工处理。控制器忙时捕获在内存中排队重试（约 10 次 × 2s），持续忙碌则保留文件。
- 与用户操作串行：`OrderController.ingestPaidan` 与拖入导入共用忙碌保护，不与切单、导入竞争写入。捕获 payload 无订单号时跳过入库（右侧订单面板未显示订单）。
- 测试经内嵌 fake CDP 服务端（`HttpServer` + `WebSocketTransformer`）覆盖协议客户端：脚本注入、binding 回流入库、无订单号跳过。

### 兼容：收件箱投递通道（保留）

早期通过外部 Node 注入器把捕获写入收件箱 `%LOCALAPPDATA%/Xiaoxingtie/OrderMaterials/inbox/`（`<投递ID>.paidan.json` + 图片成对，原子重命名）。`PaidanIngestService` 保留消费该通道：校验元数据、文件名白名单、字节长度一致后入库（同号复用，`ImageSource.paidan`）；失败投递移入 `inbox/failed/` 附错误说明；控制器忙时投递保持原样由定时扫描重试。CDP 直连为主路径后，此通道仅作为兼容备用，二者事件统一对外，不产生重复入库。入库图片 `originalVerified=false`，与拖入流程一致；字节校验只覆盖长度一致，哈希校验留待后续版本。
