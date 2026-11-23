use std::env;

use base64::Engine;

#[derive(Clone)]
pub struct Config {
    pub jira_host: String,
    pub project_key: String,
    /// Precomputed Basic auth token: base64(username:api_token).
    pub auth: String,
    pub auto_create_test_tickets: bool,
    pub acceptance_criteria_field: String,
    pub product_field: Option<String>,
    pub product_value: Option<String>,
    pub product_id: Option<String>,
    pub category_field: Option<String>,
    pub use_alternate_category: bool,
    pub default_category_id: Option<String>,
    pub default_category_value: Option<String>,
    pub alternate_category_id: Option<String>,
    pub alternate_category_value: Option<String>,
    pub story_points_field: String,
    pub epic_link_field: String,
    pub crisis_field: String,
    pub crisis_yes_id: String,
    pub crisis_no_id: String,
    pub zapi_base_url: String,
    pub zapi_account_id: Option<String>,
    pub zapi_access_key: Option<String>,
    pub zapi_secret_key: Option<String>,
}

fn env_opt(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let jira_host = env_opt("JIRA_HOST")
            .ok_or("JIRA_HOST is not set (required: JIRA_HOST, JIRA_USERNAME, JIRA_API_TOKEN)")?;
        let username = env_opt("JIRA_USERNAME")
            .ok_or("JIRA_USERNAME is not set (required: JIRA_HOST, JIRA_USERNAME, JIRA_API_TOKEN)")?;
        let api_token = env_opt("JIRA_API_TOKEN")
            .ok_or("JIRA_API_TOKEN is not set (required: JIRA_HOST, JIRA_USERNAME, JIRA_API_TOKEN)")?;

        Ok(Self {
            jira_host,
            auth: base64::engine::general_purpose::STANDARD
                .encode(format!("{username}:{api_token}")),
            project_key: env_opt("JIRA_PROJECT_KEY").unwrap_or_else(|| "SCRUM".into()),
            auto_create_test_tickets: env::var("AUTO_CREATE_TEST_TICKETS").as_deref() != Ok("false"),
            acceptance_criteria_field: env_opt("JIRA_ACCEPTANCE_CRITERIA_FIELD")
                .unwrap_or_else(|| "customfield_10429".into()),
            product_field: env_opt("JIRA_PRODUCT_FIELD"),
            product_value: env_opt("JIRA_PRODUCT_VALUE"),
            product_id: env_opt("JIRA_PRODUCT_ID"),
            category_field: env_opt("JIRA_CATEGORY_FIELD"),
            use_alternate_category: env::var("USE_ALTERNATE_CATEGORY").as_deref() == Ok("true"),
            default_category_id: env_opt("JIRA_DEFAULT_CATEGORY_ID"),
            default_category_value: env_opt("JIRA_DEFAULT_CATEGORY_VALUE"),
            alternate_category_id: env_opt("JIRA_ALTERNATE_CATEGORY_ID"),
            alternate_category_value: env_opt("JIRA_ALTERNATE_CATEGORY_VALUE"),
            story_points_field: env_opt("JIRA_STORY_POINTS_FIELD")
                .unwrap_or_else(|| "customfield_10040".into()),
            epic_link_field: env_opt("JIRA_EPIC_LINK_FIELD")
                .unwrap_or_else(|| "customfield_10014".into()),
            crisis_field: env_opt("JIRA_CRISIS_FIELD")
                .unwrap_or_else(|| "customfield_14238".into()),
            crisis_yes_id: env_opt("JIRA_CRISIS_YES_ID").unwrap_or_else(|| "23123".into()),
            crisis_no_id: env_opt("JIRA_CRISIS_NO_ID").unwrap_or_else(|| "23124".into()),
            zapi_base_url: env_opt("ZAPI_BASE_URL")
                .unwrap_or_else(|| "https://prod-api.zephyr4jiracloud.com/connect".into()),
            zapi_account_id: env_opt("ZAPI_ACCOUNT_ID"),
            zapi_access_key: env_opt("ZAPI_ACCESS_KEY"),
            zapi_secret_key: env_opt("ZAPI_SECRET_KEY"),
        })
    }

    pub fn jira_api_url(&self, path: &str) -> String {
        format!("https://{}/rest/api/3{}", self.jira_host, path)
    }

    /// A Jira custom field option object as the v3 API expects select fields.
    pub fn option_object(&self, id: &str, value: &str) -> serde_json::Value {
        serde_json::json!({
            "self": format!("https://{}/rest/api/3/customFieldOption/{}", self.jira_host, id),
            "value": value,
            "id": id,
        })
    }
}
