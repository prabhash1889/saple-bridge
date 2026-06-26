fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    // Baked in for sidecar path resolution at runtime (see `sidecar_binary_path` in project.rs):
    // in dev we locate the triple-suffixed binary under src-tauri/binaries/.
    println!("cargo:rustc-env=TARGET_TRIPLE={}", std::env::var("TARGET").unwrap_or_default());
    println!("cargo:rustc-env=SAPLE_BRIDGE_MANIFEST_DIR={}", std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    tauri_build::build()
}
