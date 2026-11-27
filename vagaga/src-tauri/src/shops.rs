use std::borrow::Cow;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::store::{random_hex_pub, Store};
use crate::workflow::{self, selected};
use crate::workflow_db as db;
use crate::workflow_storage::Backend;
use crate::AppState;

const ORDER_PREFIX: &str = "~shop~";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Shop {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) active: bool,
}

#[derive(Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    pub(crate) shops: Vec<Shop>,
    pub(crate) legacy_assignments: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) shared_archives: BTreeMap<String, String>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

pub(crate) fn split_order(number: &str) -> Option<(&str, &str)> {
    let (shop, number) = number.strip_prefix(ORDER_PREFIX)?.split_once('~')?;
    (valid_id(shop) && !number.is_empty()).then_some((shop, number))
}

pub(crate) fn platform_number(key: &str) -> &str {
    split_order(key).map_or(key, |(_, number)| number)
}

pub(crate) fn display_order(store: &Store, key: &str) -> String {
    let Some((id, number)) = split_order(key) else {
        return key.to_owned();
    };
    if let Ok(catalog) = current(store) {
        if let Some(shop) = catalog.shops.into_iter().find(|shop| shop.id == id) {
            return format!("{} · {number}", shop.name);
        }
    }
    number.to_owned()
}

fn scoped_order(shop: &str, number: &str) -> Result<String, String> {
    let key = format!("{ORDER_PREFIX}{shop}~{number}");
    if !valid_id(shop) || key.len() > 256 {
        return Err("订单号太长或店铺无效。".into());
    }
    Ok(key)
}

pub(crate) fn shared_partition(storage: &str) -> String {
    // Older clients continue to see their original shared orders during rollout.
    format!("vagaga-shops-v1:{:x}", Sha256::digest(storage.as_bytes()))
}

pub(crate) fn order_partition<'a>(storage: &'a str, number: &str) -> Cow<'a, str> {
    match split_order(number) {
        Some(_) => Cow::Owned(shared_partition(storage)),
        None => Cow::Borrowed(storage),
    }
}

fn catalog_key(store: &Store, target: &str) -> String {
    let mysql = crate::mysql::load_config(store.data_root());
    let scope = serde_json::json!([target, mysql.host, mysql.port, mysql.dbname]);
    format!(
        "shop-catalog:{:x}",
        Sha256::digest(scope.to_string().as_bytes())
    )
}

pub(crate) fn cached(store: &Store, target: &str) -> Result<Catalog, String> {
    match db::setting(store, &catalog_key(store, target)).map_err(|error| error.to_string())? {
        Some(json) => serde_json::from_str(&json).map_err(|error| error.to_string()),
        None => Ok(Catalog::default()),
    }
}

pub(crate) fn current(store: &Store) -> Result<Catalog, String> {
    let target = Backend::configured_target(store, store.data_root())?;
    match target {
        Some(target) => cached(store, &target),
        None => Ok(Catalog::default()),
    }
}

pub(crate) fn cache(store: &Store, target: &str, catalog: &Catalog) -> Result<bool, String> {
    if cached(store, target)? == *catalog {
        return Ok(false);
    }
    let json = serde_json::to_string(catalog).map_err(|error| error.to_string())?;
    db::put_setting(store, &catalog_key(store, target), &json)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

pub(crate) fn capture_order(
    store: &Store,
    number: &str,
    shop: Option<&str>,
) -> Result<String, String> {
    if number.is_empty()
        || number.len() > 256
        || number.chars().any(char::is_control)
        || number.starts_with(ORDER_PREFIX)
    {
        return Err("请输入有效的订单号。".into());
    }
    let catalog = current(store)?;
    let Some(shop) = shop.filter(|id| !id.is_empty()) else {
        return if catalog.shops.is_empty() {
            Ok(number.to_owned())
        } else {
            Err("请在千帆的排单菜单里选择店铺。".into())
        };
    };
    if !catalog
        .shops
        .iter()
        .any(|entry| entry.id == shop && entry.active)
    {
        return Err("这家店铺当前不可用，请同步后重新选择。".into());
    }
    if catalog
        .legacy_assignments
        .get(number)
        .is_some_and(|assigned| assigned == shop)
    {
        return Ok(number.to_owned());
    }
    scoped_order(shop, number)
}

#[tauri::command]
pub(crate) fn list_shops(state: State<'_, AppState>) -> Result<Catalog, String> {
    current(&state.store)
}

#[tauri::command]
pub(crate) async fn save_shop(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    active: bool,
) -> Result<Catalog, String> {
    let _operation = state.workflow_operations.lock().await;
    if db::role(&state.store) == "production" {
        return Err("请在排单端管理店铺。".into());
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
        return Err("请输入 1 到 60 个字符的店铺名称。".into());
    }
    if id.as_deref().is_some_and(|value| !valid_id(value)) {
        return Err("店铺无效。".into());
    }
    let target = selected(&state)?.target();
    let mut index = workflow::shared_database(&state.data_root).await?;
    let mut catalog = index.shop_catalog(&target).await?;
    if catalog
        .shops
        .iter()
        .any(|shop| shop.name == name && Some(&shop.id) != id.as_ref())
    {
        return Err("已有同名店铺。".into());
    }
    if let Some(id) = id {
        let shop = catalog
            .shops
            .iter_mut()
            .find(|shop| shop.id == id)
            .ok_or("店铺不存在。")?;
        shop.name = name.to_owned();
        shop.active = active;
        index.save_shop(&target, shop, false).await?;
    } else {
        index
            .save_shop(
                &target,
                &Shop {
                    id: random_hex_pub(16),
                    name: name.to_owned(),
                    active,
                },
                true,
            )
            .await?;
    }
    let catalog = index.shop_catalog(&target).await?;
    cache(&state.store, &target, &catalog)?;
    Ok(catalog)
}

#[tauri::command]
pub(crate) async fn assign_legacy_shops(
    state: State<'_, AppState>,
    numbers: Vec<String>,
    shop_id: String,
) -> Result<Catalog, String> {
    let _operation = state.workflow_operations.lock().await;
    if db::role(&state.store) == "production" {
        return Err("请在排单端分配旧订单。".into());
    }
    let target = selected(&state)?.target();
    let mut index = workflow::shared_database(&state.data_root).await?;
    let catalog = index.shop_catalog(&target).await?;
    if !catalog
        .shops
        .iter()
        .any(|shop| shop.id == shop_id && shop.active)
    {
        return Err("请选择启用中的店铺。".into());
    }
    for number in &numbers {
        if number.starts_with(ORDER_PREFIX) {
            return Err("只能为待归属的订单分配店铺。".into());
        }
        let order = db::order_state(&state.store, number).map_err(|error| error.to_string())?;
        let order = order.ok_or("存在已被移除的订单，请刷新列表。")?;
        if order
            .target
            .as_deref()
            .is_some_and(|assigned| assigned != target)
        {
            return Err("订单关联了其他共享空间，请切换到对应空间。".into());
        }
        let key = scoped_order(&shop_id, number)?;
        if state
            .store
            .get_order_by_number(&key)
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err(format!("该店已存在同号订单 {number}。"));
        }
    }
    index
        .assign_legacy_shops(&target, &shop_id, &numbers)
        .await?;
    let catalog = index.shop_catalog(&target).await?;
    cache(&state.store, &target, &catalog)?;
    Ok(catalog)
}

#[tauri::command]
pub(crate) async fn set_shop_orders_archived(
    state: State<'_, AppState>,
    shop_id: String,
    mut numbers: Vec<String>,
    archived: bool,
) -> Result<Catalog, String> {
    let _operation = state.workflow_operations.lock().await;
    if db::role(&state.store) == "production" {
        return Err("请在排单端管理历史订单。".into());
    }
    let target =
        Backend::configured_target(&state.store, &state.data_root)?.ok_or("请先配置共享存储。")?;
    let catalog = cached(&state.store, &target)?;
    if !catalog.shops.iter().any(|shop| shop.id == shop_id) {
        return Err("请选择有效的店铺。".into());
    }
    numbers.sort_unstable();
    numbers.dedup();
    let mut local = Vec::new();
    let mut shared = Vec::new();
    for number in numbers {
        let assigned = split_order(&number)
            .map(|(shop, _)| shop)
            .or_else(|| catalog.legacy_assignments.get(&number).map(String::as_str));
        if assigned != Some(shop_id.as_str()) {
            return Err("选择的订单包含其他店铺的记录，请刷新后重试。".into());
        }
        let order = db::order_state(&state.store, &number)
            .map_err(|error| error.to_string())?
            .ok_or("存在已被移除的订单，请刷新列表。")?;
        match order.target.as_deref() {
            None if order.local_completed => local.push(number),
            Some(order_target)
                if order_target == target && order.shared_state.as_deref() == Some("completed") =>
            {
                let version = order.remote_operation_id.ok_or("请同步后重试。")?;
                shared.push((number, version));
            }
            _ => return Err("请同步后仅选择已完成交付的订单或本机已完成的订单。".into()),
        }
    }
    let catalog = if shared.is_empty() {
        catalog
    } else {
        let mut index = workflow::shared_database(&state.data_root).await?;
        index.set_shop_archives(&target, &shared, archived).await?;
        let catalog = index.shop_catalog(&target).await?;
        cache(&state.store, &target, &catalog)?;
        catalog
    };
    db::archive_local(&state.store, &local, archived).map_err(|error| error.to_string())?;
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_number_use_distinct_shop_keys_and_keep_original_number() {
        let first = "a".repeat(32);
        let second = "b".repeat(32);
        let a = scoped_order(&first, "P0001").unwrap();
        let b = scoped_order(&second, "P0001").unwrap();
        assert_ne!(a, b);
        assert_eq!(split_order(&a), Some((first.as_str(), "P0001")));
        assert_eq!(split_order(&b), Some((second.as_str(), "P0001")));
        assert_eq!(order_partition("base", "P0001"), "base");
        assert_eq!(order_partition("base", &a), shared_partition("base"));
        assert_ne!(order_partition("base", &a), order_partition("other", &a));
    }
}
