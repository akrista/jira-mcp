import nodeFetch from "node-fetch";

// Comment, transition, assignment, and watcher operations for a JIRA issue.
// Ported from the previously-orphaned src/jira/{api,types,formatting}.ts —
// those modules were never wired into the running server (registerJiraTools
// was never imported by index.ts), so these tools have never actually been
// reachable despite being implemented since commit 61958c1.

type FetchFn = typeof nodeFetch;

export type JiraCommentResponse = {
  errorMessages?: string[];
  errors?: Record<string, string>;
  id?: string;
  body?: any;
  author?: { accountId: string; displayName: string };
  created?: string;
};

export type JiraComment = {
  id: string;
  body: any;
  author: { accountId: string; displayName: string };
  created: string;
  updated: string;
};

export type JiraCommentsListResponse = {
  errorMessages?: string[];
  comments?: JiraComment[];
  total?: number;
};

export type JiraTransition = {
  id: string;
  name: string;
  to: { id: string; name: string };
};

export type JiraTransitionsResponse = {
  errorMessages?: string[];
  transitions?: JiraTransition[];
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

// Adds a comment to a JIRA ticket.
export async function addJiraComment(
  ticketKey: string,
  body: any,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<JiraCommentResponse>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}/comment`;

  console.error("JIRA Add Comment URL:", jiraUrl);

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ body }),
    });

    if (response.status === 201) {
      const responseData = (await response.json()) as JiraCommentResponse;
      return { success: true, data: responseData };
    }

    let errorMessage = `Status: ${response.status} ${response.statusText}`;
    try {
      const responseData = (await response.json()) as JiraCommentResponse;
      console.error("Error adding comment:", responseData);
      errorMessage = extractErrorMessage(responseData, response);
    } catch (parseError) {
      console.error("Error parsing error response:", parseError);
    }

    return { success: false, errorMessage };
  } catch (error) {
    console.error("Exception adding comment:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Gets comments from a JIRA ticket.
export async function getJiraComments(
  ticketKey: string,
  maxResults: number,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<JiraCommentsListResponse>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}/comment?maxResults=${maxResults}`;

  console.error("JIRA Get Comments URL:", jiraUrl);

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    const responseData = (await response.json()) as JiraCommentsListResponse;

    if (!response.ok) {
      console.error("Error getting comments:", responseData);
      return { success: false, data: responseData, errorMessage: extractErrorMessage(responseData, response) };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception getting comments:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Gets available transitions for a JIRA ticket.
export async function getJiraTransitions(
  ticketKey: string,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<JiraTransitionsResponse>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}/transitions`;

  console.error("JIRA Get Transitions URL:", jiraUrl);

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    const responseData = (await response.json()) as JiraTransitionsResponse;

    if (!response.ok) {
      console.error("Error getting transitions:", responseData);
      return { success: false, data: responseData, errorMessage: extractErrorMessage(responseData, response) };
    }

    return { success: true, data: responseData };
  } catch (error) {
    console.error("Exception getting transitions:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Transitions a JIRA ticket to a new status, optionally with a comment.
export async function transitionJiraTicket(
  ticketKey: string,
  transitionId: string,
  comment: any | undefined,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<never>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}/transitions`;

  const payload: any = { transition: { id: transitionId } };
  if (comment) {
    payload.update = { comment: [{ add: { body: comment } }] };
  }

  console.error("JIRA Transition URL:", jiraUrl);
  console.error("JIRA Transition Payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "POST",
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
      console.error("Error transitioning ticket:", responseData);
      errorMessage = extractErrorMessage(responseData, response);
    } catch (parseError) {
      console.error("Error parsing error response:", parseError);
    }

    return { success: false, errorMessage };
  } catch (error) {
    console.error("Exception transitioning ticket:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Assigns (or unassigns, with accountId null) a JIRA ticket.
export async function assignJiraTicket(
  ticketKey: string,
  accountId: string | null,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<never>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}/assignee`;

  console.error("JIRA Assign URL:", jiraUrl);

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ accountId }),
    });

    if (response.status === 204) {
      return { success: true };
    }

    let errorMessage = `Status: ${response.status} ${response.statusText}`;
    try {
      const responseData = (await response.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
      console.error("Error assigning ticket:", responseData);
      errorMessage = extractErrorMessage(responseData, response);
    } catch (parseError) {
      console.error("Error parsing error response:", parseError);
    }

    return { success: false, errorMessage };
  } catch (error) {
    console.error("Exception assigning ticket:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Adds a watcher to a JIRA ticket.
export async function addJiraWatcher(
  ticketKey: string,
  accountId: string,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<never>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}/watchers`;

  console.error("JIRA Add Watcher URL:", jiraUrl);

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(accountId),
    });

    if (response.status === 204) {
      return { success: true };
    }

    let errorMessage = `Status: ${response.status} ${response.statusText}`;
    try {
      const responseData = (await response.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
      console.error("Error adding watcher:", responseData);
      errorMessage = extractErrorMessage(responseData, response);
    } catch (parseError) {
      console.error("Error parsing error response:", parseError);
    }

    return { success: false, errorMessage };
  } catch (error) {
    console.error("Exception adding watcher:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Removes a watcher from a JIRA ticket.
export async function removeJiraWatcher(
  ticketKey: string,
  accountId: string,
  auth: string,
  fetchImpl: FetchFn = nodeFetch
): Promise<ApiResult<never>> {
  const jiraUrl = `https://${process.env.JIRA_HOST}/rest/api/3/issue/${ticketKey}/watchers?accountId=${encodeURIComponent(accountId)}`;

  console.error("JIRA Remove Watcher URL:", jiraUrl);

  try {
    const response = await fetchImpl(jiraUrl, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
    });

    if (response.status === 204) {
      return { success: true };
    }

    let errorMessage = `Status: ${response.status} ${response.statusText}`;
    try {
      const responseData = (await response.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
      console.error("Error removing watcher:", responseData);
      errorMessage = extractErrorMessage(responseData, response);
    } catch (parseError) {
      console.error("Error parsing error response:", parseError);
    }

    return { success: false, errorMessage };
  } catch (error) {
    console.error("Exception removing watcher:", error);
    return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// Extracts plain text from Atlassian Document Format (ADF), used to render
// comment bodies as readable text in tool responses.
export function extractTextFromAdf(adf: any): string {
  if (!adf) {
    return "";
  }

  if (typeof adf === "string") {
    return adf;
  }

  if (adf.type === "text" && adf.text) {
    return adf.text;
  }

  if (Array.isArray(adf.content)) {
    const parts: string[] = [];

    for (const node of adf.content) {
      const text = extractTextFromAdf(node);
      if (text) {
        parts.push(text);
      }
    }

    if (adf.type === "paragraph" || adf.type === "heading") {
      return parts.join("") + "\n";
    }

    if (adf.type === "bulletList" || adf.type === "orderedList") {
      return parts.join("");
    }

    if (adf.type === "listItem") {
      return "• " + parts.join("") + "\n";
    }

    if (adf.type === "codeBlock") {
      return "```\n" + parts.join("") + "\n```\n";
    }

    return parts.join("");
  }

  return "";
}
