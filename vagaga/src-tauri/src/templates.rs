//! 制作模板目录（A01–A12），与 web 端爱心星星模板一一对应。
//! 权威来源：`web/public/embedded/heart-star/index.html` 的 `select#template`；
//! 由 `tool/sync_templates.mjs` 校验同步，勿随意手改 web_id。

pub struct Template {
    pub code: &'static str,
    pub name: &'static str,
    /// web 端模板 id（下拉框 option value，中文文件名格式）
    pub web_id: &'static str,
}

pub const TEMPLATES: &[Template] = &[
    Template { code: "A01", name: "爱心款", web_id: "模板爱心.png" },
    Template { code: "A02", name: "爱心横版", web_id: "爱心横版.png" },
    Template { code: "A03", name: "爱心+星星混合版", web_id: "模板混合.png" },
    Template { code: "A04", name: "粉色款", web_id: "模板粉色.png" },
    Template { code: "A05", name: "蓝色款", web_id: "模板蓝色.png" },
    Template { code: "A06", name: "黄色款", web_id: "模板黄色.png" },
    Template { code: "A07", name: "混合竖版", web_id: "甜心派对.png" },
    Template { code: "A08", name: "缤纷糖果版", web_id: "缤纷糖果.png" },
    Template { code: "A09", name: "大头混合横版", web_id: "I-ME横版大头.png" },
    Template { code: "A10", name: "心动马卡龙款", web_id: "爱心心动马卡龙.png" },
    Template { code: "A11", name: "焦糖秋枫混合豹纹", web_id: "经典豹纹混合.png" },
    Template { code: "A12", name: "奶油黑粉混合豹纹", web_id: "黑粉奶油混合豹纹.png" },
];

/// 按商品编号（如 "A01"）查找模板。
pub fn find_by_code(code: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.code == code)
}

/// 按 web 模板 id 查找模板。
pub fn find_by_web_id(web_id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.web_id == web_id)
}

/// 注入脚本内嵌用的模板目录 JSON（[{code, name, id}]）。
pub fn catalog_json() -> String {
    serde_json::to_string(
        &TEMPLATES
            .iter()
            .map(|t| serde_json::json!({ "code": t.code, "name": t.name, "id": t.web_id }))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string())
}
