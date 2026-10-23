# 基座来源

本目录基于 https://github.com/chenbb0128/go-template ，固定提交：
`645298854f626b31e565a93c03ba6602cc3be2fc`。

保留原有 API/Worker、配置、MySQL、Goose、日志及 HTTP 中间件结构；模块路径改为 `github.com/chenbb0128/Pic/server`。
业务代码位于 `internal/modules/library`，没有向公共基座仓库写入门店业务或客户图片。
Redis 和 Worker 保留但第一期不启用。环境配置沿用 `GO_TEMPLATE_` 前缀，业务独立使用 `PIC_`。
