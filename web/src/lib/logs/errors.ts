// Which log lines are errors and warnings, for the first-error jump, the
// group headers' counts and the build list's error line. Every rule runs
// on the text without ANSI escapes. The log worker and the model share them.

/** Rules for errors, in order. The first rule that matches anywhere wins in firstError. */
const ERRORS: readonly RegExp[] = [
	// Compilers and build tools.
	/^\S+:\d+(?::\d+)?: (?:fatal )?error:/, // gcc, clang, go
	/^error(?:\[E\d+\])?:/, // rustc
	/CMake Error/,
	/^FAILED: /, // ninja
	/^ERROR:/, // meson, stdenv
	/: ERROR: /, // substituteStream() in derivation N: ERROR: …
	/Hunk #\d+ FAILED/,
	/^patch: \*\*\*/,
	// Tests.
	/^FAIL:/, // automake
	/^--- FAIL:/, // go
	/test result: FAILED/, // cargo
	/=+ FAILURES =+/, // pytest
	/^not ok \d+/, // TAP
	// The NixOS test driver, its empty lines too, so a traceback's mark runs unbroken.
	/^!!!(?: |$)/,
	// Others.
	/Traceback \(most recent call last\):/,
	/curl: \(\d+\)/
];

/** make's summary line, an error only when nothing above matched. */
const MAKE = /^make(?:\[\d+\])?: \*\*\* .* Error \d+/;

/** Lines no rule may match. */
const SKIP: readonly RegExp[] = [
	/^checking /, // configure
	/^# (?:ERROR|FAIL|XFAIL): +0\s*$/, // automake's summary
	/^XFAIL:/,
	/^[\w.-]+ # / // a VM's serial output in a NixOS test
];

const WARNINGS: readonly RegExp[] = [
	/^\S+:\d+(?::\d+)?: warning:/, // gcc, clang
	/^warning:/, // rustc, cargo, Nix
	/^CMake Warning/,
	/^ld: warning:/,
	/^WARNING:/ // meson
];

const WARNING_SKIP: readonly RegExp[] = [/^checking /, /\b0 warnings?\b/, /^[\w.-]+ # /];

/** CSI and OSC escapes. */
// eslint-disable-next-line no-control-regex -- escapes are what it matches
const ANSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;

export function stripAnsi(text: string): string {
	return text.includes('\x1b') ? text.replace(ANSI, '') : text;
}

/**
 * A word every error, make and warning rule above needs. Most build lines
 * have none, so one test rules them out instead of thirty. Only whole words
 * count, so a file named error_handling.c has none.
 */
const HINT =
	/error:|^error|Error|ERROR|FAIL|warning:|^warning|Warning|WARNING|!!!|^not ok|Traceback|curl: \(|\*\*\*/;

/** Whether any rule could match. False means no error, make error or warning. */
export function mayMatch(text: string): boolean {
	return HINT.test(text);
}

function skipped(text: string): boolean {
	for (const r of SKIP) if (r.test(text)) return true;
	return false;
}

/** An error by any rule but make's fallback. `text` without ANSI. */
export function isError(text: string): boolean {
	return HINT.test(text) && errorRules(text);
}

/** make's "*** … Error N" line. */
export function isMakeError(text: string): boolean {
	return HINT.test(text) && makeRule(text);
}

/** The rules alone, for a caller that already knows `mayMatch(text)`. */
export function errorRules(text: string): boolean {
	if (skipped(text)) return false;
	for (const r of ERRORS) if (r.test(text)) return true;
	return false;
}

export function makeRule(text: string): boolean {
	return !skipped(text) && MAKE.test(text);
}

export function warningRules(text: string): boolean {
	for (const r of WARNING_SKIP) if (r.test(text)) return false;
	for (const r of WARNINGS) if (r.test(text)) return true;
	return false;
}

/**
 * The first error line at or after `from`, 0-based, by the rules above, or
 * else the first make error line, or null. `line(i)` gives line i without ANSI.
 */
export function firstError(count: number, line: (i: number) => string, from = 0): number | null {
	let make: number | null = null;
	for (let i = Math.max(0, from); i < count; i++) {
		const t = line(i);
		if (isError(t)) return i;
		if (make === null && isMakeError(t)) make = i;
	}
	return make;
}

/**
 * The error line after line `at` with dir 1, or before it with dir -1, from
 * a sorted list, wrapping at the ends. `at` is a line, not an index, so it
 * stays right when lines go in before it, as a head after its tail does.
 * With a null `at`, the first or last.
 */
export function stepError(lines: readonly number[], at: number | null, dir: 1 | -1): number | null {
	const n = lines.length;
	if (n === 0) return null;
	if (at === null) return lines[dir > 0 ? 0 : n - 1];
	if (dir > 0) return lines.find((l) => l > at) ?? lines[0];
	return lines.findLast((l) => l < at) ?? lines[n - 1];
}

/** The longest error line a build list row keeps. */
export const ERROR_LINE_MAX = 200;

/**
 * The line a failed build's list row shows, from Nix's message: the first
 * error among its "> " log lines, else its Reason line. null without either.
 */
export function firstErrorLine(errorText: string): string | null {
	const logged: string[] = [];
	for (const l of stripAnsi(errorText).split('\n')) {
		const m = /^\s*> ?(.*)$/.exec(l);
		if (m) logged.push(m[1]);
	}
	const i = firstError(logged.length, (k) => logged[k]);
	const pick = i === null ? reasonLine(errorText) : logged[i].trim();
	if (!pick) return null;
	return pick.length > ERROR_LINE_MAX ? `${pick.slice(0, ERROR_LINE_MAX - 1)}…` : pick;
}

/** The Reason line of Nix's message, such as "builder failed with exit code 2". */
function reasonLine(errorText: string): string | null {
	for (const l of stripAnsi(errorText).split('\n')) {
		const r = /^\s*Reason: (.+?)\.?\s*$/.exec(l);
		if (r) return r[1];
	}
	return null;
}

/**
 * Nix's message in one line, for the log viewer's folded "Nix reported":
 * the Reason line, else the first line without "error: ".
 */
export function nixGist(errorText: string): string | null {
	const first = stripAnsi(errorText)
		.split('\n')
		.find((l) => l.trim())
		?.trim()
		.replace(/^error: /, '')
		.replace(/[.:]$/, '');
	return reasonLine(errorText) ?? (first || null);
}
