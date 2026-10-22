/** The scheduled jobs of a session (a loop), in the words the owner reads them in. */
import type { ScheduledJob } from "../../agent/seam.ts";
import { oneLine } from "../reply/words.ts";
import { LOOP_PROMPT_LIMIT } from "./constants.ts";

const FIELD = /^\d+$/;
const STEP = /^\*\/(\d+)$/;

function plural(count: number, unit: string): string {
  return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}

/**
 * A cron expression in plain English when it is one of the common shapes (every N minutes,
 * hourly, every N hours, daily at a time), else the expression as written: a guess at what an
 * unusual one means would be worse than showing it.
 */
export function cadence(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return schedule;
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;
  if (day !== "*" || month !== "*" || weekday !== "*") return schedule;
  if (minute === "*" && hour === "*") return "every minute";
  const everyMinutes = STEP.exec(minute)?.[1];
  if (everyMinutes !== undefined && hour === "*" && Number(everyMinutes) > 0) {
    return plural(Number(everyMinutes), "minute");
  }
  if (minute === "0" && hour === "*") return "every hour";
  const everyHours = STEP.exec(hour)?.[1];
  if (minute === "0" && everyHours !== undefined && Number(everyHours) > 0) {
    return plural(Number(everyHours), "hour");
  }
  if (FIELD.test(minute) && FIELD.test(hour) && Number(minute) < 60 && Number(hour) < 24) {
    return `every day at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  return schedule;
}

/** What a job is called to the owner: its cadence, and `once` ahead of it when it fires once. */
export function cadenceOf(job: ScheduledJob): string {
  return job.recurring ? cadence(job.schedule) : `once, ${cadence(job.schedule)}`;
}

/** The job's prompt on one line, shortened. */
export function promptOf(job: ScheduledJob): string {
  return oneLine(job.prompt, LOOP_PROMPT_LIMIT);
}
