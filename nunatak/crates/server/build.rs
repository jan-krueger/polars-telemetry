use std::path::PathBuf;

const NOT_BUILT: &str = "<!doctype html><meta charset=\"utf-8\"><title>Nunatak</title>\
<p>This nunatak was built without its dashboard. Run <code>npm run build:nunatak</code> in \
<code>viewer/</code>, then build nunatak again. Events are received at <code>/v1/events</code> \
and the API answers at <code>/api</code> either way.</p>";

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("set by cargo"));
    let web = manifest.join("../../web");
    println!("cargo:rerun-if-changed={}", web.display());
    let page =
        std::fs::read_to_string(web.join("nunatak.html")).unwrap_or_else(|_| NOT_BUILT.into());
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("set by cargo")).join("page.html");
    std::fs::write(out, page).expect("OUT_DIR is writable");
}
