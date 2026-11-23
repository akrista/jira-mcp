// MCP tool definitions — a 1:1 port of the TS server (src/index.ts).

use serde::Deserialize;
use serde_json::{json, Value};
use schemars::JsonSchema;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ErrorData};
use rmcp::{tool, tool_handler, tool_router, ServerHandler};

use crate::adf;
use crate::jira::JiraApi;
use crate::zephyr;

type ToolResult = Result<CallToolResult, ErrorData>;

fn ok_text(text: impl Into<String>) -> ToolResult {
    Ok(CallToolResult::success(vec![ContentBlock::text(
        text.into(),
    )]))
}

#[derive(Debug, Deserialize, JsonSchema, Clone, Copy, Default, PartialEq)]
pub enum IssueType {
    Bug,
    #[default]
    Task,
    Story,
    Test,
    Epic,
}

impl IssueType {
    fn as_str(self) -> &'static str {
        match self {
            IssueType::Bug => "Bug",
            IssueType::Task => "Task",
            IssueType::Story => "Story",
            IssueType::Test => "Test",
            IssueType::Epic => "Epic",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema, Clone, Copy, PartialEq)]
pub enum YesNo {
    Yes,
    No,
}

impl YesNo {
    fn as_str(self) -> &'static str {
        match self {
            YesNo::Yes => "Yes",
            YesNo::No => "No",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema, Clone, Copy, Default, PartialEq)]
pub enum ProjectTypeKey {
    #[default]
    #[serde(rename = "software")]
    Software,
    #[serde(rename = "business")]
    Business,
    #[serde(rename = "service_desk")]
    ServiceDesk,
}

impl ProjectTypeKey {
    fn as_str(self) -> &'static str {
        match self {
            ProjectTypeKey::Software => "software",
            ProjectTypeKey::Business => "business",
            ProjectTypeKey::ServiceDesk => "service_desk",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema, Clone, Copy, Default, PartialEq)]
pub enum IssueTypeKind {
    #[default]
    #[serde(rename = "standard")]
    Standard,
    #[serde(rename = "subtask")]
    Subtask,
}

impl IssueTypeKind {
    fn as_str(self) -> &'static str {
        match self {
            IssueTypeKind::Standard => "standard",
            IssueTypeKind::Subtask => "subtask",
        }
    }
}

#[derive(Clone)]
pub struct JiraMcp {
    api: JiraApi,
}

#[tool_router]
impl JiraMcp {
    pub fn new() -> Result<Self, String> {
        let cfg = crate::config::Config::from_env()?;
        Ok(Self {
            api: JiraApi::new(cfg),
        })
    }

    // ----- create-ticket ----------------------------------------------------

    
    #[tool(name = "create-ticket", description = "Create a jira ticket")]    async fn create_ticket(
        &self,
        Parameters(p): Parameters<CreateTicketParams>,
    ) -> ToolResult {
        let cfg = &self.api.cfg;
        let issue_type = p.issue_type.unwrap_or(IssueType::Task);
        let project_key = p
            .project_key
            .clone()
            .unwrap_or_else(|| cfg.project_key.clone());

        let mut fields = json!({
            "project": { "key": project_key },
            "summary": p.summary,
            "description": adf::format_description(p.description.as_deref()),
            "issuetype": { "name": issue_type.as_str() },
        });

        // Acceptance criteria go into their custom field, not the description.
        if let Some(criteria) = &p.acceptance_criteria {
            eprintln!(
                "[JIRA-MCP] Adding acceptance criteria to field {}",
                cfg.acceptance_criteria_field
            );
            fields[&cfg.acceptance_criteria_field] =
                adf::format_acceptance_criteria(Some(criteria));
        }

        // Custom product/category fields only apply to Bug, Task and Story.
        if matches!(issue_type, IssueType::Bug | IssueType::Task | IssueType::Story) {
            if let (Some(pf), Some(pval), Some(pid)) =
                (&cfg.product_field, &cfg.product_value, &cfg.product_id)
            {
                eprintln!("[JIRA-MCP] Configuring product field {pf} with value {pval:?} and ID {pid:?}");
                fields[pf] = json!([cfg.option_object(pid, pval)]);
            } else if let Some(pf) = &cfg.product_field {
                eprintln!("[JIRA-MCP] Warning: product field {pf} is configured but missing JIRA_PRODUCT_VALUE or JIRA_PRODUCT_ID");
            }

            if let Some(cf) = &cfg.category_field {
                let (id, value) = if cfg.use_alternate_category {
                    (&cfg.alternate_category_id, &cfg.alternate_category_value)
                } else {
                    (&cfg.default_category_id, &cfg.default_category_value)
                };
                if let (Some(id), Some(value)) = (id, value) {
                    fields[cf] = cfg.option_object(id, value);
                }
            }
        }

        if let Some(points) = p.story_points
            && issue_type == IssueType::Story {
                fields[&cfg.story_points_field] = json!(points);
                fields["labels"] = json!(["QA-Testable"]);
            }

        if let Some(parent_epic) = &p.parent_epic {
            if issue_type == IssueType::Epic {
                fields["parent"] = json!({ "key": parent_epic });
            } else {
                fields[&cfg.epic_link_field] = json!(parent_epic);
            }
        }

        if let Some(sprint) = &p.sprint {
            fields["customfield_10020"] = json!([{ "name": sprint }]);
        }

        if let Some(readiness) = p.story_readiness {
            let id = if readiness == YesNo::Yes { "18256" } else { "18257" };
            fields["customfield_10596"] = cfg.option_object(id, readiness.as_str());
        }

        if let Some(crisis) = p.crisis {
            let id = if crisis == YesNo::Yes {
                cfg.crisis_yes_id.as_str()
            } else {
                cfg.crisis_no_id.as_str()
            };
            fields[&cfg.crisis_field] = cfg.option_object(id, crisis.as_str());
        }

        let result = self.api.create_issue(&json!({ "fields": fields })).await;
        let Ok(created) = result else {
            return ok_text(format!("Error creating ticket: {}", result.unwrap_err()));
        };

        let ticket_key = created.get("key").and_then(|k| k.as_str()).unwrap_or("");
        let mut response_text = format!(
            "Created ticket {} with summary: {}, description: {}, issue type: {}",
            ticket_key,
            p.summary,
            p.description.as_deref().unwrap_or("No description"),
            issue_type.as_str(),
        );
        if let Some(criteria) = &p.acceptance_criteria {
            response_text += format!(", acceptance criteria: {criteria}").as_str();
        }
        if let Some(points) = p.story_points {
            response_text += format!(", story points: {points}").as_str();
        }

        // Auto-create a linked Test ticket for stories with points.
        let should_create_test = p
            .create_test_ticket
            .unwrap_or(cfg.auto_create_test_tickets);
        if should_create_test
            && issue_type == IssueType::Story
            && p.story_points.is_some()
            && !ticket_key.is_empty()
        {
            let test_payload = json!({
                "fields": {
                    "project": { "key": cfg.project_key },
                    "summary": format!("{ticket_key} {}", p.summary),
                    "description": adf::format_description(Some(&p.summary)),
                    "issuetype": { "name": "Test" },
                },
            });

            match self.api.create_issue(&test_payload).await {
                Ok(test) => {
                    let test_key = test.get("key").and_then(|k| k.as_str()).unwrap_or("");
                    if test_key.is_empty() {
                        response_text += "\nFailed to create test ticket";
                    } else if let Err(e) =
                        self.api.create_link(ticket_key, test_key, "Test Case Linking").await
                    {
                        response_text +=
                            &format!("\nCreated test ticket {test_key} but failed to link it: {e}");
                    } else {
                        response_text += &format!("\nCreated linked test ticket {test_key}");
                    }
                }
                Err(e) => response_text += format!("\nFailed to create test ticket: {e}").as_str(),
            }
        }

        ok_text(response_text)
    }

    // ----- link-tickets -----------------------------------------------------

    
    #[tool(name = "link-tickets", description = "Link two jira tickets")]    async fn link_tickets(&self, Parameters(p): Parameters<LinkTicketsParams>) -> ToolResult {
        let link_type = p.link_type.unwrap_or_else(|| "Test Case Linking".into());
        match self
            .api
            .create_link(&p.outward_issue, &p.inward_issue, &link_type)
            .await
        {
            Ok(()) => ok_text(format!(
                "Successfully linked {} to {} with link type \"{}\"",
                p.outward_issue, p.inward_issue, link_type
            )),
            Err(e) => ok_text(format!("Error linking tickets: {e}")),
        }
    }

    // ----- get-ticket -------------------------------------------------------

    
    #[tool(name = "get-ticket", description = "Get a jira ticket")]    async fn get_ticket(&self, Parameters(p): Parameters<TicketKeyParams>) -> ToolResult {
        match self.api.get_issue(&p.ticket_key).await {
            Ok(data) => {
                let Some(fields) = data.get("fields") else {
                    return ok_text("Error: No ticket fields found in response");
                };
                ok_text(format!(
                    "JIRA Ticket: {}, Fields: {}",
                    p.ticket_key,
                    serde_json::to_string_pretty(fields).unwrap_or_default()
                ))
            }
            Err(e) => ok_text(format!("Error fetching ticket: {e}")),
        }
    }

    // ----- search-tickets ---------------------------------------------------

    
    #[tool(name = "search-tickets", description = "Search for jira tickets by issue type")]    async fn search_tickets(&self, Parameters(p): Parameters<SearchTicketsParams>) -> ToolResult {
        let issue_type = p.issue_type;
        let max_results = p.max_results.unwrap_or(10);
        let mut jql = format!(
            "project = \"{}\" AND issuetype = \"{}\"",
            self.api.cfg.project_key,
            issue_type.as_str()
        );
        if let Some(criteria) = &p.additional_criteria {
            jql += &format!(" AND ({criteria})");
        }

        match self.api.search(&jql, max_results).await {
            Ok(data) => {
                let Some(issues) = data.get("issues").and_then(|i| i.as_array()) else {
                    return ok_text(format!(
                        "No {issue_type:?} tickets found matching the criteria."
                    ));
                };
                if issues.is_empty() {
                    return ok_text(format!(
                        "No {} tickets found matching the criteria.",
                        issue_type.as_str()
                    ));
                }
                let tickets: Vec<Value> = issues
                    .iter()
                    .map(|i| {
                        json!({
                            "key": i["key"],
                            "summary": i["fields"]["summary"],
                            "status": i["fields"]["status"]["name"].as_str().unwrap_or("Unknown"),
                            "priority": i["fields"]["priority"]["name"].as_str().unwrap_or("Unknown"),
                        })
                    })
                    .collect();
                ok_text(format!(
                    "Found {} {} tickets (showing {}):\n\n{}",
                    data.get("total").and_then(|t| t.as_u64()).unwrap_or(tickets.len() as u64),
                    issue_type.as_str(),
                    tickets.len(),
                    serde_json::to_string_pretty(&tickets).unwrap_or_default(),
                ))
            }
            Err(e) => ok_text(format!("Error searching tickets: {e}")),
        }
    }

    // ----- search-tickets-jql ------------------------------------------------

    
    #[tool(name = "search-tickets-jql", description = "Search for jira tickets using custom JQL query")]    async fn search_tickets_jql(
        &self,
        Parameters(p): Parameters<SearchJqlParams>,
    ) -> ToolResult {
        let max_results = p.max_results.unwrap_or(10);
        match self.api.search(&p.jql, max_results).await {
            Ok(data) => {
                let Some(issues) = data.get("issues").and_then(|i| i.as_array()) else {
                    return ok_text(format!(
                        "No tickets found matching the JQL query: {}",
                        p.jql
                    ));
                };
                if issues.is_empty() {
                    return ok_text(format!(
                        "No tickets found matching the JQL query: {}",
                        p.jql
                    ));
                }
                let tickets: Vec<Value> = issues
                    .iter()
                    .map(|i| {
                        json!({
                            "key": i["key"],
                            "summary": i["fields"]["summary"],
                            "status": i["fields"]["status"]["name"].as_str().unwrap_or("Unknown"),
                            "priority": i["fields"]["priority"]["name"].as_str().unwrap_or("Unknown"),
                            "issuetype": i["fields"]["issuetype"]["name"].as_str().unwrap_or("Unknown"),
                            "description": if i["fields"]["description"].is_null() {
                                json!("No description")
                            } else {
                                i["fields"]["description"].clone()
                            },
                        })
                    })
                    .collect();
                ok_text(format!(
                    "Found {} ticket(s) (showing {}):\n\n{}",
                    data.get("total")
                        .and_then(|t| t.as_u64())
                        .unwrap_or(tickets.len() as u64),
                    tickets.len(),
                    serde_json::to_string_pretty(&tickets).unwrap_or_default(),
                ))
            }
            Err(e) => ok_text(format!("Error searching tickets: {e}")),
        }
    }

    // ----- update-ticket ----------------------------------------------------

    
    #[tool(name = "update-ticket", description = "Update an existing jira ticket")]    async fn update_ticket(&self, Parameters(p): Parameters<UpdateTicketParams>) -> ToolResult {
        let cfg = &self.api.cfg;
        let mut fields = json!({});

        if let Some(sprint) = &p.sprint {
            fields["customfield_10020"] = json!([{ "name": sprint }]);
        }
        if let Some(readiness) = p.story_readiness {
            let id = if readiness == YesNo::Yes { "18256" } else { "18257" };
            fields["customfield_10596"] = cfg.option_object(id, readiness.as_str());
        }

        if fields.as_object().map(|o| o.is_empty()).unwrap_or(true) {
            return ok_text("Error: At least one field to update must be provided");
        }

        match self.api.update_issue(&p.ticket_key, &json!({ "fields": fields })).await {
            Ok(()) => {
                let mut text = format!("Successfully updated ticket {}", p.ticket_key);
                if let Some(sprint) = &p.sprint {
                    text += &format!(", sprint: {sprint}");
                }
                if let Some(readiness) = p.story_readiness {
                    text += &format!(", story readiness: {}", readiness.as_str());
                }
                ok_text(text)
            }
            Err(e) => ok_text(format!("Error updating ticket: {e}")),
        }
    }

    // ----- get-test-steps ----------------------------------------------------

    
    #[tool(name = "get-test-steps", description = "Get test steps from a test ticket via Zephyr integration")]    async fn get_test_steps(&self, Parameters(p): Parameters<TicketKeyParams>) -> ToolResult {
        let (issue_id, project_id) = match self.api.get_issue_ids(&p.ticket_key).await {
            Ok(v) => v,
            Err(e) => {
                return ok_text(format!(
                    "Error getting internal ID for ticket {}: {e}",
                    p.ticket_key
                ))
            }
        };
        eprintln!("[JIRA-MCP] Found internal ID for ticket {}: {issue_id}", p.ticket_key);

        let Some(project_id) = project_id else {
            return ok_text(format!(
                "Error: Project ID not found for ticket {}",
                p.ticket_key
            ));
        };

        match zephyr::get_test_steps(&self.api, &issue_id, &project_id).await {
            Ok(steps) if steps.is_empty() => {
                ok_text(format!("No test steps found for ticket {}.", p.ticket_key))
            }
            Ok(steps) => {
                let formatted: Vec<Value> = steps
                    .iter()
                    .map(|s| {
                        json!({
                            "id": s["id"],
                            "orderId": s["orderId"],
                            "step": s["step"],
                            "data": s["data"].as_str().unwrap_or(""),
                            "result": s["result"].as_str().unwrap_or(""),
                        })
                    })
                    .collect();
                ok_text(format!(
                    "Found {} test step(s) for ticket {}:\n\n{}",
                    formatted.len(),
                    p.ticket_key,
                    serde_json::to_string_pretty(&formatted).unwrap_or_default(),
                ))
            }
            Err(e) => ok_text(format!(
                "Error getting test steps for ticket {}: {e}",
                p.ticket_key
            )),
        }
    }

    // ----- add-test-steps ----------------------------------------------------

    
    #[tool(name = "add-test-steps", description = "Add test steps to a test ticket via Zephyr integration")]    async fn add_test_steps(&self, Parameters(p): Parameters<AddTestStepsParams>) -> ToolResult {
        let (issue_id, project_id) = match self.api.get_issue_ids(&p.ticket_key).await {
            Ok(v) => v,
            Err(e) => {
                return ok_text(format!(
                    "Error getting internal ID for ticket {}: {e}",
                    p.ticket_key
                ))
            }
        };
        eprintln!("[JIRA-MCP] Found internal ID for ticket {}: {issue_id}", p.ticket_key);

        let Some(project_id) = project_id else {
            return ok_text(format!(
                "Error: Project ID not found for ticket {}",
                p.ticket_key
            ));
        };

        let mut results = Vec::new();
        let mut all_successful = true;
        for (index, step) in p.steps.iter().enumerate() {
            let data = step.data.as_deref().unwrap_or("");
            let result = step.result.as_deref().unwrap_or("");
            match zephyr::add_test_step(&self.api, &issue_id, &project_id, &step.step, data, result)
                .await
            {
                Ok(_) => results.push(format!("Step {}: Added successfully", index + 1)),
                Err(e) => {
                    results.push(format!("Step {}: Failed - {e}", index + 1));
                    all_successful = false;
                }
            }
        }

        if all_successful {
            ok_text(format!(
                "Successfully added {} test step(s) to ticket {}:\n\n{}",
                p.steps.len(),
                p.ticket_key,
                results.join("\n")
            ))
        } else {
            ok_text(format!(
                "Some test steps could not be added to ticket {}:\n\n{}",
                p.ticket_key,
                results.join("\n")
            ))
        }
    }

    // ----- add-comment --------------------------------------------------------

    
    #[tool(name = "add-comment", description = "Add a comment to a JIRA ticket")]    async fn add_comment(&self, Parameters(p): Parameters<AddCommentParams>) -> ToolResult {
        match self
            .api
            .add_comment(&p.ticket_key, adf::format_description(Some(&p.comment)))
            .await
        {
            Ok(_) => ok_text(format!("Successfully added comment to {}", p.ticket_key)),
            Err(e) => ok_text(format!("Error adding comment: {e}")),
        }
    }

    // ----- list-comments ------------------------------------------------------

    
    #[tool(name = "list-comments", description = "List comments on a JIRA ticket")]    async fn list_comments(&self, Parameters(p): Parameters<ListCommentsParams>) -> ToolResult {
        let max_results = p.max_results.unwrap_or(20);
        let data = match self.api.list_comments(&p.ticket_key, max_results).await {
            Ok(data) => data,
            Err(e) => return ok_text(format!("Error getting comments: {e}")),
        };

        let Some(comments) = data.get("comments").and_then(|c| c.as_array()) else {
            return ok_text(format!("No comments found on {}", p.ticket_key));
        };
        if comments.is_empty() {
            return ok_text(format!("No comments found on {}", p.ticket_key));
        }

        let formatted: Vec<Value> = comments
            .iter()
            .map(|c| {
                json!({
                    "id": c["id"],
                    "author": c["author"]["displayName"],
                    "created": c["created"],
                    "body": adf::extract_text_from_adf(&c["body"]).trim(),
                })
            })
            .collect();

        ok_text(format!(
            "Found {} comments on {}:\n\n{}",
            data.get("total")
                .and_then(|t| t.as_u64())
                .unwrap_or(comments.len() as u64),
            p.ticket_key,
            serde_json::to_string_pretty(&formatted).unwrap_or_default(),
        ))
    }

    // ----- transition-ticket ---------------------------------------------------

    
    #[tool(name = "transition-ticket", description = "Transition a JIRA ticket to a different status")]    async fn transition_ticket(&self, Parameters(p): Parameters<TransitionParams>) -> ToolResult {
        let data = match self.api.get_transitions(&p.ticket_key).await {
            Ok(data) => data,
            Err(e) => return ok_text(format!("Error getting transitions: {e}")),
        };

        let transitions = data
            .get("transitions")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        if p.list_transitions == Some(true) {
            let list: Vec<Value> = transitions
                .iter()
                .map(|t| {
                    json!({ "id": t["id"], "name": t["name"], "to": t["to"]["name"] })
                })
                .collect();
            return ok_text(format!(
                "Available transitions for {}:\n\n{}",
                p.ticket_key,
                serde_json::to_string_pretty(&list).unwrap_or_default()
            ));
        }

        let target = if let Some(id) = &p.transition_id {
            transitions
                .iter()
                .find(|t| t["id"].as_str() == Some(id.as_str()))
        } else if let Some(name) = &p.transition_name {
            transitions
                .iter()
                .find(|t| t["name"].as_str().map(|n| n.eq_ignore_ascii_case(name)) == Some(true))
        } else {
            return ok_text("Error: Either transition_name or transition_id is required (or use list_transitions to see available options)");
        };

        let Some(target) = target else {
            let available = transitions
                .iter()
                .filter_map(|t| {
                    t["name"].as_str().map(|n| format!("\"{n}\" (id: {})", t["id"].as_str().unwrap_or("?")))
                })
                .collect::<Vec<_>>()
                .join(", ");
            return ok_text(format!(
                "Error: Transition not found. Available transitions: {available}"
            ));
        };

        let transition_id = target["id"].as_str().unwrap_or("").to_string();
        let to_status = target["to"]["name"].as_str().unwrap_or("").to_string();
        let comment_body = p
            .comment
            .as_deref()
            .map(|c| adf::format_description(Some(c)));

        match self
            .api
            .do_transition(&p.ticket_key, &transition_id, comment_body)
            .await
        {
            Ok(()) => {
                let mut text =
                    format!("Successfully transitioned {} to \"{to_status}\"", p.ticket_key);
                if p.comment.is_some() {
                    text += " with comment";
                }
                ok_text(text)
            }
            Err(e) => ok_text(format!("Error transitioning ticket: {e}")),
        }
    }

    // ----- assign-ticket -------------------------------------------------------

    
    #[tool(name = "assign-ticket", description = "Assign or unassign a JIRA ticket")]    async fn assign_ticket(&self, Parameters(p): Parameters<AssignParams>) -> ToolResult {
        match self.api.assign(&p.ticket_key, p.account_id.as_deref()).await {
            Ok(()) => {
                let action = p
                    .account_id
                    .as_deref()
                    .map(|a| format!("assigned to {a}"))
                    .unwrap_or_else(|| "unassigned".into());
                ok_text(format!("Successfully {action} ticket {}", p.ticket_key))
            }
            Err(e) => ok_text(format!("Error assigning ticket: {e}")),
        }
    }

    // ----- add-watcher / remove-watcher ----------------------------------------

    
    #[tool(name = "add-watcher", description = "Add a watcher to a JIRA ticket")]    async fn add_watcher(&self, Parameters(p): Parameters<WatcherParams>) -> ToolResult {
        match self.api.add_watcher(&p.ticket_key, &p.account_id).await {
            Ok(()) => ok_text(format!(
                "Successfully added {} as watcher to {}",
                p.account_id, p.ticket_key
            )),
            Err(e) => ok_text(format!("Error adding watcher: {e}")),
        }
    }

    
    #[tool(name = "remove-watcher", description = "Remove a watcher from a JIRA ticket")]    async fn remove_watcher(&self, Parameters(p): Parameters<WatcherParams>) -> ToolResult {
        match self.api.remove_watcher(&p.ticket_key, &p.account_id).await {
            Ok(()) => ok_text(format!(
                "Successfully removed {} as watcher from {}",
                p.account_id, p.ticket_key
            )),
            Err(e) => ok_text(format!("Error removing watcher: {e}")),
        }
    }

    // ----- create-project --------------------------------------------------------

    
    #[tool(name = "create-project", description = "Create a new JIRA project (requires Jira admin permissions). Creates a real, shared project on your Jira site — confirm the key, template, and lead before running this.")]    async fn create_project(&self, Parameters(p): Parameters<CreateProjectParams>) -> ToolResult {
        if !p
            .key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase())
            || !(p.key.len() >= 2
                && p.key.len() <= 10
                && p.key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
        {
            return ok_text("Error: Project key must be 2-10 uppercase letters/digits, starting with a letter (e.g. DBSAN)");
        }

        let mut payload = json!({
            "key": p.key,
            "name": p.name,
            "projectTypeKey": p.project_type_key.as_str(),
            "projectTemplateKey": p.project_template_key,
        });
        if let Some(description) = &p.description {
            payload["description"] = json!(description);
        }
        if let Some(lead) = &p.lead_account_id {
            payload["leadAccountId"] = json!(lead);
        }
        if let Some(assignee) = p.assignee_type {
            payload["assigneeType"] = json!(assignee.as_str());
        }
        if let Some(url) = &p.url {
            payload["url"] = json!(url);
        }

        match self.api.create_project(payload).await {
            Ok(data) => ok_text(format!(
                "Created project {} (id: {}) with name \"{}\"",
                data.get("key").and_then(|k| k.as_str()).unwrap_or("?"),
                data.get("id").and_then(|i| i.as_str()).unwrap_or("?"),
                p.name
            )),
            Err(e) => ok_text(format!("Error creating project: {e}")),
        }
    }

    // ----- create-issue-type -------------------------------------------------------

    
    #[tool(name = "create-issue-type", description = "Create a new global JIRA issue type (requires Jira admin permissions). The issue type is created instance-wide; add it to an issue type scheme to make it available on a specific project.")]    async fn create_issue_type(&self, Parameters(p): Parameters<CreateIssueTypeParams>) -> ToolResult {
        let mut payload = json!({
            "name": p.name,
            "type": p.r#type.unwrap_or_default().as_str(),
        });
        if let Some(description) = &p.description {
            payload["description"] = json!(description);
        }

        match self.api.create_issue_type(payload).await {
            Ok(data) => ok_text(format!(
                "Created issue type \"{}\" (id: {})",
                data.get("name").and_then(|n| n.as_str()).unwrap_or("?"),
                data.get("id").and_then(|i| i.as_str()).unwrap_or("?")
            )),
            Err(e) => ok_text(format!("Error creating issue type: {e}")),
        }
    }

    // ----- create-issuetype-scheme --------------------------------------------------

    
    #[tool(name = "create-issuetype-scheme", description = "Create a JIRA issue type scheme, a named set of issue types that can be assigned to a project (requires Jira admin permissions; company-managed projects only). Use create-issue-type first to get issue type IDs.")]    async fn create_issuetype_scheme(
        &self,
        Parameters(p): Parameters<CreateSchemeParams>,
    ) -> ToolResult {
        if let Some(default_id) = &p.default_issue_type_id
            && !p.issue_type_ids.contains(default_id) {
                return ok_text(
                    "Error: default_issue_type_id must be one of the provided issue_type_ids",
                );
            }

        let mut payload = json!({
            "name": p.name,
            "issueTypeIds": p.issue_type_ids,
        });
        if let Some(description) = &p.description {
            payload["description"] = json!(description);
        }
        if let Some(default_id) = &p.default_issue_type_id {
            payload["defaultIssueTypeId"] = json!(default_id);
        }

        match self.api.create_issue_type_scheme(payload).await {
            Ok(data) => ok_text(format!(
                "Created issue type scheme \"{}\" (id: {})",
                p.name,
                data.get("issueTypeSchemeId")
                    .and_then(|i| i.as_str())
                    .unwrap_or("?")
            )),
            Err(e) => ok_text(format!("Error creating issue type scheme: {e}")),
        }
    }

    // ----- assign-issuetype-scheme ---------------------------------------------------

    
    #[tool(name = "assign-issuetype-scheme", description = "Assign (replace) the issue type scheme for a JIRA project (requires Jira admin permissions; company-managed projects only). Fails if the project has issues using types not present in the new scheme.")]    async fn assign_issuetype_scheme(
        &self,
        Parameters(p): Parameters<AssignSchemeParams>,
    ) -> ToolResult {
        let project = match self.api.get_project(&p.project_key_or_id).await {
            Ok(data) => data,
            Err(e) => {
                return ok_text(format!(
                    "Error resolving project \"{}\": {e}",
                    p.project_key_or_id
                ))
            }
        };
        let Some(project_id) = project.get("id").and_then(|i| i.as_str()) else {
            return ok_text(format!(
                "Error resolving project \"{}\": no project id in response",
                p.project_key_or_id
            ));
        };

        match self
            .api
            .assign_issue_type_scheme(&p.issue_type_scheme_id, project_id)
            .await
        {
            Ok(()) => ok_text(format!(
                "Assigned issue type scheme {} to project {} (id: {project_id})",
                p.issue_type_scheme_id, p.project_key_or_id
            )),
            Err(e) => ok_text(format!("Error assigning issue type scheme: {e}")),
        }
    }
}

// ----- Parameter types -------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct CreateTicketParams {
    #[schemars(length(min = 1))]
    summary: String,
    issue_type: Option<IssueType>,
    description: Option<String>,
    acceptance_criteria: Option<String>,
    story_points: Option<f64>,
    create_test_ticket: Option<bool>,
    parent_epic: Option<String>,
    sprint: Option<String>,
    story_readiness: Option<YesNo>,
    project_key: Option<String>,
    crisis: Option<YesNo>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct LinkTicketsParams {
    #[schemars(length(min = 1))]
    outward_issue: String,
    #[schemars(length(min = 1))]
    inward_issue: String,
    #[schemars(length(min = 1))]
    link_type: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct TicketKeyParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct SearchTicketsParams {
    issue_type: IssueType,
    max_results: Option<u32>,
    additional_criteria: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct SearchJqlParams {
    #[schemars(length(min = 1))]
    jql: String,
    max_results: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct UpdateTicketParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
    sprint: Option<String>,
    story_readiness: Option<YesNo>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct TestStep {
    #[schemars(length(min = 1))]
    step: String,
    data: Option<String>,
    result: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct AddTestStepsParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
    #[schemars(length(min = 1))]
    steps: Vec<TestStep>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct AddCommentParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
    #[schemars(length(min = 1))]
    comment: String,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct ListCommentsParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
    max_results: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct TransitionParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
    transition_name: Option<String>,
    transition_id: Option<String>,
    list_transitions: Option<bool>,
    comment: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct AssignParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct WatcherParams {
    #[schemars(length(min = 1))]
    ticket_key: String,
    #[schemars(length(min = 1))]
    account_id: String,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct CreateProjectParams {
    key: String,
    #[schemars(length(min = 1))]
    name: String,
    project_type_key: ProjectTypeKey,
    #[schemars(length(min = 1))]
    project_template_key: String,
    description: Option<String>,
    lead_account_id: Option<String>,
    assignee_type: Option<AssigneeType>,
    url: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema, Clone, Copy, PartialEq)]
enum AssigneeType {
    #[serde(rename = "PROJECT_LEAD")]
    ProjectLead,
    #[serde(rename = "UNASSIGNED")]
    Unassigned,
}

impl AssigneeType {
    fn as_str(self) -> &'static str {
        match self {
            AssigneeType::ProjectLead => "PROJECT_LEAD",
            AssigneeType::Unassigned => "UNASSIGNED",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct CreateIssueTypeParams {
    #[schemars(length(min = 1))]
    name: String,
    description: Option<String>,
    r#type: Option<IssueTypeKind>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct CreateSchemeParams {
    #[schemars(length(min = 1))]
    name: String,
    description: Option<String>,
    #[schemars(length(min = 1))]
    issue_type_ids: Vec<String>,
    default_issue_type_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema, Default)]
struct AssignSchemeParams {
    #[schemars(length(min = 1))]
    issue_type_scheme_id: String,
    #[schemars(length(min = 1))]
    project_key_or_id: String,
}

#[tool_handler(name = "jira-mcp", version = "1.1.0")]
impl ServerHandler for JiraMcp {}
