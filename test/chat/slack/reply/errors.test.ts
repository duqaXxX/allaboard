import assert from "node:assert/strict";
import { test } from "node:test";
import { WebAPIRequestError } from "@slack/web-api";
import { ChatError } from "../../../../src/chat/seam.ts";
import { crossedError } from "../../../../src/chat/slack/reply/errors.ts";
import { rejected } from "../../../support/fake-slack.ts";

test("an answer of no from Slack crosses as a refusal, named by its code", () => {
  const crossed = crossedError(rejected("invalid_blocks"));
  assert.equal(crossed.name, "invalid_blocks");
  assert.equal(crossed.failure, "refused");
});

test("a call that got no answer crosses as failed", () => {
  const crossed = crossedError(new WebAPIRequestError(new Error("reset")));
  assert.equal(crossed.failure, "failed");
});

test("a failure that is not Slack's crosses as the daemon's own", () => {
  const crossed = crossedError(new TypeError("a bug"));
  assert.equal(crossed.name, "TypeError");
  assert.equal(crossed.failure, "bug");
});

test("a ChatError crosses as it is", () => {
  const error = new ChatError("no_ts");
  assert.equal(crossedError(error), error);
});
