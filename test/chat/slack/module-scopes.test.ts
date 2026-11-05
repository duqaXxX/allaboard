/** The owner's token reads a private channel the bot lost only with the scope `groups:read`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canReadChannels, type OwnerClient } from "../../../src/chat/slack/module.ts";
import { FakeSlack } from "../../support/fake-slack.ts";

const ownerWith = (scopes: readonly string[] | null): OwnerClient => ({
  client: new FakeSlack(),
  scopes,
});

test("channels are read through the owner's token only with groups:read", () => {
  assert.equal(canReadChannels(null), false);
  assert.equal(canReadChannels(ownerWith(null)), false);
  assert.equal(canReadChannels(ownerWith(["chat:write", "pins:write"])), false);
  assert.equal(canReadChannels(ownerWith(["chat:write", "groups:read"])), true);
});
