// Atlassian Document Format (ADF) helpers: building doc bodies for the Jira
// v3 API and extracting plain text from ADF for display.

use serde_json::{json, Value};

fn doc(content: Value) -> Value {
    json!({ "type": "doc", "version": 1, "content": content })
}

fn text_paragraph(text: &str) -> Value {
    json!({
        "type": "paragraph",
        "content": [{ "type": "text", "text": text }],
    })
}

pub fn format_description(content: Option<&str>) -> Value {
    doc(json!([text_paragraph(
        content.unwrap_or("No description provided")
    )]))
}

/// Builds an ADF doc from criteria text. Lines starting with `-` or `*`
/// become bullet-list items, everything else becomes a paragraph.
/// (Mirrors the TS formatAcceptanceCriteria: each bullet gets its own
/// bulletList node.)
pub fn format_acceptance_criteria(criteria: Option<&str>) -> Value {
    let Some(criteria) = criteria else {
        return doc(json!([text_paragraph("No acceptance criteria provided")]));
    };

    let mut content = Vec::new();
    for line in criteria.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('-').or_else(|| line.strip_prefix('*')) {
            content.push(json!({
                "type": "bulletList",
                "content": [{
                    "type": "listItem",
                    "content": [{ "type": "paragraph", "content": [
                        { "type": "text", "text": rest.trim() },
                    ]}],
                }],
            }));
        } else {
            content.push(text_paragraph(line));
        }
    }

    doc(json!(content))
}

/// Extracts plain text from an ADF document (recursive), used to render
/// comment bodies as readable text in tool responses.
pub fn extract_text_from_adf(adf: &Value) -> String {
    if adf.is_null() {
        return String::new();
    }
    if let Some(s) = adf.as_str() {
        return s.to_string();
    }

    let ty = adf.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if ty == "text" {
        return adf
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
    }

    let Some(content) = adf.get("content").and_then(|c| c.as_array()) else {
        return String::new();
    };

    let parts: Vec<String> = content
        .iter()
        .map(extract_text_from_adf)
        .filter(|t| !t.is_empty())
        .collect();
    let joined: String = parts.join("");

    match ty {
        "paragraph" | "heading" => format!("{joined}\n"),
        "listItem" => format!("• {joined}\n"),
        "codeBlock" => format!("```\n{joined}\n```\n"),
        _ => joined,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bullets_become_bullet_lists() {
        let doc = format_acceptance_criteria(Some("- first\nplain\n* second\n"));
        let content = doc["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "bulletList");
        assert_eq!(
            content[0]["content"][0]["content"][0]["content"][0]["text"],
            "first"
        );
        assert_eq!(content[1]["type"], "paragraph");
        assert_eq!(content[1]["content"][0]["text"], "plain");
        assert_eq!(content[2]["type"], "bulletList");
        assert_eq!(content[2]["content"][0]["content"][0]["content"][0]["text"], "second");
    }

    #[test]
    fn empty_criteria_gets_default_paragraph() {
        let doc = format_acceptance_criteria(None);
        assert_eq!(
            doc["content"][0]["content"][0]["text"],
            "No acceptance criteria provided"
        );
    }

    #[test]
    fn extract_text_walks_lists_and_paragraphs() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "hello" }] },
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "item" }] },
                    ]},
                ]},
            ],
        });
        assert_eq!(extract_text_from_adf(&doc), "hello\n• item\n\n");
    }
}
