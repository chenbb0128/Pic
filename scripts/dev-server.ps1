param([switch]$SkipDatabase)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath '.env')) { throw '请先复制 .env.example 为 .env 并设置随机密码。' }
    Get-Content -LiteralPath '.env' | ForEach-Object {
        if ($_ -match '^([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
    if (-not $env:PIC_TOOL_PASSWORD) { throw '请在 .env 设置 PIC_TOOL_PASSWORD（工具访问密码，至少 8 字节）。' }
    if (-not $SkipDatabase) {
        docker compose -f compose.dev.yaml up -d --wait mysql
        if ($LASTEXITCODE -ne 0) { throw '项目专用 MySQL 启动失败，请检查 Docker Desktop。' }
    }
    $env:GO_TEMPLATE_DATABASE_ENABLED = 'true'
    $env:GO_TEMPLATE_DATABASE_DSN = "pic:$($env:PIC_MYSQL_PASSWORD)@tcp(127.0.0.1:3307)/pic?charset=utf8mb4&parseTime=true&loc=UTC"
    $env:GO_TEMPLATE_APP_NAME = 'pic-api'
    $env:GO_TEMPLATE_HTTP_ADDR = '127.0.0.1:8081'
    $env:GO_TEMPLATE_HTTP_MAX_BODY_BYTES = '28311552'
    $env:GO_TEMPLATE_HTTP_READ_TIMEOUT = '120s'
    $env:GO_TEMPLATE_HTTP_WRITE_TIMEOUT = '120s'
    $env:PIC_LIBRARY_ENABLED = 'true'
    $env:PIC_COOKIE_SECURE = 'false'
    $env:PIC_DATA_DIR = Join-Path $projectRoot 'server/storage/assets'
    Set-Location -LiteralPath (Join-Path $projectRoot 'server')
    go run ./cmd/migrate -command up
    if ($LASTEXITCODE -ne 0) { throw '数据库迁移失败，未启动 API。' }
    Write-Host 'Pic API: http://127.0.0.1:8081 ; 使用 .env 中的 PIC_TOOL_PASSWORD 解锁并进入共享空间（勿提交密码）'
    go run ./cmd/api
    if ($LASTEXITCODE -ne 0) { throw 'API 已退出，请检查以上日志。' }
} finally { Pop-Location }
