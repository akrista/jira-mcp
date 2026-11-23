// Jira REST API v3 client. All calls log to stderr (stdout belongs to the
// MCP stdio transport).

use serde_json::{json, Value};

use crate::config::Config;

#[derive(Clone)]
pub struct JiraApi {
    pub cfg: Config,
    http: reqwest::Client,
}

impl JiraApi {
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.http
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Basic {}", self.cfg.auth))
    }

    async fn send(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Value>,
    ) -> Result<reqwest::Response, String> {
        eprintln!("[JIRA-MCP] {method} {url}");
        let mut req = self.request(method, url);
        if let Some(body) = body {
            req = req.json(&body);
        }
        req.send()
            .await
            .map_err(|e| format!("request failed: {e}"))
    }

    /// Mirrors the TS extractErrorMessage: errorMessages first, then errors
    /// object, then bare status.
    fn error_message(status: u16, body: &Value) -> String {
        if let Some(msgs) = body
            .get("errorMessages")
            .and_then(|v| v.as_array())
            .filter(|a| !a.is_empty())
        {
            return msgs
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(", ");
        }
        if let Some(errors) = body
            .get("errors")
            .and_then(|v| v.as_object())
            .filter(|o| !o.is_empty())
        {
            return serde_json::to_string(errors).unwrap_or_default();
        }
        format!("Status: {status}")
    }

    async fn body_json(resp: reqwest::Response) -> Value {
        resp.json::<Value>().await.unwrap_or(Value::Null)
    }

    /// Call that must return 204 No Content.
    async fn expect_no_content(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Value>,
    ) -> Result<(), String> {
        let resp = self.send(method, url, body).await?;
        let status = resp.status().as_u16();
        if status == 204 {
            return Ok(());
        }
        let body = Self::body_json(resp).await;
        eprintln!("[JIRA-MCP] Error response: {body}");
        Err(Self::error_message(status, &body))
    }

    /// Call that returns JSON on success.
    async fn expect_json(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let resp = self.send(method, url, body).await?;
        let status = resp.status().as_u16();
        let data = Self::body_json(resp).await;
        if (200..300).contains(&status) {
            Ok(data)
        } else {
            eprintln!("[JIRA-MCP] Error response: {data}");
            Err(Self::error_message(status, &data))
        }
    }

    // ----- Issues ----------------------------------------------------------

    /// Creates an issue, retrying with alternative formats when custom-field
    /// validation fails (ports the TS createJiraTicket retry ladder).
    pub async fn create_issue(&self, payload: &Value) -> Result<Value, String> {
        let url = self.cfg.jira_api_url("/issue");

        match self.create_issue_once(&url, payload).await {
            Ok(data) => Ok(data),
            Err((status, body)) if status == 400 => {
                let Some(errors) = body.get("errors").and_then(|e| e.as_object()) else {
                    return Err(Self::error_message(status, &body));
                };
                let product_field = self.cfg.product_field.as_deref();
                let category_field = self.cfg.category_field.as_deref();

                let product_err = product_field
                    .and_then(|f| errors.get(f))
                    .and_then(|v| v.as_str());
                let category_err = category_field.is_some_and(|f| errors.contains_key(f));

                if let Some(perr) = product_err {
                    // Try alternative formats for the product field: some
                    // Jira instances expect a bare ID string, others arrays.
                    if let (Some(pid), Some(pval)) =
                        (self.cfg.product_id.as_deref(), self.cfg.product_value.as_deref())
                    {
                        let Some(pf) = product_field else {
                            unreachable!("product_err implies product_field is set");
                        };
                        for candidate in [json!(pid), json!([{ "id": pid }]), json!([{ "value": pval }])] {
                            let mut retry = payload.clone();
                            retry["fields"][pf] = candidate;
                            if let Ok(data) = self.create_issue_once(&url, &retry).await {
                                eprintln!("[JIRA-MCP] Ticket created after product-field format retry");
                                return Ok(data);
                            }
                        }
                        eprintln!("[JIRA-MCP] All product field format retries failed");
                    }

                    if perr.to_lowercase().contains("required") {
                        return Err(format!(
                            "Required field validation failed: {perr}. The product ID {:?} or value {:?} may be invalid for your JIRA instance.",
                            self.cfg.product_id, self.cfg.product_value
                        ));
                    }
                }

                // Non-required product/category field errors: drop the
                // offending fields and retry once.
                let drop_product = product_err.is_some_and(|e| !e.to_lowercase().contains("required"));
                if drop_product || category_err {
                    let mut retry = payload.clone();
                    let fields = retry["fields"].as_object_mut();
                    if let Some(fields) = fields {
                        if drop_product
                            && let Some(pf) = product_field {
                                fields.remove(pf);
                            }
                        if category_err
                            && let Some(cf) = category_field {
                                fields.remove(cf);
                            }
                    }
                    if let Ok(data) = self.create_issue_once(&url, &retry).await {
                        eprintln!("[JIRA-MCP] Ticket created after removing problematic custom fields");
                        return Ok(data);
                    }
                }

                Err(Self::error_message(status, &body))
            }
            Err((status, body)) => Err(Self::error_message(status, &body)),
        }
    }

    async fn create_issue_once(&self, url: &str, payload: &Value) -> Result<Value, (u16, Value)> {
        let resp = match self.send(reqwest::Method::POST, url, Some(payload.clone())).await {
            Ok(resp) => resp,
            Err(e) => return Err((0, json!({ "errorMessages": [e] }))),
        };
        let status = resp.status().as_u16();
        let body = Self::body_json(resp).await;
        if (200..300).contains(&status) {
            Ok(body)
        } else {
            Err((status, body))
        }
    }

    /// Creates a link between two tickets.
    pub async fn create_link(
        &self,
        outward_issue: &str,
        inward_issue: &str,
        link_type: &str,
    ) -> Result<(), String> {
        let url = self.cfg.jira_api_url("/issueLink");
        let payload = json!({
            "outwardIssue": { "key": outward_issue },
            "inwardIssue": { "key": inward_issue },
            "type": { "name": link_type },
        });
        self.expect_no_content(reqwest::Method::POST, &url, Some(payload))
            .await
    }

    /// Updates an issue (PUT, expects 204).
    pub async fn update_issue(&self, ticket_key: &str, payload: &Value) -> Result<(), String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/issue/{}", urlencoding::encode(ticket_key)));
        self.expect_no_content(reqwest::Method::PUT, &url, Some(payload.clone()))
            .await
    }

    /// Fetches the full fields object of an issue.
    pub async fn get_issue(&self, ticket_key: &str) -> Result<Value, String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/issue/{}", urlencoding::encode(ticket_key)));
        self.expect_json(reqwest::Method::GET, &url, None).await
    }

    /// Resolves a ticket key to its internal numeric id and project id
    /// (needed by the Zephyr API).
    pub async fn get_issue_ids(
        &self,
        ticket_key: &str,
    ) -> Result<(String, Option<String>), String> {
        let data = self.get_issue(ticket_key).await?;
        let Some(id) = data.get("id").and_then(|v| v.as_str()) else {
            return Err("No issue ID found in response".into());
        };
        let project_id = data
            .get("fields")
            .and_then(|f| f.get("project"))
            .and_then(|p| p.get("id"))
            .and_then(|i| i.as_str())
            .map(|s| s.to_string());
        Ok((id.to_string(), project_id))
    }

    /// Searches issues with JQL via /search/jql.
    pub async fn search(&self, jql: &str, max_results: u32) -> Result<Value, String> {
        let url = self.cfg.jira_api_url("/search/jql");
        let resp = self
            .request(reqwest::Method::GET, &url)
            .query(&[
                ("jql", jql),
                ("maxResults", &max_results.to_string()),
                ("fields", "summary,status,priority,issuetype,description"),
            ])
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let resp = resp;
        let status = resp.status().as_u16();
        let data = Self::body_json(resp).await;
        if (200..300).contains(&status) {
            Ok(data)
        } else {
            eprintln!("[JIRA-MCP] Error response: {data}");
            Err(Self::error_message(status, &data))
        }
    }

    // ----- Comments / transitions / assignee / watchers ---------------------

    /// Adds a comment (POST, expects 201).
    pub async fn add_comment(&self, ticket_key: &str, body: Value) -> Result<Value, String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/issue/{}/comment", urlencoding::encode(ticket_key)));
        self.expect_json(reqwest::Method::POST, &url, Some(json!({ "body": body })))
            .await
    }

    /// Lists comments.
    pub async fn list_comments(&self, ticket_key: &str, max_results: u32) -> Result<Value, String> {
        let url = self.cfg.jira_api_url(&format!(
            "/issue/{}/comment?maxResults={max_results}",
            urlencoding::encode(ticket_key)
        ));
        self.expect_json(reqwest::Method::GET, &url, None).await
    }

    /// Lists available transitions.
    pub async fn get_transitions(&self, ticket_key: &str) -> Result<Value, String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/issue/{}/transitions", urlencoding::encode(ticket_key)));
        self.expect_json(reqwest::Method::GET, &url, None).await
    }

    /// Applies a transition, optionally with a comment.
    pub async fn do_transition(
        &self,
        ticket_key: &str,
        transition_id: &str,
        comment: Option<Value>,
    ) -> Result<(), String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/issue/{}/transitions", urlencoding::encode(ticket_key)));
        let mut payload = json!({ "transition": { "id": transition_id } });
        if let Some(comment) = comment {
            payload["update"] = json!({ "comment": [{ "add": { "body": comment } }] });
        }
        self.expect_no_content(reqwest::Method::POST, &url, Some(payload))
            .await
    }

    /// Assigns (Some) or unassigns (None) an issue.
    pub async fn assign(&self, ticket_key: &str, account_id: Option<&str>) -> Result<(), String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/issue/{}/assignee", urlencoding::encode(ticket_key)));
        self.expect_no_content(
            reqwest::Method::PUT,
            &url,
            Some(json!({ "accountId": account_id })),
        )
        .await
    }

    /// Adds a watcher.
    pub async fn add_watcher(&self, ticket_key: &str, account_id: &str) -> Result<(), String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/issue/{}/watchers", urlencoding::encode(ticket_key)));
        self.expect_no_content(
            reqwest::Method::POST,
            &url,
            Some(Value::String(account_id.to_string())),
        )
        .await
    }

    /// Removes a watcher.
    pub async fn remove_watcher(&self, ticket_key: &str, account_id: &str) -> Result<(), String> {
        let url = self.cfg.jira_api_url(&format!(
            "/issue/{}/watchers?accountId={}",
            urlencoding::encode(ticket_key),
            urlencoding::encode(account_id)
        ));
        self.expect_no_content(reqwest::Method::DELETE, &url, None)
            .await
    }

    // ----- Admin ------------------------------------------------------------

    /// Creates a project. Requires "Administer Jira".
    pub async fn create_project(&self, payload: Value) -> Result<Value, String> {
        let url = self.cfg.jira_api_url("/project");
        self.expect_json(reqwest::Method::POST, &url, Some(payload))
            .await
    }

    /// Looks up a project by key or id (scheme assignment needs a numeric id).
    pub async fn get_project(&self, key_or_id: &str) -> Result<Value, String> {
        let url = self
            .cfg
            .jira_api_url(&format!("/project/{}", urlencoding::encode(key_or_id)));
        self.expect_json(reqwest::Method::GET, &url, None).await
    }

    /// Creates a global issue type. Requires "Administer Jira".
    pub async fn create_issue_type(&self, payload: Value) -> Result<Value, String> {
        let url = self.cfg.jira_api_url("/issuetype");
        self.expect_json(reqwest::Method::POST, &url, Some(payload))
            .await
    }

    /// Creates an issue type scheme (company-managed projects only).
    pub async fn create_issue_type_scheme(&self, payload: Value) -> Result<Value, String> {
        let url = self.cfg.jira_api_url("/issuetypescheme");
        self.expect_json(reqwest::Method::POST, &url, Some(payload))
            .await
    }

    /// Assigns (replaces) a project's issue type scheme.
    pub async fn assign_issue_type_scheme(
        &self,
        scheme_id: &str,
        project_id: &str,
    ) -> Result<(), String> {
        let url = self.cfg.jira_api_url("/issuetypescheme/project");
        self.expect_no_content(
            reqwest::Method::PUT,
            &url,
            Some(json!({ "issueTypeSchemeId": scheme_id, "projectId": project_id })),
        )
        .await
    }
}
