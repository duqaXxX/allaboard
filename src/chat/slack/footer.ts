/** The footer as one line of Slack mrkdwn. */

import { basename } from "node:path";
import {
  type FooterField,
  type FooterKey,
  footerFields,
  formatWorkDuration,
  valueWithDetail,
} from "../../core/port.ts";
import type { FooterFields } from "../seam.ts";
import { mrkdwnEscape } from "./reply/escape.ts";

// The footer's fields that come before the folder.
const SESSION: readonly FooterKey[] = ["model", "effort"];

/** A field as the footer writes it: the label in bold (`*ctx* 15%`, the owner's choice). */
function short(field: FooterField): string {
  const { key, value } = field;
  switch (key) {
    case "model":
    case "changes":
      return value;
    case "effort":
      return `*effort* ${valueWithDetail(field)}`;
    case "branch":
      return mrkdwnEscape(value);
    case "tokens":
      return `${value} *tok*`;
    case "context":
      return `*ctx* ${value}`;
    case "session_limit":
      return `*5h* ${value}`;
    case "week_limit":
      return `*7d* ${value}`;
  }
}

/**
 * `34m 17s · done <time>`. The time is Slack's own date formatting, which draws it in the time
 * zone and the 12 or 24 hour clock of the device that reads it; the fallback, for a client that
 * cannot, carries the zone as Slack's page recommends. Not escaped: the control sequence must
 * reach Slack as written.
 */
function workPart(work: NonNullable<FooterFields["work"]>): string {
  const fallback = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(work.doneAt);
  const time = `<!date^${Math.floor(work.doneAt / 1000)}^{time}|${fallback}>`;
  return `${formatWorkDuration(work.durationMs)} · done ${time}`;
}

/**
 * One line: the work's duration and end time, bypass, model and effort, the channel's folder,
 * then branch, changes, tokens, context and limits (the owner's order).
 */
export function formatFooter(data: FooterFields, now: number): string {
  const fields = footerFields(data, now);
  const parts = data.work === null ? [] : [workPart(data.work)];
  if (data.planning) parts.push("⏸ plan");
  else if (data.bypass) parts.push("⚡ bypass");
  parts.push(...fields.filter((f) => SESSION.includes(f.key)).map((f) => short(f)));
  // Its name alone, the project's: the whole path is on `!status`'s Directory line.
  const name = data.folder === null ? "" : basename(data.folder);
  if (name) {
    parts.push(mrkdwnEscape(name));
  }
  parts.push(...fields.filter((f) => !SESSION.includes(f.key)).map((f) => short(f)));
  return parts.join(" · ");
}
