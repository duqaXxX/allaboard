/**
 * The probe's tap on Claude Code's stream: every message a session's `Query` yields, as the
 * daemon's own session reads it, so a run can compare its shapes with the fixtures'
 * (`shapes.ts`). The process is the SDK's own spawn, so the claims are proven on the path the
 * daemon takes. Nothing is written: the messages stay in memory until the run ends.
 */

import { type Query, query } from "@anthropic-ai/claude-agent-sdk";

/** The messages a tap has read, in the order the session read them. */
export type Records = unknown[];

/**
 * `run` with every message its `next` yields copied into `into`. Every other member of the
 * query (`interrupt`, `setModel`, `close`...) is the query's own.
 */
export function tapped(run: Query, into: Records): Query {
  const tap: Query = new Proxy(run, {
    get(target, key) {
      if (key === "next") {
        return async (...args: [] | [unknown]) => {
          const step = await target.next(...args);
          if (!step.done) into.push(step.value);
          return step;
        };
      }
      // `for await` asks the query for its iterator: the tap, so that `next` is the one above.
      if (key === Symbol.asyncIterator) return () => tap;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return tap;
}

/** The SDK's `query`, with every message of the session it starts copied into `into`. */
export function tappedQuery(into: Records): typeof query {
  return (params) => tapped(query(params), into);
}
