pub mod cdp;
mod asset_scope;
pub mod cloud;
pub mod commands;
pub mod cutout;
mod data_dir;
pub mod mysql;
mod material_export;
mod network_drivers;
mod qiniu_settings;
mod qiniu_store;
mod qiniu_sync;
mod qiniu_transport;
pub mod store;
pub mod templates;
mod workflow;
mod workflow_db;
mod workflow_qiniu;
mod workflow_storage;

use std::path::PathBuf;
use std::sync::Arc;

use std::io::Write;
use tauri::{Emitter, Manager};

/// 全局应用状态（注入 commands 与事件转发）。
pub struct AppState {
    pub store: Arc<store::Store>,
    pub data_root: PathBuf,
    pub port: u16,
    pub(crate) cloud: Arc<cloud::Sync>,
    pub(crate) workflow_operations: tokio::sync::Mutex<()>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 业务数据严格跟随 EXE，不导入或回退到其他目录。
            let executable = std::env::current_exe()
                .map_err(|error| format!("无法确定程序位置：{error}"))?;
            let data_root = data_dir::for_executable(&executable)?;
            asset_scope::configure(&app.asset_protocol_scope(), &data_root)?;
            let opened = store::Store::open(&data_root).map_err(|error| error.to_string())?;
            let store = Arc::new(opened);
            let cloud = Arc::new(cloud::Sync::new());
            let port = 9222u16;
            app.manage(AppState {
                store: store.clone(),
                data_root: data_root.clone(),
                port,
                cloud,
                workflow_operations: tokio::sync::Mutex::new(()),
            });

            // CDP 注入器后台运行；事件转发到前端（分流入库/失败两个频道）。
            let core_script =
                include_str!("../assets/paidan_core.js").to_string();
            let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<cdp::PaidanEvent>(64);
            let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Keep the shutdown channel open as long as this injector is alive.
                let _shutdown_tx = _shutdown_tx;
                cdp::Injector {
                    store,
                    core_script,
                    port,
                    events_tx,
                    shutdown: shutdown_rx,
                    scan_interval: std::time::Duration::from_secs(3),
                }.run().await;
            });
            let log_path = data_root.join("paidan-center.log");
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events_rx.recv().await {
                    let line = match &event {
                        cdp::PaidanEvent::Ingested { order_number, image_id, scaled } => format!(
                            "{} INGESTED order={} image={} scaled={}",
                            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                            order_number, image_id, scaled
                        ),
                        cdp::PaidanEvent::Failed { order_number, detail } => format!(
                            "{} FAILED order={} {}",
                            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                            order_number, detail
                        ),
                    };
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&log_path)
                    {
                        let _ = writeln!(f, "{}", line);
                    }
                    match &event {
                        cdp::PaidanEvent::Ingested { .. } => {
                            let _ = handle.emit("paidan:ingested", &event);
                        }
                        cdp::PaidanEvent::Failed { .. } => {
                            let _ = handle.emit("paidan:failed", &event);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_orders,
            commands::get_order,
            commands::set_image_templates,
            commands::delete_image,
            commands::delete_order,
            commands::get_app_info,
            commands::copy_image_to_clipboard,
            commands::make_page,
            commands::cutout_image_bytes,
            commands::get_cloud_config,
            commands::save_cloud_config,
            commands::cloud_test,
            commands::cloud_sync_now,
            commands::get_mysql_config,
            commands::save_mysql_config,
            commands::mysql_test,
            commands::mysql_sync_now,
            commands::get_cutout_config,
            commands::save_cutout_config,
            commands::save_production,
            commands::list_productions,
            commands::open_path,
            material_export::save_order_image,
            qiniu_settings::get_qiniu_settings,
            qiniu_settings::test_qiniu_settings,
            qiniu_settings::save_qiniu_settings,
            qiniu_sync::get_qiniu_status,
            qiniu_sync::qiniu_sync_now,
            workflow::workflow_settings,
            workflow::workflow_set_role,
            workflow::workflow_orders,
            workflow::workflow_test,
            workflow::workflow_set_layout,
            workflow::workflow_upload,
            workflow::workflow_sync,
            workflow::workflow_finish,
            workflow::workflow_resolve_conflict,
        ])
        .run(tauri::generate_context!())
        .expect("vagaga 启动失败");
}
