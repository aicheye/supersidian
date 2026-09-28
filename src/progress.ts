import { Notice } from "obsidian";

/**
 * A notice that stays up while a command runs: its title, a progress bar, what it is on, and the
 * seconds so far (updated each second, so a long step still shows the command is running). The
 * bar moves back and forth until `step` gives a count. `done` and `fail` replace it with the result.
 */
export class Progress {
	private notice = new Notice("", 0);
	private bar: HTMLProgressElement;
	private detail: HTMLDivElement;
	private clock: HTMLSpanElement;
	private started = Date.now();
	private timer: number;

	constructor(title: string) {
		const el = this.notice.noticeEl;
		el.empty();
		el.addClass("supersidian-progress");
		const head = el.createDiv({ cls: "supersidian-progress-title" });
		head.createSpan({ text: title });
		this.clock = head.createSpan({ cls: "supersidian-progress-clock", text: "0 s" });
		this.bar = el.createEl("progress");
		this.detail = el.createDiv({ cls: "supersidian-progress-detail" });
		this.timer = window.setInterval(() => this.clock.setText(`${Math.round((Date.now() - this.started) / 1000)} s`), 1000);
	}

	/** Shows `done` of `total` finished, and what is running now. */
	step(done: number, total: number, what = "") {
		this.bar.max = Math.max(total, 1);
		this.bar.value = done;
		this.detail.setText(total ? `${done} of ${total}${what ? ` · ${what}` : ""}` : what);
	}

	/** Shows what is running now without a count. */
	status(what: string) {
		this.detail.setText(what);
	}

	done(message: string) {
		this.finish(message, 4000);
	}

	fail(message: string) {
		this.finish(message, 10000);
	}

	private finish(message: string, ms: number) {
		window.clearInterval(this.timer);
		const el = this.notice.noticeEl;
		el.empty();
		el.removeClass("supersidian-progress");
		el.setText(message);
		window.setTimeout(() => this.notice.hide(), ms);
	}
}
