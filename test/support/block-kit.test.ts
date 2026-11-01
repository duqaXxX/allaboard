import assert from "node:assert/strict";
import { test } from "node:test";
import { blockFaults, callFaults } from "./block-kit.ts";

const button = (id: string, text = "Go") => ({
  type: "button",
  action_id: id,
  value: "v",
  text: { type: "plain_text", text },
});

test("blocks within the reference's limits have no fault", () => {
  assert.deepEqual(blockFaults([{ type: "actions", elements: [button("a"), button("b")] }]), []);
});

test("an action_id twice in one block is a fault, in two blocks it is not", () => {
  assert.equal(blockFaults([{ type: "actions", elements: [button("a"), button("a")] }]).length, 1);
  const apart = [
    { type: "actions", elements: [button("a")] },
    { type: "actions", elements: [button("a")] },
  ];
  assert.deepEqual(blockFaults(apart), []);
});

test("text and options past their limits are faults, in a message and in a view", () => {
  const long = [{ type: "actions", elements: [button("a", "x".repeat(76))] }];
  assert.equal(blockFaults(long).length, 1);
  assert.equal(callFaults({ view: { blocks: long } }).length, 1);
  const select = {
    type: "static_select",
    action_id: "s",
    options: [{ text: { type: "plain_text", text: "x" }, value: "v".repeat(151) }],
  };
  assert.equal(blockFaults([{ type: "section", accessory: select }]).length, 1);
});
