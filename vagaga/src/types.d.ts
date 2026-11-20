printf 'interface Window {\n  __picDoInject?: (data: { b64: string; name: string; mime: string; template: string }) => void\n  __picTemplateLoaded?: boolean\n  __picPendingInject?: unknown\n}\n' > window.d.ts
ls window.d.ts && cd "D:/Repositories/Git/GitHub/Sinton/Pic/paidan-center" && pnpm build 2>&1 | tail -2
__zcode_status=$?
if [ "$__zcode_status" -eq 0 ]; then pwd -P > '/c/Users/Yan/AppData/Local/Temp/zcode-50715df6-7509-41b4-8082-c0fb7e561419-cwd'; fi
exit "$__zcode_status"
