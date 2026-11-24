use std::{env, fs, io::ErrorKind, path::PathBuf};

fn main() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("missing Cargo output directory"));
    for name in ["mysql-defaults.json", "cloud-defaults.json"] {
        let source = format!(".env.{name}");
        println!("cargo:rerun-if-changed={source}");
        let defaults = match fs::read(source) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => b"{}".to_vec(),
            Err(error) => panic!("cannot read internal {name}: {error}"),
        };
        fs::write(out_dir.join(name), defaults).expect("cannot embed internal configuration");
    }
    tauri_build::build();
    // Tauri's mock App links Windows UI APIs too; the test runner needs Common Controls v6.
    #[cfg(windows)]
    println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
}
