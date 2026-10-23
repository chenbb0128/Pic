# 门店共享 API v1

前缀 `/api/v1`，单门店共享空间。成功信封 `{code:0,message:"success",data:...}`；错误返回相应 HTTP status 和 `message`。401 重新登录，409 提示冲突，禁止自动重试覆盖。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/session` | JSON username/password，设置 30 天 HttpOnly cookie |
| GET | `/session` | 当前登录账号 |
| DELETE | `/session` | 注销并失效当前会话 |
| POST | `/assets` | multipart `file`，返回 id/mime/size/width/height |
| GET | `/assets/{id}` | 登录后读取原始文件，private/no-store |
| GET | `/projects?offset=0&q=关键词` | 服务端按名称／编号包含匹配后分页，每页 50 条，不含快照 |
| POST | `/projects` | 新建 `{name,version:0,snapshot,thumbnailId?,resultId?}` |
| GET | `/projects/{id}` | 完整独立快照和 version |
| PUT | `/projects/{id}` | `{name,version,snapshot,thumbnailId?,resultId?}`，仅匹配当前 version 时更新 |
| DELETE | `/projects/{id}` | `{version}`，带版本的软删除 |

`/templates` 与 `/projects` CRUD 一致，但 `photos` 必须全部为 null。不依赖动态模板 ID：项目保存完整模板快照。

列表摘要新增 `number`（从 `snapshot.settings.footerText` 派生）及可选 `thumbnailId`。缩略图由前端显式保存时上传，为最长边 320 px 的白底水印 PNG，读取仍须登录；模板缩略图不渲染客户照片层。旧文件缺少缩略图时正常显示占位，再保存可生成。`q` 最多 200 字，按字面文本匹配（`%`、`_` 不作通配符），空关键词表示全部。缩略图与快照文件引用在同一事务内校验存在。

作品另含可选 `resultId`，列表和详情均返回。它引用已上传的私有 PNG 成品，与快照、缩略图和 version 在同一事务内提交；结果文件纳入文档图片引用。前端保存时按当前 DPI 生成完整成品，嵌入 pHYs，保留编号，不带预览水印或选框。读取／下载仍使用鉴权 `/assets/{id}`；结果图只用于查看下载，继续编辑始终恢复快照和原图，绝不从成品反推图层。模板接口禁止携带 `resultId`，防止客户成品混入模板。兼容旧客户端省略该字段，更新省略时清空旧引用，避免编辑内容已变但成品仍是旧图。旧作品不会被自动生成结果，重新保存作品后才有下载入口。

快照 schemaVersion=1、editor=heart-star。template 含 w/h/slots 和底图文件引用；states、photos 和 slots 长度一致；settings 含 DPI、尺寸等。图片为 `{fileId:"32位随机十六进制ID"}`，不接受 src/url 等临时 URL。服务端在文档事务内校验所引用图片存在，并维护文档—图片关联。

所有资源接口需要 cookie。POST/PUT/DELETE 还必须携带与 `PIC_ORIGIN` 完全一致的 Origin；推荐从同源浏览器调用。登录失败限流在进程内，生产代理还应限流；密钥和密码只从环境传入。环境参数见根 `.env.example` 及 `internal/modules/library/environment.go`。

`api/openapi.yaml` 为上游基础健康检查定义；以上新增业务端点以此文档为准。
