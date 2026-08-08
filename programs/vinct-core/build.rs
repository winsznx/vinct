//! Emits a build fingerprint into the program binary.
//!
//! Phase 3 found that an ephemeral rollup can keep executing a program it cloned before an
//! upgrade, and that the resulting failure looks like an ordinary application error. The
//! fingerprint is what turns that into a check instead of a diagnosis: a `build_info`
//! instruction returns it, and a proof run compares what the ER answers against what base
//! answers and against what was actually built.
//!
//! The value is a SHA-256 over every source file in the crate, so it changes whenever the
//! program changes and does not change for a rebuild of identical sources. Nothing external
//! feeds it, which keeps it reproducible.

use std::fs;
use std::path::Path;

fn hash_sources(root: &Path, base: &Path, hasher: &mut sha2::Sha256) {
    use sha2::Digest;

    let mut entries: Vec<_> = match fs::read_dir(root) {
        Ok(read) => read.filter_map(Result::ok).collect(),
        Err(_) => return,
    };
    // Sorted so directory iteration order cannot change the fingerprint.
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            hash_sources(&path, base, hasher);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            if let Ok(contents) = fs::read(&path) {
                // Relative to the source root, so the fingerprint depends on the sources and
                // not on where the repository happens to sit. A checkout on another machine
                // has to produce the same value for the freshness check to mean anything.
                let relative = path.strip_prefix(base).unwrap_or(&path);
                hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
                hasher.update(&contents);
            }
        }
    }
}

fn main() {
    use sha2::Digest;

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets this");
    let src = Path::new(&manifest_dir).join("src");

    let mut hasher = sha2::Sha256::new();
    hasher.update(env!("CARGO_PKG_NAME").as_bytes());
    hash_sources(&src, &src, &mut hasher);
    let digest: [u8; 32] = hasher.finalize().into();

    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    println!("cargo:rustc-env=VINCT_BUILD_FINGERPRINT={hex}");
    println!("cargo:rerun-if-changed={}", src.display());
}
