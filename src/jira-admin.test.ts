import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJiraProject,
  getJiraProject,
  createJiraIssueType,
  createJiraIssueTypeScheme,
  assignJiraIssueTypeScheme,
} from "./jira-admin.js";

process.env.JIRA_HOST = "example.atlassian.net";

function fakeJsonResponse(status: number, body: unknown) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 || status === 201 ? "OK" : "Error",
      json: async () => body,
    }) as any;
}

function fakeNoContentResponse(status: number) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 204 ? "No Content" : "Error",
      json: async () => ({}),
    }) as any;
}

test("createJiraProject returns success with key/id on 201", async () => {
  const fetchImpl = fakeJsonResponse(201, { id: "10099", key: "SAN", self: "https://x" });
  const result = await createJiraProject({ key: "SAN", name: "Sandoz" }, "auth", fetchImpl as any);
  assert.equal(result.success, true);
  assert.equal(result.data?.key, "SAN");
});

test("createJiraProject surfaces field errors from a 400 response", async () => {
  const fetchImpl = fakeJsonResponse(400, { errors: { projectTemplateKey: "Invalid template" } });
  const result = await createJiraProject({ key: "SAN", name: "Sandoz" }, "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /projectTemplateKey/);
});

test("getJiraProject resolves a project key to its numeric id", async () => {
  const fetchImpl = fakeJsonResponse(200, { id: "10099", key: "SAN" });
  const result = await getJiraProject("SAN", "auth", fetchImpl as any);
  assert.equal(result.success, true);
  assert.equal(result.data?.id, "10099");
});

test("getJiraProject reports errorMessages on failure", async () => {
  const fetchImpl = fakeJsonResponse(404, { errorMessages: ["No project could be found with key 'NOPE'."] });
  const result = await getJiraProject("NOPE", "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /No project could be found/);
});

test("createJiraIssueType returns the created issue type id", async () => {
  const fetchImpl = fakeJsonResponse(201, { id: "10100", name: "Indicador", subtask: false });
  const result = await createJiraIssueType({ name: "Indicador", type: "standard" }, "auth", fetchImpl as any);
  assert.equal(result.success, true);
  assert.equal(result.data?.id, "10100");
});

test("createJiraIssueType surfaces errors on a duplicate name", async () => {
  const fetchImpl = fakeJsonResponse(400, { errors: { name: "An issue type with this name already exists." } });
  const result = await createJiraIssueType({ name: "Indicador", type: "standard" }, "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /already exists/);
});

test("createJiraIssueTypeScheme returns the created scheme id", async () => {
  const fetchImpl = fakeJsonResponse(201, { issueTypeSchemeId: "10005" });
  const result = await createJiraIssueTypeScheme(
    { name: "Sandoz Scheme", issueTypeIds: ["10100", "10001"] },
    "auth",
    fetchImpl as any
  );
  assert.equal(result.success, true);
  assert.equal(result.data?.issueTypeSchemeId, "10005");
});

test("createJiraIssueTypeScheme surfaces errors on an invalid issue type id", async () => {
  const fetchImpl = fakeJsonResponse(400, { errorMessages: ["Issue type with id 'bad-id' does not exist."] });
  const result = await createJiraIssueTypeScheme(
    { name: "Sandoz Scheme", issueTypeIds: ["bad-id"] },
    "auth",
    fetchImpl as any
  );
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /does not exist/);
});

test("createJiraProject falls back to status text when the error body has no errorMessages/errors", async () => {
  const fetchImpl = fakeJsonResponse(500, {});
  const result = await createJiraProject({ key: "SAN", name: "Sandoz" }, "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /Status: 500/);
});

test("createJiraProject reports a network/DNS failure via the catch path", async () => {
  const throwingFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND example.atlassian.net");
  };
  const result = await createJiraProject({ key: "SAN", name: "Sandoz" }, "auth", throwingFetch as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /ENOTFOUND/);
});

test("assignJiraIssueTypeScheme succeeds on 204 No Content", async () => {
  const fetchImpl = fakeNoContentResponse(204);
  const result = await assignJiraIssueTypeScheme("10005", "10099", "auth", fetchImpl as any);
  assert.equal(result.success, true);
});

test("assignJiraIssueTypeScheme surfaces errors on failure", async () => {
  const fetchImpl = fakeJsonResponse(400, {
    errorMessages: ["Issue type scheme not found."],
  });
  const result = await assignJiraIssueTypeScheme("bad-id", "10099", "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /Issue type scheme not found/);
});
