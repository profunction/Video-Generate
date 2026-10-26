const { test } = require("node:test");
const assert = require("node:assert/strict");
const { allowedNavigation } = require("../app/flow-editor");
test("flow view permits its own local frontend but blocks external and privileged navigation", () => {
  const base = "http://127.0.0.1:18188";
  assert.equal(allowedNavigation(base, base + "/workflow?name=test"), true);
  for (const url of [
    "https://example.com",
    "file:///C:/secret",
    "javascript:alert(1)",
    "http://127.0.0.1:18189",
    "http://localhost:18188",
    "not a URL",
  ])
    assert.equal(allowedNavigation(base, url), false);
  assert.equal(
    allowedNavigation("https://example.com", "https://example.com"),
    false,
  );
});
