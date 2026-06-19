// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "android")]
    println!("cargo:rustc-link-lib=aaudio");
    rumbleguard_lib::run();
}
