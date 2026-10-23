/**
 * The reply of a scheduled run: its words go to the thread's loop card (`ThreadChat.showLoop`)
 * instead of a message of their own. A `Reply` so that the turn runs through the renderer, the
 * session's start and end of a turn, and a request it asks, as any other; it shows the run's
 * final words and nothing of the calls, and the footer of the run's end (`setEnd`), which the
 * card carries instead of the reply footer the session draws for an ordinary reply.
 */
import type { FooterFields, LoopCard, Reply, ThreadChat } from "../../chat/seam.ts";

export class LoopReply implements Reply {
  readonly #thread: Pick<ThreadChat, "showLoop">;
  readonly #label: string;
  /** When the run ended, or began until it has: epoch milliseconds. */
  #at: number;
  #footer: FooterFields | null = null;
  /** Everything Claude wrote in the run, message after message. */
  #words = "";
  /** The daemon's own lines (an error, a note), which follow the words. */
  #notices = "";
  /** The run's final words as the agent's result gives them, when it does. */
  #final: string | null = null;
  /** What the card shows is behind what was said: the label alone counts as written once. */
  #written = false;
  #dirty = false;
  #handedOver = false;

  constructor(thread: Pick<ThreadChat, "showLoop">, label: string, startedAt: number) {
    this.#thread = thread;
    this.#label = label;
    this.#at = startedAt;
  }

  // A report of an ended task never renders into the card: it belongs under a normal reply.
  readonly last = false;
  readonly overtaken = false;

  async text(
    markdown: string,
    options: {
      readonly notice?: boolean;
      readonly ending?: boolean;
      readonly aside?: boolean;
    } = {},
  ): Promise<void> {
    if (options.aside === true) return;
    if (options.notice === true || options.ending === true) this.#notices += markdown;
    else this.#words += markdown;
    this.#dirty = true;
  }

  /** The run's final words, from the result that ended it: they replace the running text. */
  setFinal(text: string | null): void {
    this.#final = text;
    this.#dirty = true;
  }

  /** The run's end: the moment it is dated by and the footer of its result. */
  setEnd(footer: FooterFields | null, at: number): void {
    this.#footer = footer;
    this.#at = at;
    this.#dirty = true;
  }

  /**
   * An owner's prompt was taken into this run, so the turn is the owner's: the words are handed
   * back for an ordinary reply and the card is never written for it.
   */
  takeOver(): string {
    this.#handedOver = true;
    return this.#body();
  }

  async task(): Promise<void> {}

  async finish(): Promise<void> {
    await this.#write();
  }

  async closeOut(): Promise<boolean> {
    await this.#write();
    return true;
  }

  async waitLanded(): Promise<boolean> {
    return true;
  }

  async settle(): Promise<boolean> {
    return true;
  }

  rest(): void {}

  async showFooter(): Promise<boolean> {
    return true;
  }

  #body(): string {
    const final = this.#final;
    const words = final !== null && final.trim() !== "" ? final : this.#words;
    return `${words}${this.#notices}`.trim();
  }

  /** One write of the card per change: the label is shown even when the run said nothing. */
  async #write(): Promise<void> {
    if (this.#handedOver || (this.#written && !this.#dirty)) return;
    this.#written = true;
    this.#dirty = false;
    const card: LoopCard = {
      label: this.#label,
      at: this.#at,
      text: this.#body(),
      footer: this.#footer,
    };
    await this.#thread.showLoop(card);
  }
}
