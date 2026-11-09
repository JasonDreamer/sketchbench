//! トークン認証付きlocalhost HTTP(axum)。4Kフレーム転送の比較対象。

use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode},
    routing::post,
    Router,
};
use tower_http::cors::{Any, CorsLayer};

fn sample_sum(b: &[u8]) -> u64 {
    b.iter().step_by(1 << 20).map(|&x| x as u64).sum()
}

pub async fn serve(token: String) -> Result<u16, String> {
    let app = Router::new()
        .route(
            "/frame",
            post(move |headers: HeaderMap, body: Bytes| {
                let token = token.clone();
                async move {
                    if headers.get("x-token").and_then(|v| v.to_str().ok()) != Some(token.as_str()) {
                        return (StatusCode::FORBIDDEN, String::new());
                    }
                    (StatusCode::OK, format!("{} {}", body.len(), sample_sum(&body)))
                }
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(64 << 20))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any)
                .max_age(std::time::Duration::from_secs(600)),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(port)
}
