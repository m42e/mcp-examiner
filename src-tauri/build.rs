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
    let npm_command = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let status = Command::new(npm_command)
        .args(["run", "build"])
        .current_dir(workspace)
        .status()
        .unwrap_or_else(|error| panic!("failed to run `{npm_command} run build`: {error}"));

    if !status.success() {
        panic!("`{npm_command} run build` failed with status {status}");
    }
}
