import { describe, expect, it } from 'vitest';
import { clock } from './clock.svelte.ts';
import { Pause, isPauseKey, mapViewKey } from './pause.svelte.ts';

type Key = Parameters<typeof isPauseKey>[0];

/**
 * Just enough of an element for closest() with the selectors isPauseKey
 * uses: tag names, and [contenteditable] unless it is "false". The tests
 * run without a DOM.
 */
class Fake {
	constructor(
		readonly tag: string,
		readonly parent: Fake | null = null,
		readonly editable: string | null = null
	) {}
	#matches(sel: string): boolean {
		if (sel.startsWith('[contenteditable]'))
			return this.editable !== null && this.editable !== 'false';
		return sel === this.tag;
	}
	closest(selectors: string): Fake | null {
		const list = selectors.split(',').map((x) => x.trim());
		if (list.some((x) => this.#matches(x))) return this;
		return this.parent?.closest(selectors) ?? null;
	}
}

const body = new Fake('body');

function key(k: string, more: Partial<Key> = {}): Key {
	return {
		key: k,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		repeat: false,
		defaultPrevented: false,
		target: body as unknown as EventTarget,
		...more
	};
}

describe('Pause', () => {
	it('starts live, pauses once, and resumes', () => {
		const p = new Pause();
		expect(p.paused).toBe(false);
		expect(p.since).toBeNull();
		p.pause(1000);
		// A second pause keeps the first start, so the pill's count does not reset.
		p.pause(5000);
		expect(p.paused).toBe(true);
		expect(p.since).toBe(1000);
		p.resume();
		expect(p.paused).toBe(false);
		expect(p.since).toBeNull();
	});

	it("holds still for the map's gestures without pausing", () => {
		const p = new Pause();
		p.hold(true, 1000);
		// Each move of the gesture keeps the first start.
		p.hold(true, 1500);
		expect(p.still).toBe(true);
		expect(p.heldSince).toBe(1000);
		expect(p.paused).toBe(false);
		expect(p.since).toBeNull();
		p.hold(false);
		expect(p.still).toBe(false);
		expect(p.heldSince).toBeNull();
		// A pause outlasts a hold that ends inside it.
		p.pause(2000);
		p.hold(true, 2500);
		p.hold(false);
		expect(p.still).toBe(true);
		expect(p.since).toBe(2000);
	});
});

describe('the clock while paused', () => {
	it('holds now at the pause and keeps wall time running', () => {
		const at = Date.now() - 60_000;
		clock.freeze(at);
		const before = Date.now();
		expect(clock.now).toBe(at);
		// Wall time is the real time, not the time of the pause.
		expect(clock.wall).toBeGreaterThanOrEqual(before);
		clock.freeze(null);
		expect(clock.now).toBeGreaterThanOrEqual(before);
	});
});

describe('the P key', () => {
	it('is P or Shift+P on its own', () => {
		expect(isPauseKey(key('p'))).toBe(true);
		expect(isPauseKey(key('P'))).toBe(true);
		expect(isPauseKey(key('o'))).toBe(false);
	});

	it('ignores shortcuts, repeats and handled keys', () => {
		expect(isPauseKey(key('p', { ctrlKey: true }))).toBe(false);
		expect(isPauseKey(key('p', { metaKey: true }))).toBe(false);
		expect(isPauseKey(key('p', { altKey: true }))).toBe(false);
		expect(isPauseKey(key('p', { repeat: true }))).toBe(false);
		expect(isPauseKey(key('p', { defaultPrevented: true }))).toBe(false);
	});

	it('does not fire while typing', () => {
		const editable = new Fake('div', body, 'true');
		const fields = [
			new Fake('input', body),
			new Fake('textarea', body),
			new Fake('select', body),
			editable,
			new Fake('span', editable)
		];
		for (const el of fields)
			expect(isPauseKey(key('p', { target: el as unknown as EventTarget })), el.tag).toBe(false);
		const off = new Fake('div', body, 'false');
		for (const el of [new Fake('button', body), off])
			expect(isPauseKey(key('p', { target: el as unknown as EventTarget })), el.tag).toBe(true);
	});
});

describe('the map view keys', () => {
	// map.e2e.ts checks what +, -, = and 0 do to the map.
	it('leaves browser zoom, repeats and typing alone', () => {
		// The key alone zooms, so the cases below test what they say.
		expect(mapViewKey(key('+'))).not.toBeNull();
		expect(mapViewKey(key('+', { ctrlKey: true }))).toBeNull();
		expect(mapViewKey(key('-', { metaKey: true }))).toBeNull();
		expect(mapViewKey(key('0', { ctrlKey: true }))).toBeNull();
		expect(mapViewKey(key('+', { repeat: true }))).toBeNull();
		expect(mapViewKey(key('-', { defaultPrevented: true }))).toBeNull();
		const field = new Fake('input', body) as unknown as EventTarget;
		expect(mapViewKey(key('0', { target: field }))).toBeNull();
	});
});
