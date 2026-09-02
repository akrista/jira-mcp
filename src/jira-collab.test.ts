import { test } from "node:test";
import assert from "node:assert/strict";
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

process.env.JIRA_HOST = "example.atlassian.net";

function fakeJsonResponse(status: number, body: unknown) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? "OK" : "Error",
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

test("addJiraComment succeeds on 201", async () => {
  const fetchImpl = fakeJsonResponse(201, { id: "10", body: {} });
  const result = await addJiraComment("PROJ-1", { type: "doc" }, "auth", fetchImpl as any);
  assert.equal(result.success, true);
  assert.equal(result.data?.id, "10");
});

test("addJiraComment surfaces errors on failure", async () => {
  const fetchImpl = fakeJsonResponse(404, { errorMessages: ["Issue does not exist."] });
  const result = await addJiraComment("NOPE-1", { type: "doc" }, "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /does not exist/);
});

test("getJiraComments returns the comment list", async () => {
  const fetchImpl = fakeJsonResponse(200, { total: 1, comments: [{ id: "1" }] });
  const result = await getJiraComments("PROJ-1", 20, "auth", fetchImpl as any);
  assert.equal(result.success, true);
  assert.equal(result.data?.total, 1);
});

test("getJiraTransitions returns available transitions", async () => {
  const fetchImpl = fakeJsonResponse(200, {
    transitions: [{ id: "31", name: "Done", to: { id: "3", name: "Done" } }],
  });
  const result = await getJiraTransitions("PROJ-1", "auth", fetchImpl as any);
  assert.equal(result.success, true);
  assert.equal(result.data?.transitions?.[0]?.name, "Done");
});

test("transitionJiraTicket succeeds on 204 No Content", async () => {
  const fetchImpl = fakeNoContentResponse(204);
  const result = await transitionJiraTicket("PROJ-1", "31", undefined, "auth", fetchImpl as any);
  assert.equal(result.success, true);
});

test("transitionJiraTicket surfaces errors on an invalid transition", async () => {
  const fetchImpl = fakeJsonResponse(400, { errorMessages: ["Transition id 99 is not valid."] });
  const result = await transitionJiraTicket("PROJ-1", "99", undefined, "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /not valid/);
});

test("assignJiraTicket succeeds on 204 No Content", async () => {
  const fetchImpl = fakeNoContentResponse(204);
  const result = await assignJiraTicket("PROJ-1", "abc123", "auth", fetchImpl as any);
  assert.equal(result.success, true);
});

test("assignJiraTicket surfaces errors on failure", async () => {
  const fetchImpl = fakeJsonResponse(400, { errorMessages: ["User does not exist."] });
  const result = await assignJiraTicket("PROJ-1", "bad-id", "auth", fetchImpl as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /does not exist/);
});

test("addJiraWatcher succeeds on 204 No Content", async () => {
  const fetchImpl = fakeNoContentResponse(204);
  const result = await addJiraWatcher("PROJ-1", "abc123", "auth", fetchImpl as any);
  assert.equal(result.success, true);
});

test("removeJiraWatcher succeeds on 204 No Content", async () => {
  const fetchImpl = fakeNoContentResponse(204);
  const result = await removeJiraWatcher("PROJ-1", "abc123", "auth", fetchImpl as any);
  assert.equal(result.success, true);
});

test("removeJiraWatcher reports a network failure via the catch path", async () => {
  const throwingFetch = async () => {
    throw new Error("socket hang up");
  };
  const result = await removeJiraWatcher("PROJ-1", "abc123", "auth", throwingFetch as any);
  assert.equal(result.success, false);
  assert.match(result.errorMessage!, /socket hang up/);
});

test("extractTextFromAdf extracts plain text from a paragraph", () => {
  const adf = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
  };
  assert.equal(extractTextFromAdf(adf).trim(), "Hello world");
});

test("extractTextFromAdf renders bullet list items with markers", () => {
  const adf = {
    type: "bulletList",
    content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
    ],
  };
  const text = extractTextFromAdf(adf);
  assert.match(text, /• one/);
  assert.match(text, /• two/);
});

test("extractTextFromAdf returns empty string for null/undefined input", () => {
  assert.equal(extractTextFromAdf(undefined), "");
  assert.equal(extractTextFromAdf(null), "");
});
