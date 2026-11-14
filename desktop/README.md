# 订单素材台（Flutter Windows）

独立 Windows 客户端，与同仓库的 `web/`、`server/` 分开运行。用于整理订单号、客户图片和制作模板的对应关系。

## 当前基础能力

- 创建或打开本地订单，订单号保留前导零；同号复用已有订单。
- 订单右侧可删除，需确认。删除将订单目录移至本机数据目录的 `trash/`，不删除原图；窄窗口可用订单选择框右侧的删除按钮。
- 选择图片文件或拖入普通本地文件，接收到的文件逐字节复制到本机资料库。
- 每张图片独立勾选多个模板，自动保存关联，重新打开继续操作。
- 本地图片列表、预览、待分配数量和制作任务数量。
- 右上角「保存设置」选择图片保存目录，新图片按北京时间的日期／订单自动归档，跨天无需重启。
- 选中图片后可「另存为」原图；按住预览图或左侧缩略图，可直接拖到浏览器文件上传区或资源管理器文件夹，导出磁盘原文件，仅复制，不移动资料库文件。
- Windows 原生多文件选择、普通文件拖入、窗口置顶、单实例保护。
- 保存失败显示错误；损坏快照可回退上一份完整记录，两份均损坏时明确报错。

桌面端使用 web 爱心星星工具的 16 个内置模板。清单由 `tool/sync_web_templates.dart` 从 web 模板下拉框生成，Windows 编译前自动同步；模板 ID 与 web 的模板值一致。旧订单的 A08、A03 在读取时分别对应「缤纷糖果」「爱心＋星星混合款」，保留原有关联。

勾选模板后点击「去制作」，选择模板即可通过系统浏览器打开 `https://pic.pdurl.cn/tools/heart-star?template=...`，再把图片拖进 web 上传区。链接只包含模板编号，不携带图片或订单信息。web 项目新增了模板参数接收逻辑，线上自动选中模板需要发布本次 web 更新；访问验证沿用原有逻辑。

自定义排版需要先在 web 编辑具体内容，不作为固定模板分配。当前不读取云端共享模板库，也不含桌面排版引擎、图片自动上传、云同步、批量制作或安装包。

**EVA 原图：**聊天拖入的 `FileContents` 是缩略图。现额外读取同一次拖入附带的图片链接；针对实测的 `https://qimg.xiaohongshu.com/arkgoods/<图片ID>`，校验链接ID与文件名一致，去掉 `imageView2/` 缩图参数并下载未缩放文件，保留其他参数。已用同一张实际图片验证：下载为4,798,128字节，与EVA「下载原图」文件逐字节一致。程序不使用EVA登录凭据，不下载任意网址或截图，不依赖扫描EVA缓存。

虚拟文件先写入 `incoming/`，原图获取和订单记录保存成功后再清理本次缓存。网络或原图请求失败时，不把识别出的EVA缩略图自动降级导入；缺少地址或尚未支持的EVA图片源会明确提示。下载期间阻止切单。现有小图记录不会自动替换，需要重新拖入；整条新拖拽流程仍需用户实际验收。普通本地文件仍逐字节导入。单次最多128个虚拟文件、单个最大512 MB；EVA原图按单张拖入处理。

拖图时会在资料库的 `diagnostics/last_drag.json` 覆盖记录最近一次的拖拽格式名称、格式编号、传输类型及查询结果，用于确定 EVA 适配方式。诊断不读取或保存图片字节、HTML 正文、图片链接或订单号。未支持的拖拽只提示未识别，不推断为虚拟文件。

## 环境与运行

- Flutter stable（随附 Dart >=3.11，当前验证 SDK 为 Flutter 3.47.7 / Dart 3.13.5）。
- Windows 10/11 与 Visual Studio 的 Desktop development with C++ 工具链。
- 仅 Flutter SDK 生产依赖；`flutter_test` 用于测试，不含第三方拖拽或状态管理生产包。

```powershell
cd desktop
flutter pub get --offline
flutter run -d windows --no-pub
```

本机已有缓存位于 `pub.flutter-io.cn`，锁文件沿用该镜像。如果需要使用这份离线缓存，在当前 PowerShell 中设置：

```powershell
$env:PUB_HOSTED_URL = 'https://pub.flutter-io.cn'
flutter pub get --offline
```

Flutter 需已加入 PATH。新机器若缓存不全，需自行确认安装环境与依赖后再执行联网解析；项目脚本不会自动安装 SDK。

## 架构

```text
lib/
  main.dart                         入口
  app/                              主题与依赖装配
  features/
    orders/
      domain/                       纯 Dart 模型与 OrderRepository 契约
      application/                  OrderController：串行操作和保存状态
      data/                         本地快照、恢复、原始文件复制
      presentation/                 录单工作台与视图组件
    templates/                      web 模板目录（编译时生成）与旧 ID 兼容
    settings/                       保存目录配置与设置界面
  platform/                         DesktopGateway 契约及 Windows 通道
windows/runner/desktop_bridge.*      原生文件选择、拖入和置顶
```

依赖方向为界面 → 应用层 → 领域契约；本地仓库实现与 Windows 适配在 app 层注入。更换 SQLite、接入现有模板服务或补 EVA 虚拟文件，只需要替换对应适配器，领域模型和关联逻辑保持独立。

领域关系：`订单 → 多张图片 → 每张图片关联多个模板 ID`。图片与一个模板构成一份制作任务；不按模板复制图片。模板名称和 ID 以 `web/public/embedded/heart-star/index.html` 中的模板选择项为准。不要手工编辑 `web_templates.g.dart`；开发时可先运行 `dart tool/sync_web_templates.dart` 后分析或测试，Windows 编译会自动运行。

详见 [设计说明](docs/design.md) 与 [实施清单](docs/implementation-plan.md)。

## 数据位置与保存边界

```text
%LOCALAPPDATA%/Xiaoxingtie/OrderMaterials/
  settings.json                     图片保存根目录设置（固定位置）
  pending/                          未完成的新单暂存，不进入正式订单列表
  trash/                            已删除的订单记录、备份与旧版原图
  orders/
    <内部随机 ID>/
      order.json                    schemaVersion=1 的订单记录
      order.json.bak                上一次完整快照（存在上一版时）
      originals/
        <图片 ID>.png               旧版图片，继续从这里读取

<配置的图片保存根目录>/              默认是上述数据目录下的 images/
  YYYY-MM-DD/                       每次导入时按北京时间确定日期
    <安全订单号>_<内部随机 ID>/
      <图片 ID>.png                 接收文件的原始字节副本
```

在右上角「保存设置」选择根目录并保存，立即用于后续新图片。一天内同一订单进入同一目录，跨天导入进入新日期目录。订单目录名将非法字符替换，并附加内部 ID；原文件名保存在记录里。每张新图片的实际绝对路径保存在订单记录里，修改目录不会移动旧图或影响历史订单；旧版记录没有绝对路径时继续读取原来的 `originals/`。后续制作使用记录中的文件，不能使用界面预览截图。预览可缩小解码，不改变磁盘文件。当前仅支持 PNG/JPEG/WebP/GIF/BMP 文件头，不执行转码。

备份时复制整个本机数据目录，以及所有使用过的图片根目录。订单索引和配置仍固定保存在本机，修改图片根目录不影响订单列表；不要手动移动或删除历史图片目录。新单在暂存目录完成首次快照后才移入正式订单目录。快照备份用于写入中断恢复，不代替完整备份或历史版本。导入后若保存失败，可能留下未引用的图片副本；当前不自动清理原图。资料库按单进程写入设计，Windows 宿主阻止同一用户重复启动。

此功能的最小验收：选择一个空目录并保存 → 导入图片，检查 `当天日期/订单号_编号/` 下的文件 → 重启确认设置与预览保留 → 改用另一个目录再导入，确认新图进入新位置、旧图仍可打开。跨天时按新导入当天建立目录，不移动昨天的图片。

导出图片的人工验收：选中一张图片 → 点击「另存为」保存到桌面，比较文件大小 → 按住预览图拖到支持文件拖入的浏览器上传区域，确认显示文件或预览 → 再拖到一个文件夹，确认获得副本、订单图片仍可打开。取消保存或拖拽不影响资料库。浏览器目标网页需要支持文件拖入；拖到普通页面空白处可能直接打开图片。

## 验证和构建

只验证本子项目：

```powershell
dart format --output=none --set-exit-if-changed lib test
flutter analyze --no-pub
flutter test --no-pub test/domain test/data test/application test/workbench_test.dart
flutter build windows --debug --no-pub
```

发布版本：

```powershell
flutter build windows --release --no-pub
```

构建后必须分发整个 `build/windows/x64/runner/Release/` 目录，包含 EXE、DLL 和 data；不能只复制单个 EXE。发布签名和安装程序另行配置。

人工验收 EVA 时，先选取一张同时能通过“下载原图”保存的图片，拖入后比较文件长度、像素和 SHA-256，再测试多图与连续拖入。原图结论以实际文件对比为准。请让 EVA 与本工具以相同权限级别运行，避免 Windows 阻止跨权限拖拽。
