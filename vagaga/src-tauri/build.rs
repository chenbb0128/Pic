fn main() {
    tauri_build::build();
    // Tauri's mock App links Windows UI APIs too; the test runner needs Common Controls v6.
    #[cfg(windows)]
    println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
}
