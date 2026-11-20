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

use std::path::PathBuf;
use std::sync::Arc;

use std::io::Write;
use tauri::{Emitter, Manager};

/// 全局应用状态（注入 commands 与事件转发）。
pub struct AppState {
    pub store: Arc<store::Store>,
    pub data_root: PathBuf,
    pub port: u16,
    pub(crate) qiniu: Arc<qiniu_sync::Sync>,
    pub(crate) cloud: Arc<cloud::Sync>,
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
            let (qiniu_settings, credential) = qiniu_settings::load(&opened)?;
            let captures = qiniu_settings.captures();
            let store = Arc::new(opened.with_qiniu(qiniu_settings.enabled));
            let qiniu = Arc::new(qiniu_sync::Sync::new(qiniu_settings, &credential));
            let legacy = qiniu.legacy();
            let cloud = Arc::new(cloud::Sync::new());
            let cloud_for_events = cloud.clone();
            let port = 9222u16;
            app.manage(AppState {
                store: store.clone(),
                data_root: data_root.clone(),
                port,
                qiniu: qiniu.clone(),
                cloud: cloud.clone(),
            });
            qiniu.start(app.handle().clone(), store.clone(), data_root.clone());

            // CDP 注入器后台运行；事件转发到前端（分流入库/失败两个频道）。
            let core_script =
                include_str!("../assets/paidan_core.js").to_string();
            let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<cdp::PaidanEvent>(64);
            let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
            // 云同步任务与事件循环共用的克隆（先克隆再 move 进 injector）
            let store_for_events = store.clone();
            let backfill_store = store.clone();
            let poll_store = store.clone();
            let handle = app.handle().clone();
            let poll_handle = handle.clone();
            if captures {
                tauri::async_runtime::spawn(async move {
                    // Keep the shutdown channel open as long as this injector is alive.
                    let _shutdown_tx = _shutdown_tx;
                    let injector = cdp::Injector {
                        store,
                        core_script,
                        port,
                        events_tx,
                        shutdown: shutdown_rx,
                        scan_interval: std::time::Duration::from_secs(3),
                    };
                    injector.run().await;
                });
            }
            let log_path = data_root.join("paidan-center.log");
            let root_for_events = data_root.clone();
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
                        cdp::PaidanEvent::Ingested { order_number, image_id, .. } => {
                            if !legacy {
                                qiniu.wake();
                                let _ = handle.emit("paidan:ingested", &event);
                                continue;
                            }
                            // MySQL 直连与对象存储各自同步。
                            {
                                let store = store_for_events.clone();
                                let root = root_for_events.clone();
                                let order_number = order_number.clone();
                                tauri::async_runtime::spawn(async move {
                                    let config = mysql::load_config(&root);
                                    if !(config.enabled && config.valid()) {
                                        return;
                                    }
                                    let client = mysql::MyClient::new(&config);
                                    if let Err(error) =
                                        client.push_order(&store, &order_number).await
                                    {
                                        eprintln!("[mysql] 推送失败 {order_number}: {error}");
                                    }
                                });
                            }
                            if let Err(error) = cloud_for_events.enqueue(
                                &store_for_events, &root_for_events, order_number, image_id, true,
                            ) {
                                eprintln!("[cloud] 排单加入上传队列失败 {order_number}: {error}");
                            }
                            let _ = handle.emit("paidan:ingested", &event);
                        }
                        cdp::PaidanEvent::Failed { .. } => {
                            let _ = handle.emit("paidan:failed", &event);
                        }
                    }
                }
            });

            if !legacy {
                return Ok(());
            }
            let cloud_store = poll_store.clone();
            let cloud_root = data_root.clone();
            let cloud_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = cloud.backfill(&cloud_store, &cloud_root, true).await {
                    eprintln!("[cloud] 启动回填失败: {error}");
                }
                loop {
                    match cloud.cycle(&cloud_store, &cloud_root).await {
                        Ok(notices) => {
                            for notice in notices {
                                let _ = cloud_handle.emit("paidan:cloud-imported", serde_json::json!({
                                    "orderNumber": notice.order_number,
                                    "newImages": notice.new_images,
                                    "newProductions": 0,
                                }));
                            }
                        }
                        Err(error) => eprintln!("[cloud] 同步失败: {error}"),
                    }
                    let interval = cloud::load_config(&cloud_root).poll_seconds.max(10);
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(interval)) => {},
                        _ = cloud.wake.notified() => {},
                    }
                }
            });

            // MySQL 同步启动回填。
            let backfill_root = data_root.clone();
            tauri::async_runtime::spawn(async move {
                let mysql_config = mysql::load_config(&backfill_root);
                if mysql_config.enabled && mysql_config.valid() {
                    let client = mysql::MyClient::new(&mysql_config);
                    match client.backfill_push(&backfill_store).await {
                        Ok(count) => eprintln!("[mysql] 回填完成：{count} 个订单"),
                        Err(error) => eprintln!("[mysql] 回填失败: {error}"),
                    }
                }
            });

            // 独立轮询 MySQL 订单和成品。
            let poll_root = data_root.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let mysql_config = mysql::load_config(&poll_root);
                    let mut sleep_secs = 10;
                    if mysql_config.enabled && mysql_config.valid() {
                        let client = mysql::MyClient::new(&mysql_config);
                        match client.pull_all(&poll_store, &poll_root).await {
                            Ok(notices) => {
                                for notice in notices {
                                    let _ = poll_handle.emit(
                                        "paidan:cloud-imported",
                                        serde_json::json!({
                                            "orderNumber": notice.order_number,
                                            "newImages": notice.new_images,
                                            "newProductions": notice.new_productions,
                                        }),
                                    );
                                }
                            }
                            Err(error) => eprintln!("[mysql] 拉取失败: {error}"),
                        }
                        sleep_secs = mysql_config.poll_seconds.max(10);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(sleep_secs)).await;
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
            commands::cloud_backfill,
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
            qiniu_sync::qiniu_retry_failed,
        ])
        .run(tauri::generate_context!())
        .expect("vagaga 启动失败");
}
