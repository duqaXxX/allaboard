import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadFile } from "../../../../src/chat/slack/openfile/read.ts";
import { FakeSlack } from "../../../support/fake-slack.ts";

test("a file is shared as its bytes, named by its basename and titled by its path", async () => {
  const slack = new FakeSlack();
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x80]);
  await uploadFile(slack, "C000CHAN", "1790000000.000001", bytes, "./docs/../docs/a.bin");
  const [url, done] = slack.apiCalls;
  assert.equal(url?.method, "files.getUploadURLExternal");
  assert.equal(url?.args.filename, "a.bin");
  assert.equal(url?.args.length, bytes.length);
  assert.equal(done?.method, "files.completeUploadExternal");
  assert.equal(done?.args.channel_id, "C000CHAN");
  assert.equal(done?.args.thread_ts, "1790000000.000001");
  assert.deepEqual(done?.args.files, [{ id: "F000FILE", title: "docs/a.bin" }]);
  // The bytes reached the upload URL exactly, a binary file included.
  assert.deepEqual(
    slack.uploaded.map((posted) => posted.data),
    [bytes],
  );
});

test("a TypeScript file says its type, and any other leaves it to Slack", async () => {
  const slack = new FakeSlack();
  await uploadFile(slack, "C000CHAN", "1790000000.000001", Buffer.from("x"), "src/a.ts");
  await uploadFile(slack, "C000CHAN", "1790000000.000001", Buffer.from("x"), "a.md");
  const asked = slack.callsTo("files.getUploadURLExternal");
  assert.equal(asked[0]?.snippet_type, "typescript");
  assert.ok(!("snippet_type" in (asked[1] ?? {})));
});

test("a .ts that holds binary bytes is left to Slack, and .mts and .tsx are typed", async () => {
  const slack = new FakeSlack();
  await uploadFile(slack, "C000CHAN", "1790000000.000001", Buffer.from("a\0b"), "clip.ts");
  await uploadFile(slack, "C000CHAN", "1790000000.000001", Buffer.from("x"), "a.mts");
  await uploadFile(slack, "C000CHAN", "1790000000.000001", Buffer.from("x"), "a.tsx");
  const asked = slack.callsTo("files.getUploadURLExternal");
  assert.ok(!("snippet_type" in (asked[0] ?? {})));
  assert.equal(asked[1]?.snippet_type, "typescript");
  assert.equal(asked[2]?.snippet_type, "typescript");
});
