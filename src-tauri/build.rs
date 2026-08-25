use std::{env, path::Path, process::Command};

fn main() {
    for input in [
        "../index.html",
        "../package.json",
        "../package-lock.json",
        "../public",
        "../src",
        "../tsconfig.json",
        "../tsconfig.node.json",
        "../vite.config.ts",
    ] {
        println!("cargo:rerun-if-changed={input}");
    }

    if env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_some() {
        build_frontend();
    }

    tauri_build::build()
}

fn build_frontend() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Tauri crate must be inside the workspace");
    let status = Command::new("npm")
        .args(["run", "build"])
        .current_dir(workspace)
        .status()
        .unwrap_or_else(|error| panic!("failed to run `npm run build`: {error}"));

    if !status.success() {
        panic!("`npm run build` failed with status {status}");
    }
}
