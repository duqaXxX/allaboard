/**
 * The files each turn of a session edited, as the agent reports them call by call
 * (`SessionEvent.call_ended.fileChange`): what `!diff` shows for a turn. Kept in memory for the
 * process that runs: a restart, an idle close and a turn typed in a terminal leave no record.
 */
import type { FileChange } from "../../agent/seam.ts";

// The turns with edits kept; the oldest go. A created file carries its content, so the memory
// this holds is bounded by this and not by the length of the conversation.
export const TURN_CHANGES_KEPT = 50;

/** The edits of one turn: its id (the prompt's `Turn.uuid`), its place among the turns, its files. */
export interface TurnEdits {
  readonly id: string;
  /** 1 for the first prompt this process ran. */
  readonly number: number;
  readonly changes: readonly FileChange[];
}

export class TurnChanges {
  private readonly edits = new Map<string, FileChange[]>();
  private readonly numbers = new Map<string, number>();
  private count = 0;
  private current: string | null = null;

  /** A turn begins for the prompt `id`: the edits that follow, and those of a turn the agent starts, are its. */
  begin(id: string): void {
    this.count += 1;
    // A turn that edited nothing needs no place: only a turn with edits is ever listed.
    if (this.current !== null && !this.edits.has(this.current)) this.numbers.delete(this.current);
    this.numbers.set(id, this.count);
    this.current = id;
  }

  /**
   * `change` happened in the running turn. A turn the agent started for itself (a report) belongs to
   * the prompt before it; before any prompt there is no turn to belong to, and the change is not kept.
   */
  note(change: FileChange): void {
    if (this.current === null) return;
    const held = this.edits.get(this.current);
    if (held === undefined) this.edits.set(this.current, [change]);
    else held.push(change);
    for (const old of this.edits.keys()) {
      if (this.edits.size <= TURN_CHANGES_KEPT) break;
      this.edits.delete(old);
      this.numbers.delete(old);
    }
  }

  /** How many turns' places are held, for a test. */
  get tracked(): number {
    return this.numbers.size;
  }

  /** The turns that edited a file, oldest first. */
  list(): TurnEdits[] {
    return [...this.edits].map(([id, changes]) => ({
      id,
      number: this.numbers.get(id) ?? 0,
      changes,
    }));
  }
}
