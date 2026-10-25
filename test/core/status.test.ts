import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionStatus } from "../../src/chat/seam.ts";
import { endsWork } from "../../src/core/status.ts";

const STATUSES: readonly (SessionStatus | null)[] = [null, "working", "waiting", "done", "error"];

test("only a change from working or waiting to done or error ends the work", () => {
  const ending = STATUSES.flatMap((previous) =>
    STATUSES.filter((next) => endsWork(previous, next)).map((next) => `${previous}>${next}`),
  );
  assert.deepEqual(ending, ["working>done", "working>error", "waiting>done", "waiting>error"]);
});
