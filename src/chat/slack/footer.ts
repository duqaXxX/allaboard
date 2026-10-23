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
 * A moment as the time of day, Slack's own date formatting: drawn in the time zone and the 12 or
 * 24 hour clock of the device that reads it, with the zone in the fallback. Not escaped: the
 * control sequence must reach Slack as written.
 */
export function slackTime(epochMs: number): string {
  const fallback = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(epochMs);
  return `<!date^${Math.floor(epochMs / 1000)}^{time}|${fallback}>`;
}

/**
 * `34m 17s · done <time>`.
 */
function workPart(work: NonNullable<FooterFields["work"]>): string {
  return `${formatWorkDuration(work.durationMs)} · done ${slackTime(work.doneAt)}`;
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
