mod adf;
mod config;
mod jira;
mod tools;
mod zephyr;

use rmcp::{transport::stdio, ServiceExt};

#[tokio::main]
async fn main() {
    // Load .env from the working directory if present.
    match dotenvy::dotenv() {
        Ok(path) => eprintln!("[JIRA-MCP] .env loaded from {}", path.display()),
        Err(e) => eprintln!("[JIRA-MCP] No .env loaded ({e}); using environment variables"),
    }

    let server = match tools::JiraMcp::new() {
        Ok(server) => server,
        Err(e) => {
            eprintln!("[JIRA-MCP] Configuration error: {e}");
            std::process::exit(1);
        }
    };

    match server.serve(stdio()).await {
        Ok(service) => {
            if let Err(e) = service.waiting().await {
                eprintln!("[JIRA-MCP] Service error: {e}");
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("[JIRA-MCP] Failed to start server: {e}");
            std::process::exit(1);
        }
    }
}
