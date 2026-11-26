// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Serve only the compiled bootstrap on this origin. The main app retains
    // its strict CSP while the isolated document can run the published engine.
    #[cfg(not(dev))]
    let builder = builder.register_uri_scheme_protocol("story-runtime", |_context, request| {
        let mut response = tauri::http::Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .header("X-Content-Type-Options", "nosniff");
        let body: &[u8] = if request.uri().path() == "/host" {
            include_bytes!("../../dist/sugarcube-host.html")
        } else {
            response = response.status(404);
            b"Unknown story host"
        };
        response.body(body.to_vec()).expect("static story response")
    });
    builder
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
