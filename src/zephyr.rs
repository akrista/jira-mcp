// Zephyr Squad Cloud (ZAPI) integration: JWT-signed test step calls.

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::jira::JiraApi;

#[derive(Serialize)]
struct ZephyrClaims<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    sub: Option<&'a str>,
    iss: Option<&'a str>,
    qsh: String,
    iat: i64,
    exp: i64,
}

/// Builds the sorted canonical query string used for the qsh claim.
fn canonical_query(query_params: &[(&str, &str)]) -> String {
    let mut sorted: Vec<_> = query_params.to_vec();
    sorted.sort();
    sorted
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Generates an HS256 JWT for the Zephyr API with a qsh claim hashing
/// METHOD&<path>&<sorted query>.
fn generate_zephyr_jwt(
    cfg: &Config,
    method: &str,
    api_path: &str,
    query_params: &[(&str, &str)],
) -> Result<String, String> {
    let canonical = format!(
        "{}&{}&{}",
        method.to_uppercase(),
        api_path,
        canonical_query(query_params)
    );
    let digest = Sha256::digest(canonical.as_bytes());
    let qsh: String = digest.iter().map(|b| format!("{b:02x}")).collect();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {e}"))?
        .as_secs() as i64;

    let claims = ZephyrClaims {
        sub: cfg.zapi_account_id.as_deref(),
        iss: cfg.zapi_access_key.as_deref(),
        qsh,
        iat: now,
        exp: now + 3600,
    };

    let secret = cfg
        .zapi_secret_key
        .as_deref()
        .ok_or("ZAPI_SECRET_KEY is not set")?;

    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(), // HS256
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("failed to sign Zephyr JWT: {e}"))
}

async fn zephyr_request(
    api: &JiraApi,
    method: reqwest::Method,
    api_path: &str,
    query_params: &[(&str, &str)],
    body: Option<Value>,
) -> Result<Value, String> {
    let cfg = &api.cfg;
    let access_key = cfg
        .zapi_access_key
        .as_deref()
        .ok_or("ZAPI_ACCESS_KEY is not set")?;
    let jwt = generate_zephyr_jwt(cfg, method.as_str(), api_path, query_params)?;

    let base = cfg.zapi_base_url.trim_end_matches('/');
    let query: Vec<(&str, String)> = query_params
        .iter()
        .map(|(k, v)| (*k, v.to_string()))
        .collect();

    eprintln!("[JIRA-MCP] Zephyr {method} {base}{api_path}");
    let mut req = api
        .client()
        .request(method, format!("{base}{api_path}"))
        .header("Content-Type", "application/json")
        .header("zapiAccessKey", access_key)
        .header("Authorization", format!("JWT {jwt}"))
        .query(&query);
    if let Some(body) = body {
        req = req.json(&body);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Zephyr request failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let data: Value = serde_json::from_str(&text)
        .unwrap_or_else(|_| json!({ "error": "Could not parse response as JSON", "text": text }));

    if !(200..300).contains(&status) {
        eprintln!("[JIRA-MCP] Zephyr error response: {data}");
        return Err(format!("Status: {status}. Response: {data}"));
    }
    Ok(data)
}

/// Gets test steps for an issue. Zephyr returns a bare array.
pub async fn get_test_steps(
    api: &JiraApi,
    issue_id: &str,
    project_id: &str,
) -> Result<Vec<Value>, String> {
    let api_path = format!("/public/rest/api/1.0/teststep/{issue_id}");
    let data = zephyr_request(
        api,
        reqwest::Method::GET,
        &api_path,
        &[("projectId", project_id)],
        None,
    )
    .await?;

    data.as_array()
        .cloned()
        .ok_or_else(|| "Unexpected response format from Zephyr API".into())
}

/// Adds a single test step.
pub async fn add_test_step(
    api: &JiraApi,
    issue_id: &str,
    project_id: &str,
    step: &str,
    data: &str,
    result: &str,
) -> Result<Value, String> {
    let api_path = format!("/public/rest/api/1.0/teststep/{issue_id}");
    zephyr_request(
        api,
        reqwest::Method::POST,
        &api_path,
        &[("projectId", project_id)],
        Some(json!({ "projectId": project_id, "step": step, "data": data, "result": result })),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_query_is_sorted() {
        assert_eq!(canonical_query(&[("b", "2"), ("a", "1"), ("c", "3")]), "a=1&b=2&c=3");
    }
}
