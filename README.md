# Pic

图片排版前端与门店共享后端。现有本地排版／PNG 导出仍然由浏览器完成；仅主动保存到共享空间时上传文件。

## 目录

```text
web/                         Vue + Vite 前端
  public/embedded/heart-star/ 爱心星星编辑器和内置图案
server/                      Go API（基于 go-template，来源见 UPSTREAM.md）
  cmd/                       API / 数据库迁移 / 预留 Worker
  internal/modules/library/  门店登录、私有图片、共享模板和项目
  database/migrations/       MySQL 版本迁移
  storage/                   本地原始图片（不入 Git、不进入镜像）
scripts/                     本地启动及本次功能浏览器验证脚本
deploy/nginx/                原有静态前端发布配置
docs/                        设计与实施记录
compose.dev.yaml             专用 MySQL + 可选容器 API
Dockerfile                   原有前端镜像，不包含后端
```

## Windows 本地开发

要求 Node/pnpm、Go 1.24.3+、Docker Desktop。项目已配置的前端依赖无需重复安装。

1. 将 `.env.example` 复制为 `.env`，分别设置数据库密码、共享账号密码和随机会话密钥。共享密码至少 12 字节，密钥至少 32 字节；不要复用工具访问密码。首次开发已生成本机 `.env`，不提交 Git。
2. 在根目录启动后端：

   ```powershell
   pwsh -NoProfile -File scripts/dev-server.ps1
   ```

   此命令启动专用 `pic-local` MySQL（仅 `127.0.0.1:3307`），执行 Goose 迁移，再启动 Go API（`127.0.0.1:8081`）。图片写入 `server/storage/assets/`。若 MySQL 已启动，可附加 `-SkipDatabase`。

3. 另开终端启动前端：

   ```powershell
   cd web
   pnpm dev --host 127.0.0.1 --port 5173
   ```

4. 访问 `http://127.0.0.1:5173/tools/heart-star`，按原流程解锁工具。预览区右上点击“共享模板／作品”，用根目录 `.env` 中的 `PIC_USERNAME` / `PIC_PASSWORD` 登录。

前端 `/api/v1` 经 Vite 代理到 Go API。`PIC_ORIGIN` 必须与浏览器访问来源完全一致（`localhost` 和 `127.0.0.1` 不同），否则写请求被拒绝。改 Vite 配置后须重启 dev server。

也可用 `docker compose -f compose.dev.yaml up -d --build` 容器化运行 API 和迁移；此方式图片放在 `pic-local_pic_assets` 卷，与宿主 Go 开发的 `server/storage/assets/` **不是同一份**。不要交替使用两种 API 方式而不迁移图片。停止服务用 `docker compose -f compose.dev.yaml stop`，不要执行带 `-v` 的清理命令。

## 第一期功能

- 一个门店共享账号，所有登录成员拥有相同的查看／编辑／删除权限；不是多门店、多角色系统。
- “保存作品”：新建或更新当前作品；打开模板后此按钮为“保存当前模板”。“另存作品”：生成独立作品；“存为模板”：生成无客户照片的模板。
- 项目独立保存当时的模板图、图案目录、坐标、照片、背景、缩放位移、尺寸、编号、DPI；后续修改模板不会改变旧项目。
- 保存作品还会生成并上传当前 DPI 的完整结果 PNG，不含预览水印／选框，保留编号和 PNG 打印精度元数据；不会触发下载或清空编号。结果图与可编辑快照在同一文档版本事务内更新，失败／冲突时旧版本不变。结果图沿用单张 25 MB／4000 万像素限制，超过时提示手动减小尺寸或 DPI，不会静默降清晰度。
- 共享作品列表“继续编辑”恢复原图、模板及全部排版参数；“下载结果”直接下载该文件已保存的高清成品，不读取当前画板。旧作品仍可编辑，重新保存后生成结果图；不自动补生成旧作品的结果。
- 模板保存背景、图案、位置，不保存照片层。把客户照片当作自定义背景上传的内容仍属于背景，请自行确认。
- 共享列表分页（每页 50 条）。删除采用软删除，不物理删除图片；暂不提供恢复入口或孤立图片清理。
- 共享列表支持名称／排版编号服务端搜索和私有缩略图。旧文件可正常打开，再保存后生成缩略图；模板缩略图不带客户照片层。
- 预览工具栏显示“有未保存修改／正在保存／已保存时间”；仅选择和预览不算修改。刷新／关页按浏览器原生确认，站内离开可取消并保留原画板。此功能不是自动保存或草稿备份；存为模板不保护未存入项目的照片。
- 文案输入尚未点击“应用”时同样提示未保存；共享保存前会要求先应用，避免保存旧文案后误报成功。删除当前共享文件后，仍保留画板并重新提示未保存。
- version 乐观锁：发生冲突时提示重新打开或另存，不自动覆盖别人的修改。
- 服务端 30 天 HttpOnly / SameSite 会话；密码或会话密钥更改并重启后，旧会话失效。原工具密码仍只是旧的前端入口限制，不是服务器鉴权。
- 原始图片私有存储，下载也须登录。PNG/JPEG/GIF，单张 25 MB、4000 万像素；其他浏览器支持格式在上传前本地转 PNG。上传／保存失败不会覆盖当前排版。

## 增量验证

```powershell
cd server
go test ./internal/modules/library ./internal/platform/database ./internal/transport/httpapi -run 'TestPrivate|TestSession|TestWrites|TestDocument|TestUpload|TestMySQLLibrary|TestSnapshot|TestTemplateCannot|TestSuccessful|TestLibraryMount|TestNormaliz' -count=1

cd ../web
pnpm exec vitest run src/services/heartStarCloud.test.ts src/services/heartStarCloudClient.test.ts src/services/heartStarCloudEditor.test.ts src/services/heartStarTemplate.test.ts

# 本轮保存状态与导航保护的直接相关测试
pnpm exec vitest run src/services/heartStarCloudState.test.ts src/services/heartStarLeave.test.ts src/pages/HeartStarPage.test.ts
```

MySQL 集成测试需设置 `PIC_TEST_DSN` 指向专用测试库（本机为 `pic_test`），不要使用生产库；未设置会明确跳过。测试不会使用内存后端作为真实持久化方案。

可选浏览器验证：`node scripts/smoke-shared-library.cjs`，仅使用已安装的 Playwright；可设置 `PIC_PLAYWRIGHT_PATH` / `PIC_BROWSER_PATH` 指向本机已有运行库和浏览器。脚本使用内置测试图验证登录、上传、保存、刷新恢复、参数和原图像素一致，合成预览只允许少量边缘抗锯齿误差；高清结果检查完整像素、尺寸、DPI 和直接下载的字节一致，并验证继续编辑更新结果。默认／爱心模板还模拟结果上传失败与重试，验证不丢失当前编辑或覆盖旧版本。结束仅软删除自己创建的文档；测试图片仍按保留策略存放。`PIC_SMOKE_TEMPLATE` 可指定模板名称。

`node scripts/smoke-heart-star-leave.cjs` 验证 iframe 父页面刷新保护、站内离开提醒／取消后保留排版；不保存或上传图片。

## 发布与备份边界

生产发布配置统一由同级 `zdzq-deployment-config` 仓库管理，应用仓库只维护 Dockerfile、代码、迁移和开发配置。现有根 Dockerfile／NAS 流程仍只发布静态前端，不会自动上线 Go API；本轮新增的后端发布配置位于部署仓库 `projects/pic/candidate/backend/`，目前是**禁用候选，未修改线上**。不要直接使用开发 Compose 发布，也不要把整个候选目录覆盖到生产。

后端接入沿用 NAS → Jenkins → ACR → 腾讯云 `124.220.53.160`，不是把生产服务放在 NAS。前端仍为 `https://pic.pdurl.cn`；浏览器使用同源 `/api/v1/` 转发到 API，独立后端域名为 `https://pic-api.pdurl.cn`，不需要给前端硬编码跨域地址或放宽 Cookie。

API 和迁移使用 `server/deployments/Dockerfile` 分别以 `TARGET=api` / `TARGET=migrate` 构建，注入 `APP_SHA`、`CONFIG_SHA` 标签，独立 Jenkins 入口发布双版本 tag 并锁定 ACR digest。distroless API 可运行 `/app/app -healthcheck` 检查本容器固定8080端口的 `/ready`，无需安装 curl 或 shell。原前端发布入口和四参数 SSH 协议保持不变。

生产复用共享 MySQL 的独立 Pic 库、API/迁移独立账号，不新增项目级数据库容器。私有图片目录为 `/opt/apps/pic/data/assets`，由非 root API 用户65532写入，原图、模板图和结果图都保留；不经 Nginx 静态开放。密钥、共享账号、数据库 DSN 仅在受保护生产文件／Credentials，不能提交 Git。上线前仍需生产拓扑复核、账号与备份恢复演练、独立 SSH、DNS/证书和明确生产变更授权。

上线前需要同时备份 MySQL 和原始图片目录／卷，并验证成对恢复；只备份数据库不能恢复照片。候选发布脚本在迁移前暂停本项目 API 做数据库／图片配对备份，失败尝试恢复上一版 API 与环境，不自动执行 Goose down。第一期不含定时／异地备份、历史版本、编辑审计、实时协作，也尚未接入自动排版页面。
