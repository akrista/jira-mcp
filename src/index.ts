#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project root (parent of src or build directory)
const envPath = path.resolve(__dirname, "..", ".env");
console.error(`[JIRA-MCP] Loading .env from: ${envPath}`);
const result = dotenv.config({ path: envPath });
if (result.error) {
  if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
    console.error(`[JIRA-MCP] No .env file found at: ${envPath} (using environment variables)`);
  } else {
    console.error(`[JIRA-MCP] Error loading .env:`, result.error);
  }
} else {
  console.error(`[JIRA-MCP] .env loaded successfully`);
}
console.error(`[JIRA-MCP] JIRA_HOST: ${process.env.JIRA_HOST || 'NOT SET'}`);
console.error(`[JIRA-MCP] JIRA_USERNAME: ${process.env.JIRA_USERNAME ? 'SET' : 'NOT SET'}`);
console.error(`[JIRA-MCP] JIRA_API_TOKEN: ${process.env.JIRA_API_TOKEN ? 'SET' : 'NOT SET'}`);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { updateJiraTicket } from "./update-ticket.js";
import { getZephyrTestSteps } from "./get-zephyr-test-steps.js";
import {
  createJiraProject,
  getJiraProject,
  createJiraIssueType,
  createJiraIssueTypeScheme,
  assignJiraIssueTypeScheme,
} from "./jira-admin.js";
import {
  addJiraComment,
  getJiraComments,
  getJiraTransitions,
  transitionJiraTicket,
  assignJiraTicket,
  addJiraWatcher,
  removeJiraWatcher,
  extractTextFromAdf,
} from "./jira-collab.js";

// Define types for JIRA and Zephyr responses
type JiraCreateResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
  key?: string;
  id?: string;
};

type JiraGetResponse = {
  errorMessages?: string[];
  id?: string; // Internal Jira ID
  fields?: {
    summary: string;
    description?: any;
    issuetype: {
      name: string;
    };
    status?: {
      name: string;
    };
    priority?: {
      name: string;
    };
    [key: string]: any; // Allow for custom fields
  };
  [key: string]: any;
};

type JiraSearchResponse = {
  errorMessages?: string[];
  issues?: Array<{
    key: string;
    fields: {
      summary: string;
      description?: any;
      issuetype: {
        name: string;
      };
      status?: {
        name: string;
      };
      priority?: {
        name: string;
      };
      [key: string]: any; // Allow for custom fields
    };
  }>;
  // Legacy pagination fields (may still be present for backward compatibility)
  total?: number;
  maxResults?: number;
  startAt?: number;
  // New pagination fields for /search/jql endpoint
  isLast?: boolean;
  nextPageToken?: string;
};

type ZephyrAddTestStepResponse = {
  id?: number;
  orderId?: number;
  step?: string;
  data?: string;
  result?: string;
  [key: string]: any;
};

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});

// Helper function to generate a JWT token for Zephyr API
function generateZephyrJwt(
  method: string,
  apiPath: string,
  queryParams: Record<string, string> = {},
  expirationSec: number = 3600
): string {
  // Sort query parameters alphabetically
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((key) => `${key}=${queryParams[key]}`)
    .join("&");

  // Build the canonical string: METHOD&<path>&<query>
  const canonical = `${method.toUpperCase()}&${apiPath}&${canonicalQuery}`;

  // Create SHA-256 hex hash of canonical string
  const qsh = crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");

  // Timestamps
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expirationSec;

  // JWT claims
  const payload = {
    sub: process.env.ZAPI_ACCOUNT_ID, // Atlassian account ID
    iss: process.env.ZAPI_ACCESS_KEY, // Zephyr Access Key
    qsh, // query-string hash
    iat: now,
    exp,
  };

  // Sign with HMAC-SHA256 using Zephyr Secret Key
  return jwt.sign(payload, process.env.ZAPI_SECRET_KEY || "", {
    algorithm: "HS256",
  });
}

// Helper function to add a test step to a Zephyr test
async function addZephyrTestStep(
  issueId: string,
  projectId: string,
  step: string,
  data: string = "",
  result: string = ""
): Promise<{
  success: boolean;
  data?: ZephyrAddTestStepResponse;
  errorMessage?: string;
}> {
  // Zephyr base URL from environment variable
  const baseUrl =
    process.env.ZAPI_BASE_URL ||
    "https://prod-api.zephyr4jiracloud.com/connect";
  // Use the correct API endpoint format for Zephyr Squad Cloud
  const apiPath = `/public/rest/api/1.0/teststep/${issueId}`;

  // Query parameters
  const queryParams = { projectId };

  // Build the query string
  const queryString = Object.keys(queryParams)
    .map((key) => `${key}=${queryParams[key as keyof typeof queryParams]}`)
    .join("&");

  // Full URL with query parameters
  const fullUrl = `${baseUrl}${apiPath}?${queryString}`;

  console.log("Zephyr URL:", fullUrl);
  console.log(
    "Zephyr Payload:",
    JSON.stringify({ projectId, step, data, result }, null, 2)
  );

  try {
    // Generate JWT for this specific API call with query parameters
    const jwtToken = generateZephyrJwt("POST", apiPath, queryParams);

    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        zapiAccessKey: process.env.ZAPI_ACCESS_KEY || "",
        Authorization: `JWT ${jwtToken}`,
      },
      body: JSON.stringify({ projectId, step, data, result }),
    });

    const responseData = (await response.json()) as ZephyrAddTestStepResponse;

    if (!response.ok) {
      console.error(
        "Error adding test step:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      return {
        success: false,
        data: responseData,
        errorMessage: `Status: ${response.status} ${response.statusText}`,
      };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception adding test step:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Auto-create test tickets setting
const autoCreateTestTickets = process.env.AUTO_CREATE_TEST_TICKETS !== "false";

// Create server instance
const server = new McpServer({
  name: "jira-mcp",
  version: "1.0.0",
});

// Helper function to format text content for JIRA API v3
function formatJiraContent(
  content: string | undefined,
  defaultText: string = "No content provided"
) {
  return content
    ? {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: content,
              },
            ],
          },
        ],
      }
    : {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: defaultText,
              },
            ],
          },
        ],
      };
}

// Helper function to format description for JIRA API v3
function formatDescription(description: string | undefined) {
  return formatJiraContent(description, "No description provided");
}

// Helper function to format acceptance criteria for JIRA API v3
function formatAcceptanceCriteria(criteria: string | undefined) {
  // Check if criteria is undefined or empty
  if (!criteria) {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "No acceptance criteria provided",
            },
          ],
        },
      ],
    };
  }

  // Split criteria by newlines to handle bullet points properly
  const lines = criteria.split("\n");
  const content = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines
    if (!trimmedLine) continue;

    // Check if line is a bullet point
    if (trimmedLine.startsWith("-") || trimmedLine.startsWith("*")) {
      content.push({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: trimmedLine.substring(1).trim(),
                  },
                ],
              },
            ],
          },
        ],
      });
    } else {
      // Regular paragraph
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: trimmedLine,
          },
        ],
      });
    }
  }

  return {
    type: "doc",
    version: 1,
    content: content,
  };
}

// Helper function to create a JIRA ticket
async function createJiraTicket(
  payload: any,
  auth: string
): Promise<{
  success: boolean;
  data: JiraCreateResponse;
  errorMessage?: string;
}> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue`;

  console.log("JIRA URL:", jiraUrl);
  console.log("JIRA Payload:", JSON.stringify(payload, null, 2));
  console.log("JIRA Auth:", `Basic ${auth.substring(0, 10)}...`);
  console.log("JIRA Project Key:", process.env.JIRA_PROJECT_KEY);

  try {
    const response = await fetch(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = (await response.json()) as JiraCreateResponse;

    if (!response.ok) {
      console.error(
        "Error creating ticket:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      // Check if it's a custom field validation error
      if (response.status === 400 && responseData.errors) {
        const productField = process.env.JIRA_PRODUCT_FIELD;
        const categoryField = process.env.JIRA_CATEGORY_FIELD;

        // Check if the error is related to product field
        const hasProductFieldError = productField && responseData.errors[productField];
        const hasCategoryFieldError = categoryField && responseData.errors[categoryField];

        // Handle required product field error specially
        if (hasProductFieldError) {
          const errorMessage = responseData.errors[productField];
          console.log(`Product field error: ${errorMessage}`);

          // Try alternative formats for the product field
          const productValue = process.env.JIRA_PRODUCT_VALUE;
          const productId = process.env.JIRA_PRODUCT_ID;

          if (productValue && productId) {
            console.log("Retrying with alternative product field formats...");

            // Try format 1: Just the ID as string
            let retryPayload = JSON.parse(JSON.stringify(payload));
            retryPayload.fields[productField] = productId;

            let retryResponse = await fetch(jiraUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Basic ${auth}`,
              },
              body: JSON.stringify(retryPayload),
            });

            if (retryResponse.ok) {
              const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;
              console.log("Ticket created successfully with product field as ID string");
              return { success: true, data: retryResponseData };
            }

            // Try format 2: Array with just ID
            retryPayload = JSON.parse(JSON.stringify(payload));
            retryPayload.fields[productField] = [{ id: productId }];

            retryResponse = await fetch(jiraUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Basic ${auth}`,
              },
              body: JSON.stringify(retryPayload),
            });

            if (retryResponse.ok) {
              const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;
              console.log("Ticket created successfully with product field as array with ID");
              return { success: true, data: retryResponseData };
            }

            // Try format 3: Array with just value
            retryPayload = JSON.parse(JSON.stringify(payload));
            retryPayload.fields[productField] = [{ value: productValue }];

            retryResponse = await fetch(jiraUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Basic ${auth}`,
              },
              body: JSON.stringify(retryPayload),
            });

            if (retryResponse.ok) {
              const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;
              console.log("Ticket created successfully with product field as array with value");
              return { success: true, data: retryResponseData };
            }

            console.log("All product field format retries failed");
          }

          // If all retries fail and it's a required field, return helpful error
          if (errorMessage.toLowerCase().includes('required')) {
            console.error(`Required product field ${productField} validation failed with all formats.`);
            console.error('Current configuration:');
            console.error('- JIRA_PRODUCT_FIELD:', process.env.JIRA_PRODUCT_FIELD);
            console.error('- JIRA_PRODUCT_VALUE:', process.env.JIRA_PRODUCT_VALUE);
            console.error('- JIRA_PRODUCT_ID:', process.env.JIRA_PRODUCT_ID);

            return {
              success: false,
              data: responseData,
              errorMessage: `Required field validation failed: ${errorMessage}. The product ID "${productId}" or value "${productValue}" may be invalid for your JIRA instance.`
            };
          }
        }

        // For non-required field errors, try removing them
        if ((hasProductFieldError && !responseData.errors[productField].toLowerCase().includes('required')) || hasCategoryFieldError) {
          console.log("Retrying ticket creation without problematic custom fields...");

          // Create a new payload without the problematic custom fields
          const retryPayload = JSON.parse(JSON.stringify(payload));

          if (hasProductFieldError && !responseData.errors[productField].toLowerCase().includes('required')) {
            delete retryPayload.fields[productField];
            console.log(`Removed problematic product field: ${productField}`);
          }

          if (hasCategoryFieldError) {
            delete retryPayload.fields[categoryField];
            console.log(`Removed problematic category field: ${categoryField}`);
          }

          // Retry the request
          const retryResponse = await fetch(jiraUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
            body: JSON.stringify(retryPayload),
          });

          const retryResponseData = (await retryResponse.json()) as JiraCreateResponse;

          if (retryResponse.ok) {
            console.log("Ticket created successfully after removing problematic custom fields");
            return { success: true, data: retryResponseData };
          } else {
            console.error("Retry also failed:", JSON.stringify(retryResponseData, null, 2));
          }
        }
      }

      // Try to extract more detailed error information
      let errorMessage = `Status: ${response.status} ${response.statusText}`;

      if (responseData.errorMessages && responseData.errorMessages.length > 0) {
        errorMessage = responseData.errorMessages.join(", ");
      } else if (responseData.errors) {
        errorMessage = JSON.stringify(responseData.errors);
      }

      return { success: false, data: responseData, errorMessage };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception creating ticket:", error);
    return {
      success: false,
      data: {},
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Helper function to create a link between two tickets
async function createTicketLink(
  outwardIssue: string,
  inwardIssue: string,
  linkType: string,
  auth: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issueLink`;

  const payload = {
    outwardIssue: {
      key: outwardIssue,
    },
    inwardIssue: {
      key: inwardIssue,
    },
    type: {
      name: linkType,
    },
  };

  console.log("Creating link between", outwardIssue, "and", inwardIssue);
  console.log("Link payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const responseData = await response.json();
      console.error(
        "Error creating link:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      let errorMessage = `Status: ${response.status} ${response.statusText}`;
      return { success: false, errorMessage };
    }

    return { success: true };
  } catch (error) {
    console.error("Exception creating link:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Helper function to search for JIRA tickets
async function searchJiraTickets(
  jql: string,
  maxResults: number,
  auth: string
): Promise<{
  success: boolean;
  data: JiraSearchResponse;
  errorMessage?: string;
}> {
  const fields = "summary,status,priority,issuetype,description";
  const jiraUrl = `https://${
    process.env.JIRA_HOST
  }/rest/api/3/search/jql?jql=${encodeURIComponent(
    jql
  )}&maxResults=${maxResults}&fields=${fields}`;

  console.log("JIRA Search URL:", jiraUrl);
  console.log("JIRA Search JQL:", jql);
  console.log("JIRA Auth:", `Basic ${auth.substring(0, 10)}...`);

  try {
    const response = await fetch(jiraUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    const responseData = (await response.json()) as JiraSearchResponse;

    if (!response.ok) {
      console.error(
        "Error searching tickets:",
        JSON.stringify(responseData, null, 2),
        "Status:",
        response.status,
        response.statusText
      );

      // Try to extract more detailed error information
      let errorMessage = `Status: ${response.status} ${response.statusText}`;

      if (responseData.errorMessages && responseData.errorMessages.length > 0) {
        errorMessage = responseData.errorMessages.join(", ");
      }

      return { success: false, data: responseData, errorMessage };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception searching tickets:", error);
    return {
      success: false,
      data: {},
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Register JIRA tools
server.tool(
  "create-ticket",
  "Create a jira ticket",
  {
    summary: z.string().min(1, "Summary is required"),
    issue_type: z
      .enum(["Bug", "Task", "Story", "Test", "Epic"])
      .default("Task"),
    description: z.string().optional(),
    acceptance_criteria: z.string().optional(),
    story_points: z.number().optional(),
    create_test_ticket: z.boolean().optional(),
    parent_epic: z.string().optional(),
    sprint: z.string().optional(),
    story_readiness: z.enum(["Yes", "No"]).optional(),
    project_key: z.string().optional(),
    crisis: z.enum(["Yes", "No"]).optional(),
  },
  async ({
    summary,
    issue_type,
    description,
    acceptance_criteria,
    story_points,
    create_test_ticket,
    parent_epic,
    sprint,
    story_readiness,
    project_key,
    crisis,
  }) => {
    const formattedDescription = formatDescription(description);

    // Determine if we should create a test ticket
    const shouldCreateTestTicket =
      create_test_ticket !== undefined
        ? create_test_ticket
        : autoCreateTestTickets;

    // Build the payload for the main ticket
    const payload: any = {
      fields: {
        project: {
          key: project_key || process.env.JIRA_PROJECT_KEY || "SCRUM",
        },
        summary: summary,
        description: formattedDescription,
        issuetype: {
          name: issue_type,
        },
      },
    };

    // Add acceptance criteria if provided
    if (acceptance_criteria !== undefined) {
      // Using environment variable for acceptance criteria field
      const acceptanceCriteriaField =
        process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD || "customfield_10429";

      // Format and add acceptance criteria to the custom field only, not to description
      payload.fields[acceptanceCriteriaField] =
        formatAcceptanceCriteria(acceptance_criteria);

      // Log for debugging
      console.log(
        `Adding acceptance criteria to field ${acceptanceCriteriaField}`
      );
      console.log(
        "Formatted acceptance criteria:",
        JSON.stringify(formatAcceptanceCriteria(acceptance_criteria), null, 2)
      );
    }

    // Only add custom fields for Bug, Task, and Story issue types. Do NOT add for Epic or Test.
    if (
      issue_type === "Bug" ||
      issue_type === "Task" ||
      issue_type === "Story"
    ) {
      // Add product field if configured
      const productField = process.env.JIRA_PRODUCT_FIELD;
      const productValue = process.env.JIRA_PRODUCT_VALUE;
      const productId = process.env.JIRA_PRODUCT_ID;

      if (productField && productValue && productId) {
        // Try different formats for the product field
        // Some JIRA instances expect just the ID, others expect the full object
        console.log(`Configuring product field ${productField} with value "${productValue}" and ID "${productId}"`);

        // Try with array format first (as some JIRA instances require arrays)
        payload.fields[productField] = [{
          self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${productId}`,
          value: productValue,
          id: productId,
        }];
      } else if (productField) {
        // Product field is configured but missing value or ID
        console.warn(`Product field ${productField} is configured but missing JIRA_PRODUCT_VALUE or JIRA_PRODUCT_ID`);
      }

      // Add category field if configured
      const categoryField = process.env.JIRA_CATEGORY_FIELD;

      if (categoryField) {
        const useAlternateCategory =
          process.env.USE_ALTERNATE_CATEGORY === "true";

        const categoryOptionId = useAlternateCategory
          ? process.env.JIRA_ALTERNATE_CATEGORY_ID
          : process.env.JIRA_DEFAULT_CATEGORY_ID;

        const categoryOptionValue = useAlternateCategory
          ? process.env.JIRA_ALTERNATE_CATEGORY_VALUE
          : process.env.JIRA_DEFAULT_CATEGORY_VALUE;

        if (categoryOptionId && categoryOptionValue) {
          payload.fields[categoryField] = {
            self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${categoryOptionId}`,
            value: categoryOptionValue,
            id: categoryOptionId,
          };
        }
      }
    }

    // Add story points if provided
    if (story_points !== undefined && issue_type === "Story") {
      // Using environment variable for story points field
      const storyPointsField =
        process.env.JIRA_STORY_POINTS_FIELD || "customfield_10040";
      payload.fields[storyPointsField] = story_points;

      // Add QA-Testable label for stories with points
      payload.fields.labels = ["QA-Testable"];
    }

    // Add parent epic/parent link if provided
    if (parent_epic !== undefined) {
      if (issue_type === "Epic") {
        // For Epic creation, set parent to Initiative key via standard parent field
        payload.fields.parent = { key: parent_epic };
      } else {
        // For Stories/Tasks/Bugs, set Epic Link
        const epicLinkField =
          process.env.JIRA_EPIC_LINK_FIELD || "customfield_10014";
        payload.fields[epicLinkField] = parent_epic;
      }
    }

    // Add sprint if provided
    if (sprint !== undefined) {
      // Sprint field is customfield_10020 based on our query
      payload.fields["customfield_10020"] = [
        {
          name: sprint,
        },
      ];
    }

    // Add story readiness if provided
    if (story_readiness !== undefined) {
      // Story Readiness field is customfield_10596 based on our query
      const storyReadinessId = story_readiness === "Yes" ? "18256" : "18257";
      payload.fields["customfield_10596"] = {
        self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${storyReadinessId}`,
        value: story_readiness,
        id: storyReadinessId,
      };
    }

    // Add crisis field if provided
    if (crisis !== undefined) {
      // Crisis field configuration from environment variables
      // Set JIRA_CRISIS_FIELD to your project's crisis custom field ID
      const crisisField = process.env.JIRA_CRISIS_FIELD || "customfield_14238";
      const crisisId = crisis === "Yes"
        ? process.env.JIRA_CRISIS_YES_ID || "23123"
        : process.env.JIRA_CRISIS_NO_ID || "23124";

      payload.fields[crisisField] = {
        self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${crisisId}`,
        value: crisis,
        id: crisisId,
      };
    }

    // Create the auth token
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // Create the main ticket
    const result = await createJiraTicket(payload, auth);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating ticket: ${result.errorMessage}`,
          },
        ],
      };
    }

    // Extract the ticket key/number from the response
    const ticketKey = result.data.key;
    let responseText = `Created ticket ${ticketKey} with summary: ${summary}, description: ${
      description || "No description"
    }, issue type: ${issue_type}`;

    if (acceptance_criteria !== undefined) {
      responseText += `, acceptance criteria: ${acceptance_criteria}`;
    }

    if (story_points !== undefined) {
      responseText += `, story points: ${story_points}`;
    }

    // Create a test ticket if this is a Story with points and auto-creation is enabled
    if (
      shouldCreateTestTicket &&
      issue_type === "Story" &&
      story_points !== undefined &&
      ticketKey
    ) {
      // Create a test ticket linked to the story
      const testTicketPayload: any = {
        fields: {
          project: {
            key: process.env.JIRA_PROJECT_KEY || "SCRUM",
          },
          summary: `${ticketKey} ${summary}`,
          description: formatDescription(summary), // Use story title as description
          issuetype: {
            name: "Test",
          },
          // Don't include custom fields for Test issue type as they may not be available
        },
      };

      // Create the test ticket
      const testResult = await createJiraTicket(testTicketPayload, auth);

      if (testResult.success && testResult.data.key) {
        // Link the test ticket to the story
        const linkResult = await createTicketLink(
          ticketKey,
          testResult.data.key,
          "Test Case Linking", // "is tested by" relationship
          auth
        );

        if (linkResult.success) {
          responseText += `\nCreated linked test ticket ${testResult.data.key}`;
        } else {
          responseText += `\nCreated test ticket ${testResult.data.key} but failed to link it: ${linkResult.errorMessage}`;
        }
      } else {
        responseText += `\nFailed to create test ticket: ${testResult.errorMessage}`;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }
);

server.tool(
  "link-tickets",
  "Link two jira tickets",
  {
    outward_issue: z.string().min(1, "Outward issue key is required"),
    inward_issue: z.string().min(1, "Inward issue key is required"),
    link_type: z
      .string()
      .min(1, "Link type is required")
      .default("Test Case Linking"),
  },
  async ({ outward_issue, inward_issue, link_type }) => {
    // Create the auth token
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // Create the link
    const result = await createTicketLink(
      outward_issue,
      inward_issue,
      link_type,
      auth
    );

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error linking tickets: ${result.errorMessage}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Successfully linked ${outward_issue} to ${inward_issue} with link type "${link_type}"`,
        },
      ],
    };
  }
);

server.tool(
  "get-ticket",
  "Get a jira ticket",
  {
    ticket_id: z.string().min(1, "Ticket ID is required"),
  },
  async ({ ticket_id }) => {
    const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticket_id}`;
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    try {
      const response = await fetch(jiraUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
      });

      const responseData = (await response.json()) as {
        id?: string;
        errorMessages?: string[];
        fields?: {
          project?: {
            id?: string;
          };
        };
      };

      if (!response.ok) {
        console.error("Error fetching ticket:", responseData);
        return {
          content: [
            {
              type: "text",
              text: `Error fetching ticket: ${
                responseData.errorMessages?.join(", ") || "Unknown error"
              }`,
            },
          ],
        };
      }

      if (!responseData.fields) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No ticket fields found in response",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `JIRA Ticket: ${ticket_id}, Fields: ${JSON.stringify(
              responseData.fields,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      console.error("Exception fetching ticket:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error fetching ticket: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

server.tool(
  "search-tickets",
  "Search for jira tickets by issue type",
  {
    issue_type: z.enum(["Bug", "Task", "Story", "Test", "Epic"]),
    max_results: z.number().min(1).max(50).default(10).optional(),
    additional_criteria: z.string().optional(), // For additional JQL criteria
  },
  async ({ issue_type, max_results = 10, additional_criteria }) => {
    // Create the auth token
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // Construct the JQL query
    let jql = `project = "${process.env.JIRA_PROJECT_KEY}" AND issuetype = "${issue_type}"`;

    // Add additional criteria if provided
    if (additional_criteria) {
      jql += ` AND (${additional_criteria})`;
    }

    // Search for tickets
    const result = await searchJiraTickets(jql, max_results, auth);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching tickets: ${result.errorMessage}`,
          },
        ],
      };
    }

    // Check if we have results
    if (!result.data.issues || result.data.issues.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No ${issue_type} tickets found matching the criteria.`,
          },
        ],
      };
    }

    // Format the results
    const tickets = result.data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
      priority: issue.fields.priority?.name || "Unknown",
    }));

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.data.total} ${issue_type} tickets (showing ${
            tickets.length
          }):\n\n${JSON.stringify(tickets, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "search-tickets-jql",
  "Search for jira tickets using custom JQL query",
  {
    jql: z.string().min(1, "JQL query is required"),
    max_results: z.number().min(1).max(50).default(10).optional(),
  },
  async ({ jql, max_results = 10 }) => {
    // Create the auth token
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // Search for tickets using the provided JQL
    const result = await searchJiraTickets(jql, max_results, auth);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching tickets: ${result.errorMessage}`,
          },
        ],
      };
    }

    // Check if we have results
    if (!result.data.issues || result.data.issues.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No tickets found matching the JQL query: ${jql}`,
          },
        ],
      };
    }

    // Format the results
    const tickets = result.data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || "Unknown",
      priority: issue.fields.priority?.name || "Unknown",
      issuetype: issue.fields.issuetype?.name || "Unknown",
      description: issue.fields.description || "No description",
    }));

    return {
      content: [
        {
          type: "text",
          text: `Found ${result.data.total || tickets.length} ticket(s) (showing ${
            tickets.length
          }):\n\n${JSON.stringify(tickets, null, 2)}`,
        },
      ],
    };
  }
);

// Helper function to get the internal Jira ID and project ID from a ticket key
async function getJiraIssueId(
  ticketKey: string,
  auth: string
): Promise<{
  success: boolean;
  id?: string;
  projectId?: string;
  errorMessage?: string;
}> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}`;

  try {
    const response = await fetch(jiraUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    const responseData = (await response.json()) as JiraGetResponse;

    if (!response.ok) {
      console.error("Error fetching ticket:", responseData);

      let errorMessage = `Status: ${response.status} ${response.statusText}`;
      if (responseData.errorMessages && responseData.errorMessages.length > 0) {
        errorMessage = responseData.errorMessages.join(", ");
      }

      return { success: false, errorMessage };
    }

    if (!responseData.id) {
      return {
        success: false,
        errorMessage: "No issue ID found in response",
      };
    }

    // Extract project ID from the response
    const projectId = responseData.fields?.project?.id;
    if (!projectId) {
      console.log("Warning: Project ID not found in response");
    } else {
      console.log(`Found project ID: ${projectId}`);
    }

    return {
      success: true,
      id: responseData.id,
      projectId,
    };
  } catch (error) {
    console.error("Exception fetching ticket ID:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

// Register new tool for updating tickets
server.tool(
  "update-ticket",
  "Update an existing jira ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    sprint: z.string().optional(),
    story_readiness: z.enum(["Yes", "No"]).optional(),
  },
  async ({ ticket_key, sprint, story_readiness }) => {
    // Create the auth token
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // Build the payload for the update
    const payload: any = {
      fields: {},
    };

    // Add sprint if provided
    if (sprint !== undefined) {
      // Sprint field is customfield_10020 based on our query
      payload.fields["customfield_10020"] = [
        {
          name: sprint,
        },
      ];
    }

    // Add story readiness if provided
    if (story_readiness !== undefined) {
      // Story Readiness field is customfield_10596 based on our query
      const storyReadinessId = story_readiness === "Yes" ? "18256" : "18257";
      payload.fields["customfield_10596"] = {
        self: `https://${process.env.JIRA_HOST}/rest/api/3/customFieldOption/${storyReadinessId}`,
        value: story_readiness,
        id: storyReadinessId,
      };
    }

    // If no fields were provided, return an error
    if (Object.keys(payload.fields).length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: At least one field to update must be provided",
          },
        ],
      };
    }

    // Update the ticket
    const result = await updateJiraTicket(ticket_key, payload, auth);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error updating ticket: ${result.errorMessage}`,
          },
        ],
      };
    }

    // Build response text
    let responseText = `Successfully updated ticket ${ticket_key}`;
    if (sprint !== undefined) {
      responseText += `, sprint: ${sprint}`;
    }
    if (story_readiness !== undefined) {
      responseText += `, story readiness: ${story_readiness}`;
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }
);

// Register new tool for getting Zephyr test steps
server.tool(
  "get-test-steps",
  "Get test steps from a test ticket via Zephyr integration",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
  },
  async ({ ticket_key }) => {
    // Create the auth token for Jira API
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // Get the internal Jira ID from the ticket key
    const idResult = await getJiraIssueId(ticket_key, auth);

    if (!idResult.success || !idResult.id) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting internal ID for ticket ${ticket_key}: ${idResult.errorMessage}`,
          },
        ],
      };
    }

    const issueId = idResult.id;
    console.log(`Found internal ID for ticket ${ticket_key}: ${issueId}`);

    // Get the test steps
    // Make sure we have the project ID
    const projectId = idResult.projectId;
    if (!projectId) {
      console.error("Project ID not found, cannot get test steps");
      return {
        content: [
          {
            type: "text",
            text: `Error: Project ID not found for ticket ${ticket_key}`,
          },
        ],
      };
    }

    const result = await getZephyrTestSteps(issueId, projectId);

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting test steps for ticket ${ticket_key}: ${result.errorMessage}`,
          },
        ],
      };
    }

    // Check if we have test steps
    if (!result.steps || result.steps.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No test steps found for ticket ${ticket_key}.`,
          },
        ],
      };
    }

    // Format the test steps
    const formattedSteps = result.steps.map((step) => ({
      id: step.id,
      orderId: step.orderId,
      step: step.step,
      data: step.data || "",
      result: step.result || "",
    }));

    return {
      content: [
        {
          type: "text",
          text: `Found ${
            formattedSteps.length
          } test step(s) for ticket ${ticket_key}:\n\n${JSON.stringify(
            formattedSteps,
            null,
            2
          )}`,
        },
      ],
    };
  }
);

// Register new tool for adding test steps
server.tool(
  "add-test-steps",
  "Add test steps to a test ticket via Zephyr integration",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    steps: z
      .array(
        z.object({
          step: z.string().min(1, "Step description is required"),
          data: z.string().optional(),
          result: z.string().optional(),
        })
      )
      .min(1, "At least one test step is required"),
  },
  async ({ ticket_key, steps }) => {
    // Create the auth token for Jira API
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // Get the internal Jira ID from the ticket key
    const idResult = await getJiraIssueId(ticket_key, auth);

    if (!idResult.success || !idResult.id) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting internal ID for ticket ${ticket_key}: ${idResult.errorMessage}`,
          },
        ],
      };
    }

    const issueId = idResult.id;
    console.log(`Found internal ID for ticket ${ticket_key}: ${issueId}`);

    // Add each test step
    const results: string[] = [];
    let allSuccessful = true;

    for (const [index, { step, data = "", result = "" }] of steps.entries()) {
      console.log(`Adding test step ${index + 1}/${steps.length}: ${step}`);

      // Pass the project ID to the addZephyrTestStep function
      const projectId = idResult.projectId;
      if (!projectId) {
        console.error("Project ID not found, cannot add test steps");
        return {
          content: [
            {
              type: "text",
              text: `Error: Project ID not found for ticket ${ticket_key}`,
            },
          ],
        };
      }

      const stepResult = await addZephyrTestStep(
        issueId,
        projectId,
        step,
        data,
        result
      );

      if (stepResult.success) {
        results.push(`Step ${index + 1}: Added successfully`);
      } else {
        results.push(`Step ${index + 1}: Failed - ${stepResult.errorMessage}`);
        allSuccessful = false;
      }
    }

    // Return the results
    if (allSuccessful) {
      return {
        content: [
          {
            type: "text",
            text: `Successfully added ${
              steps.length
            } test step(s) to ticket ${ticket_key}:\n\n${results.join("\n")}`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `Some test steps could not be added to ticket ${ticket_key}:\n\n${results.join(
              "\n"
            )}`,
          },
        ],
      };
    }
  }
);

// Register new tool for adding a comment to a JIRA ticket.
server.tool(
  "add-comment",
  "Add a comment to a JIRA ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    comment: z.string().min(1, "Comment text is required"),
  },
  async ({ ticket_key, comment }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const commentBody = formatDescription(comment);
    const result = await addJiraComment(ticket_key, commentBody, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error adding comment: ${result.errorMessage}` },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: `Successfully added comment to ${ticket_key}` },
      ],
    };
  }
);

// Register new tool for listing comments on a JIRA ticket.
server.tool(
  "list-comments",
  "List comments on a JIRA ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    max_results: z.number().min(1).max(100).default(20).optional(),
  },
  async ({ ticket_key, max_results = 20 }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const result = await getJiraComments(ticket_key, max_results, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error getting comments: ${result.errorMessage}` },
        ],
      };
    }

    const comments = result.data?.comments || [];
    if (comments.length === 0) {
      return {
        content: [{ type: "text", text: `No comments found on ${ticket_key}` }],
      };
    }

    const formattedComments = comments.map((c) => ({
      id: c.id,
      author: c.author.displayName,
      created: c.created,
      body: extractTextFromAdf(c.body).trim(),
    }));

    return {
      content: [
        {
          type: "text",
          text: `Found ${
            result.data?.total || comments.length
          } comments on ${ticket_key}:\n\n${JSON.stringify(formattedComments, null, 2)}`,
        },
      ],
    };
  }
);

// Register new tool for transitioning a JIRA ticket to a different status.
server.tool(
  "transition-ticket",
  "Transition a JIRA ticket to a different status",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    transition_name: z.string().optional().describe("Transition name (e.g., 'Done', 'In Progress')"),
    transition_id: z.string().optional().describe("Transition ID (use if name is ambiguous)"),
    list_transitions: z.boolean().optional().describe("List available transitions instead of transitioning"),
    comment: z.string().optional().describe("Comment to add during the transition"),
  },
  async ({ ticket_key, transition_name, transition_id, list_transitions, comment }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const transitionsResult = await getJiraTransitions(ticket_key, auth);

    if (!transitionsResult.success) {
      return {
        content: [
          { type: "text", text: `Error getting transitions: ${transitionsResult.errorMessage}` },
        ],
      };
    }

    const transitions = transitionsResult.data?.transitions || [];

    if (list_transitions) {
      const transitionList = transitions.map((t) => ({ id: t.id, name: t.name, to: t.to.name }));
      return {
        content: [
          {
            type: "text",
            text: `Available transitions for ${ticket_key}:\n\n${JSON.stringify(transitionList, null, 2)}`,
          },
        ],
      };
    }

    let targetTransition;
    if (transition_id) {
      targetTransition = transitions.find((t) => t.id === transition_id);
    } else if (transition_name) {
      targetTransition = transitions.find(
        (t) => t.name.toLowerCase() === transition_name.toLowerCase()
      );
    } else {
      return {
        content: [
          {
            type: "text",
            text: "Error: Either transition_name or transition_id is required (or use list_transitions to see available options)",
          },
        ],
      };
    }

    if (!targetTransition) {
      const availableNames = transitions.map((t) => `"${t.name}" (id: ${t.id})`).join(", ");
      return {
        content: [
          { type: "text", text: `Error: Transition not found. Available transitions: ${availableNames}` },
        ],
      };
    }

    const commentBody = comment ? formatDescription(comment) : undefined;
    const result = await transitionJiraTicket(ticket_key, targetTransition.id, commentBody, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error transitioning ticket: ${result.errorMessage}` },
        ],
      };
    }

    let responseText = `Successfully transitioned ${ticket_key} to "${targetTransition.to.name}"`;
    if (comment) {
      responseText += " with comment";
    }

    return { content: [{ type: "text", text: responseText }] };
  }
);

// Register new tool for assigning or unassigning a JIRA ticket.
server.tool(
  "assign-ticket",
  "Assign or unassign a JIRA ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    account_id: z.string().optional().describe("Account ID to assign to. Omit to unassign."),
  },
  async ({ ticket_key, account_id }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const result = await assignJiraTicket(ticket_key, account_id || null, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error assigning ticket: ${result.errorMessage}` },
        ],
      };
    }

    const action = account_id ? `assigned to ${account_id}` : "unassigned";
    return {
      content: [{ type: "text", text: `Successfully ${action} ticket ${ticket_key}` }],
    };
  }
);

// Register new tool for adding a watcher to a JIRA ticket.
server.tool(
  "add-watcher",
  "Add a watcher to a JIRA ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    account_id: z.string().min(1, "Account ID is required"),
  },
  async ({ ticket_key, account_id }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const result = await addJiraWatcher(ticket_key, account_id, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error adding watcher: ${result.errorMessage}` },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: `Successfully added ${account_id} as watcher to ${ticket_key}` },
      ],
    };
  }
);

// Register new tool for removing a watcher from a JIRA ticket.
server.tool(
  "remove-watcher",
  "Remove a watcher from a JIRA ticket",
  {
    ticket_key: z.string().min(1, "Ticket key is required"),
    account_id: z.string().min(1, "Account ID is required"),
  },
  async ({ ticket_key, account_id }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const result = await removeJiraWatcher(ticket_key, account_id, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error removing watcher: ${result.errorMessage}` },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: `Successfully removed ${account_id} as watcher from ${ticket_key}` },
      ],
    };
  }
);

// Register new tool for creating a JIRA project.
// Requires "Administer Jira" global permission on the configured account.
server.tool(
  "create-project",
  "Create a new JIRA project (requires Jira admin permissions). Creates a real, shared project on your Jira site — confirm the key, template, and lead before running this.",
  {
    key: z
      .string()
      .regex(
        /^[A-Z][A-Z0-9]{1,9}$/,
        "Project key must be 2-10 uppercase letters/digits, starting with a letter (e.g. DBSAN)"
      ),
    name: z.string().min(1, "Project name is required"),
    project_type_key: z.enum(["software", "business", "service_desk"]),
    project_template_key: z
      .string()
      .min(1)
      .describe(
        "Jira project template key, must match project_type_key (e.g. 'com.pyxis.greenhopper.jira:gh-simplified-scrum-classic' for software, 'com.atlassian.servicedesk:simplified-it-service-management' for service_desk). Look this up from an existing project of the desired type if unsure."
      ),
    description: z.string().optional(),
    lead_account_id: z.string().optional().describe("Atlassian accountId of the project lead"),
    assignee_type: z.enum(["PROJECT_LEAD", "UNASSIGNED"]).optional(),
    url: z.string().optional(),
  },
  async ({
    key,
    name,
    project_type_key,
    project_template_key,
    description,
    lead_account_id,
    assignee_type,
    url,
  }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const payload: Record<string, unknown> = {
      key,
      name,
      projectTypeKey: project_type_key,
      projectTemplateKey: project_template_key,
    };
    if (description !== undefined) payload.description = description;
    if (lead_account_id !== undefined) payload.leadAccountId = lead_account_id;
    if (assignee_type !== undefined) payload.assigneeType = assignee_type;
    if (url !== undefined) payload.url = url;

    const result = await createJiraProject(payload, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error creating project: ${result.errorMessage}` },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Created project ${result.data?.key} (id: ${result.data?.id}) with name "${name}"`,
        },
      ],
    };
  }
);

// Register new tool for creating a custom global issue type.
// Requires "Administer Jira" global permission.
server.tool(
  "create-issue-type",
  "Create a new global JIRA issue type (requires Jira admin permissions). The issue type is created instance-wide; add it to an issue type scheme to make it available on a specific project.",
  {
    name: z.string().min(1, "Issue type name is required"),
    description: z.string().optional(),
    type: z.enum(["standard", "subtask"]).default("standard"),
  },
  async ({ name, description, type }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const payload: Record<string, unknown> = { name, type };
    if (description !== undefined) payload.description = description;

    const result = await createJiraIssueType(payload, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error creating issue type: ${result.errorMessage}` },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Created issue type "${result.data?.name}" (id: ${result.data?.id})`,
        },
      ],
    };
  }
);

// Register new tool for creating an issue type scheme.
// Cloud-only; applies to company-managed (classic) projects.
server.tool(
  "create-issuetype-scheme",
  "Create a JIRA issue type scheme, a named set of issue types that can be assigned to a project (requires Jira admin permissions; company-managed projects only). Use create-issue-type first to get issue type IDs.",
  {
    name: z.string().min(1, "Scheme name is required"),
    description: z.string().optional(),
    issue_type_ids: z.array(z.string()).min(1, "At least one issue type ID is required"),
    default_issue_type_id: z.string().optional(),
  },
  async ({ name, description, issue_type_ids, default_issue_type_id }) => {
    if (
      default_issue_type_id !== undefined &&
      !issue_type_ids.includes(default_issue_type_id)
    ) {
      return {
        content: [
          {
            type: "text",
            text: "Error: default_issue_type_id must be one of the provided issue_type_ids",
          },
        ],
      };
    }

    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    const payload: Record<string, unknown> = { name, issueTypeIds: issue_type_ids };
    if (description !== undefined) payload.description = description;
    if (default_issue_type_id !== undefined) payload.defaultIssueTypeId = default_issue_type_id;

    const result = await createJiraIssueTypeScheme(payload, auth);

    if (!result.success) {
      return {
        content: [
          { type: "text", text: `Error creating issue type scheme: ${result.errorMessage}` },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Created issue type scheme "${name}" (id: ${result.data?.issueTypeSchemeId})`,
        },
      ],
    };
  }
);

// Register new tool for assigning an issue type scheme to a project.
// Cloud-only; replaces any scheme already assigned to the project.
server.tool(
  "assign-issuetype-scheme",
  "Assign (replace) the issue type scheme for a JIRA project (requires Jira admin permissions; company-managed projects only). Fails if the project has issues using types not present in the new scheme.",
  {
    issue_type_scheme_id: z.string().min(1, "Issue type scheme ID is required"),
    project_key_or_id: z.string().min(1, "Project key or ID is required"),
  },
  async ({ issue_type_scheme_id, project_key_or_id }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`
    ).toString("base64");

    // The API requires a numeric projectId, not a key, so resolve it first.
    const projectResult = await getJiraProject(project_key_or_id, auth);
    if (!projectResult.success || !projectResult.data?.id) {
      return {
        content: [
          {
            type: "text",
            text: `Error resolving project "${project_key_or_id}": ${projectResult.errorMessage}`,
          },
        ],
      };
    }

    const result = await assignJiraIssueTypeScheme(
      issue_type_scheme_id,
      projectResult.data.id,
      auth
    );

    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Error assigning issue type scheme: ${result.errorMessage}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Assigned issue type scheme ${issue_type_scheme_id} to project ${project_key_or_id} (id: ${projectResult.data.id})`,
        },
      ],
    };
  }
);

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Error in main():", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error running main:", error);
  process.exit(1);
});
