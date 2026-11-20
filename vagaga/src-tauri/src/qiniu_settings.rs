use serde::{Deserialize, Serialize};
use tauri::State;

use crate::qiniu_transport::{Client, Device};
use crate::{store::Store, AppState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub enabled: bool,
    pub api_url: String,
    pub poll_seconds: u64,
    pub has_token: bool,
    pub role: Option<String>,
    pub workspace_id: Option<String>,
    pub device_id: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            api_url: String::new(),
            poll_seconds: 15,
            has_token: false,
            role: None,
            workspace_id: None,
            device_id: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsInput {
    enabled: bool,
    api_url: String,
    poll_seconds: u64,
    token: Option<String>,
}

impl Settings {
    pub(crate) fn captures(&self) -> bool {
        !self.enabled || matches!(self.role.as_deref(), Some("customer" | "both"))
    }

    pub(crate) fn publishes_production(&self) -> bool {
        matches!(self.role.as_deref(), Some("production" | "both"))
    }
}

pub(crate) fn load(store: &Store) -> Result<(Settings, Vec<u8>), String> {
    match store.read_qiniu_settings().map_err(|err| err.to_string())? {
        Some((settings, secret)) => Ok((
            serde_json::from_str(&settings).map_err(|_| "七牛同步设置损坏".to_string())?,
            secret,
        )),
        None => Ok((Settings::default(), Vec::new())),
    }
}

#[cfg(windows)]
fn crypt(value: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(value.len()).map_err(|_| "设备凭证太长".to_string())?,
        pbData: value.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // DPAPI reads the input and allocates the output with LocalAlloc.
    unsafe {
        let ok = if protect {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 || output.pbData.is_null() {
            return Err("无法使用当前 Windows 用户读取设备凭证，请重新接入".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn crypt(_value: &[u8], _protect: bool) -> Result<Vec<u8>, String> {
    Err("七牛设备凭证目前仅支持 Windows".into())
}

fn decrypt(secret: &[u8]) -> Result<String, String> {
    if secret.is_empty() {
        return Err("请填写设备凭证".into());
    }
    String::from_utf8(crypt(secret, false)?).map_err(|_| "设备凭证损坏，请重新接入".into())
}

fn supplied_token(value: Option<String>, encrypted: &[u8]) -> Result<String, String> {
    let value = value.unwrap_or_default();
    let value = value.trim();
    if value.is_empty() {
        return decrypt(encrypted);
    }
    if value.len() > 256 {
        return Err("设备凭证太长".into());
    }
    Ok(value.to_owned())
}

pub(crate) fn client(settings: &Settings, encrypted: &[u8]) -> Result<Client, String> {
    Client::new(&settings.api_url, &decrypt(encrypted)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn get_qiniu_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    load(&state.store).map(|(settings, _)| settings)
}

#[tauri::command]
pub(crate) async fn test_qiniu_settings(
    state: State<'_, AppState>,
    api_url: String,
    token: Option<String>,
) -> Result<Device, String> {
    let (old, encrypted) = load(&state.store)?;
    let url = api_url.trim().trim_end_matches('/');
    if token.as_deref().unwrap_or_default().trim().is_empty() && old.api_url != url {
        return Err("变更 API 地址时请重新输入该服务的设备凭证".into());
    }
    Client::new(url, &supplied_token(token, &encrypted)?)
        .map_err(|e| e.to_string())?
        .device()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn save_qiniu_settings(
    state: State<'_, AppState>,
    settings: SettingsInput,
) -> Result<Settings, String> {
    let (mut saved, mut encrypted) = load(&state.store)?;
    if !(10..=60).contains(&settings.poll_seconds) {
        return Err("同步间隔应在 10 到 60 秒之间".into());
    }
    let url = settings.api_url.trim().trim_end_matches('/');
    if settings.enabled {
        if settings
            .token
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
            && saved.api_url != url
        {
            return Err("变更 API 地址时请重新输入该服务的设备凭证".into());
        }
        let token = supplied_token(settings.token, &encrypted)?;
        let device = Client::new(url, &token)
            .map_err(|e| e.to_string())?
            .device()
            .await
            .map_err(|e| e.to_string())?;
        if saved.has_token
            && (saved.api_url != url
                || saved.workspace_id.as_deref() != Some(&device.workspace_id)
                || saved.device_id.as_deref() != Some(&device.device_id))
        {
            return Err(
                "此数据目录已绑定同步地址、业务空间和设备。更换令牌时请保留同一设备 ID；接入其他设备请使用独立的 EXE 数据目录".into(),
            );
        }
        saved.api_url = url.to_owned();
        saved.device_id = Some(device.device_id);
        saved.workspace_id = Some(device.workspace_id);
        saved.role = Some(device.role);
        encrypted = crypt(token.as_bytes(), true)?;
    }
    saved.enabled = settings.enabled;
    saved.poll_seconds = settings.poll_seconds;
    saved.has_token = !encrypted.is_empty();
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    state
        .store
        .write_qiniu_settings(&json, &encrypted)
        .map_err(|e| e.to_string())?;
    Ok(saved)
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn dpapi_credential_round_trip() {
        let token = b"fixture-qiniu-device-token";
        let encrypted = super::crypt(token, true).unwrap();
        assert_ne!(encrypted, token);
        assert_eq!(super::crypt(&encrypted, false).unwrap(), token);
    }
}
