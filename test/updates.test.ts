import assert from "node:assert/strict";
import test from "node:test";
import { checkForLatestRelease, compareVersions } from "../src/core/updates.ts";

test("compareVersions orders releases and prereleases", () => {
  assert.ok(compareVersions("0.1.5", "0.1.4") > 0);
  assert.ok(compareVersions("v0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.equal(compareVersions("1.2.3", "v1.2.3"), 0);
});

test("checkForLatestRelease reports available updates", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        tag_name: "v0.2.0",
        html_url: "https://example.test/release",
        body: "notes",
        published_at: "2026-01-01T00:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const info = await checkForLatestRelease("0.1.5", "owner/repo", fetchImpl);
  assert.equal(info.latestVersion, "0.2.0");
  assert.equal(info.available, true);
  assert.equal(info.releaseUrl, "https://example.test/release");
});

test("checkForLatestRelease handles HTTP and network errors", async () => {
  const notFound = (async () =>
    new Response("missing", { status: 404 })) as typeof fetch;
  const first = await checkForLatestRelease("0.1.5", "owner/repo", notFound);
  assert.equal(first.available, false);
  assert.match(first.error ?? "", /404/);

  const broken = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const second = await checkForLatestRelease("0.1.5", "owner/repo", broken);
  assert.equal(second.available, false);
  assert.match(second.error ?? "", /offline/);
});
