import nodeFetch from "node-fetch";

// Admin-level JIRA REST API v3 operations: project creation, custom issue
// types, and issue type schemes. These require "Administer Jira" permission
// on the token's account, unlike the issue-level operations in src/index.ts.

type FetchFn = typeof nodeFetch;

export type JiraProjectResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
  id?: string;
  key?: string;
  self?: string;
};

export type JiraProjectLookupResponse = {
  errorMessages?: string[];
  id?: string;
  key?: string;
};

export type JiraIssueTypeResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
  id?: string;
  name?: string;
  description?: string;
  subtask?: boolean;
};

export type JiraIssueTypeSchemeResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
  issueTypeSchemeId?: string;
};

type ApiResult<T> = {
  success: boolean;
  data?: T;
  errorMessage?: string;
};

function extractErrorMessage(
  responseData: { errorMessages?: string[]; errors?: Record<string, string> },
  response: { status: number; statusText: string }
): string {
  if (responseData.errorMessages && responseData.errorMessages.length > 0) {
    return responseData.errorMessages.join(", ");
  }
  if (responseData.errors && Object.keys(responseData.errors).length > 0) {
    return JSON.stringify(responseData.errors);
  }
  return `Status: ${response.status} ${response.statusText}`;
}

// Creates a new JIRA project. Requires "Administer Jira" global permission.
export async function createJiraProject(
  payload: Record<string, unknown>,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<JiraProjectResponse>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/project`;

  console.error("JIRA Create Project URL:", jiraUrl);
  console.error("JIRA Create Project Payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = (await response.json()) as JiraProjectResponse;

    if (!response.ok) {
      console.error("Error creating project:", JSON.stringify(responseData, null, 2));
      return { success: false, data: responseData, errorMessage: extractErrorMessage(responseData, response) };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception creating project:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Looks up a project's numeric id from its key (or id). Needed because
// issuetypescheme/project requires a numeric projectId, not a key.
export async function getJiraProject(
  projectIdOrKey: string,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<JiraProjectLookupResponse>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/project/${encodeURIComponent(projectIdOrKey)}`;

  console.error("JIRA Get Project URL:", jiraUrl);

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    const responseData = (await response.json()) as JiraProjectLookupResponse;

    if (!response.ok) {
      console.error("Error fetching project:", JSON.stringify(responseData, null, 2));
      return { success: false, data: responseData, errorMessage: extractErrorMessage(responseData, response) };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception fetching project:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Creates a new global issue type. Requires "Administer Jira" permission.
export async function createJiraIssueType(
  payload: Record<string, unknown>,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<JiraIssueTypeResponse>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issuetype`;

  console.error("JIRA Create Issue Type URL:", jiraUrl);
  console.error("JIRA Create Issue Type Payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = (await response.json()) as JiraIssueTypeResponse;

    if (!response.ok) {
      console.error("Error creating issue type:", JSON.stringify(responseData, null, 2));
      return { success: false, data: responseData, errorMessage: extractErrorMessage(responseData, response) };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception creating issue type:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Creates a new issue type scheme (a named collection of issue types).
// Cloud-only endpoint; only applies to company-managed (classic) projects.
export async function createJiraIssueTypeScheme(
  payload: Record<string, unknown>,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<JiraIssueTypeSchemeResponse>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issuetypescheme`;

  console.error("JIRA Create Issue Type Scheme URL:", jiraUrl);
  console.error("JIRA Create Issue Type Scheme Payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const responseData = (await response.json()) as JiraIssueTypeSchemeResponse;

    if (!response.ok) {
      console.error("Error creating issue type scheme:", JSON.stringify(responseData, null, 2));
      return { success: false, data: responseData, errorMessage: extractErrorMessage(responseData, response) };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception creating issue type scheme:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Assigns (replaces) the issue type scheme for a project. Cloud-only.
export async function assignJiraIssueTypeScheme(
  issueTypeSchemeId: string,
  projectId: string,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<never>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issuetypescheme/project`;

  const payload = { issueTypeSchemeId, projectId };

  console.error("JIRA Assign Issue Type Scheme URL:", jiraUrl);
  console.error("JIRA Assign Issue Type Scheme Payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 204) {
      return { success: true };
    }

    let errorMessage = `Status: ${response.status} ${response.statusText}`;
    try {
      const responseData = (await response.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
      console.error("Error assigning issue type scheme:", responseData);
      errorMessage = extractErrorMessage(responseData, response);
    } catch (parseError) {
      console.error("Error parsing error response:", parseError);
    }

    return { success: false, errorMessage };
  } catch (error) {
    console.error("Exception assigning issue type scheme:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}
