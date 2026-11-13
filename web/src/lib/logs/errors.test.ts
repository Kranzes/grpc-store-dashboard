import { describe, expect, it } from 'vitest';
import {
	firstError,
	firstErrorLine,
	isError,
	isMakeError,
	mayMatch,
	nixGist,
	stepError,
	stripAnsi,
	warningRules
} from './errors.ts';

const first = (lines: string[], from = 0) =>
	firstError(lines.length, (i) => stripAnsi(lines[i]), from);

describe('error rules', () => {
	it.each([
		['gcc', "src/hello.c:12:5: error: 'foo' undeclared (first use in this function)"],
		['gcc fatal', 'src/x.c:1:10: fatal error: zlib.h: No such file or directory'],
		['clang without a column', 'main.c:41: error: expected expression'],
		['go', './main.go:12:2: error: undefined: x'],
		['rustc', 'error[E0425]: cannot find value `x` in this scope'],
		['rustc plain', 'error: could not compile `serde`'],
		['cmake', 'CMake Error at CMakeLists.txt:24 (find_package):'],
		['ninja', 'FAILED: src/foo.o'],
		['meson', 'ERROR: Dependency "glib-2.0" not found'],
		['stdenv', 'ERROR: noBrokenSymlinks: the symlink /nix/store/x points to a missing target'],
		[
			'substituteStream',
			"substituteStream() in derivation hello-2.12.1: ERROR: pattern foo doesn't match anything in file 'Makefile'"
		],
		['patch hunk', 'Hunk #2 FAILED at 120.'],
		['patch', 'patch: **** malformed patch at line 14'],
		['automake', 'FAIL: tests/hello-1'],
		['go test', '--- FAIL: TestResolve (0.01s)'],
		['cargo test', 'test result: FAILED. 211 passed; 1 failed; 0 ignored'],
		['pytest', '============================= FAILURES ============================='],
		['tap', 'not ok 41 - handles a long input'],
		['nixos test', '!!! Test "login" failed with error: "action timed out after 900.00 seconds"'],
		['python', 'Traceback (most recent call last):'],
		['curl', 'curl: (6) Could not resolve host: example.org']
	])('%s', (_, line) => {
		expect(isError(line)).toBe(true);
	});

	it.each([
		['configure checks', 'checking for error in -lm... yes'],
		['-Werror', 'gcc -Werror -Wno-error=deprecated -c error.c -o error.o'],
		['a file named error.c', 'CC       src/error.o'],
		['0 errors', 'Build finished with 0 errors and 2 warnings'],
		["automake's summary", '# ERROR: 0'],
		['XFAIL', 'XFAIL: tests/known-bug'],
		['serial output', 'machine # [   41.2] foo: ERROR: x'],
		['a passing test', 'PASS: tests/hello-1']
	])('%s is no error', (_, line) => {
		expect(isError(line)).toBe(false);
		expect(isMakeError(line)).toBe(false);
	});

	it("make's Error line only when nothing else matched", () => {
		const make = 'make: *** [Makefile:1234: all] Error 2';
		expect(isError(make)).toBe(false);
		expect(isMakeError(make)).toBe(true);
		expect(isMakeError('make[3]: *** [Makefile:2100: check-TESTS] Error 1')).toBe(true);
		expect(first(['ok', make, 'more'])).toBe(1);
		expect(first(['ok', make, 'a.c:1:1: error: x'])).toBe(2);
		expect(first(['ok', 'fine'])).toBeNull();
	});

	it('a failed NixOS test\'s first error is its "!!! Test … failed" line', () => {
		const lines = [
			'\x1b[1m\x1b[32msubtest: login\x1b[0m',
			'machine: waiting for unit multi-user.target',
			'machine # [   41.204118] systemd-logind[612]: New session 1 of user alice.',
			'\x1b[31m!!! \x1b[0mTest "login" failed with error: "action timed out after 900.00 seconds"',
			'\x1b[31m!!! \x1b[0mTraceback (most recent call last):',
			'\x1b[31m!!! \x1b[0m'
		];
		expect(first(lines)).toBe(3);
		expect(lines.map(stripAnsi).flatMap((l, i) => (isError(l) ? [i] : []))).toEqual([3, 4, 5]);
	});

	it('the driver\'s empty "!!!" lines count, so a traceback is marked unbroken; a serial line never matches', () => {
		expect(isError('!!! ')).toBe(true);
		expect(isError('!!!')).toBe(true);
		expect(isError(stripAnsi('\x1b[31m!!! \x1b[0m'))).toBe(true);
		expect(isError('!!!x')).toBe(false);
		expect(isError('machine # !!! Test "x" failed')).toBe(false);
		expect(isError('machine # FAIL: x')).toBe(false);
	});

	it('the search starts where it is told', () => {
		const lines = ['a.c:1:1: error: early', 'Running phase: buildPhase', 'b.c:2:2: error: late'];
		expect(first(lines, 1)).toBe(2);
		expect(first(lines, 0)).toBe(0);
	});

	it('warnings: one case per rule, and -Wno- flags and 0 warnings are skipped', () => {
		for (const w of [
			'src/a.c:3:7: warning: unused variable ‘x’ [-Wunused-variable]',
			'warning: unused import: `std::io`',
			'CMake Warning at CMakeLists.txt:5 (message):',
			'ld: warning: dylib was built for newer macOS version',
			'WARNING: Project targets meson >= 1.2'
		])
			expect(mayMatch(w) && warningRules(w), w).toBe(true);
		for (const w of [
			'gcc -Wno-unused-variable -c a.c',
			'Build finished with 0 warnings',
			'checking whether warning flags work... yes',
			'machine # warning: foo'
		])
			expect(mayMatch(w) && warningRules(w), w).toBe(false);
	});
});

/** Nix's message for a failed build, with the last log lines. */
const message = (tail: string[], reason = 'builder failed with exit code 2') =>
	[
		"\x1b[31;1merror:\x1b[0m Cannot build '/nix/store/x-hello.drv'.",
		`       Reason: \x1b[31;1m${reason}\x1b[0m.`,
		'       Output paths:',
		'         /nix/store/x-hello',
		`       Last ${tail.length} log lines:`,
		...tail.map((l) => `       > ${l}`),
		'       For full logs, run:',
		'         nix log /nix/store/x-hello.drv'
	].join('\n');

describe('firstErrorLine', () => {
	it('the first error among the log lines', () => {
		expect(
			firstErrorLine(
				message([
					'gcc -O2 -c -o main.o main.c',
					"main.c:41:5: error: implicit declaration of function 'strlcpy'",
					'make: *** [Makefile:12: all] Error 2'
				])
			)
		).toBe("main.c:41:5: error: implicit declaration of function 'strlcpy'");
	});

	it("make's line when nothing else matched, else the Reason line", () => {
		expect(firstErrorLine(message(['x', 'make: *** [Makefile:12: all] Error 2']))).toBe(
			'make: *** [Makefile:12: all] Error 2'
		);
		expect(firstErrorLine(message(['waiting for the server'], 'builder timed out'))).toBe(
			'builder timed out'
		);
		expect(firstErrorLine('')).toBeNull();
	});

	it('cuts a long line at 200 characters', () => {
		const long = `a.c:1:1: error: ${'x'.repeat(400)}`;
		const line = firstErrorLine(message([long]))!;
		expect(line.length).toBe(200);
		expect(line.endsWith('…')).toBe(true);
	});
});

describe('nixGist', () => {
	it('the Reason line', () => {
		expect(nixGist(message(['Reason: not this one']))).toBe('builder failed with exit code 2');
	});

	it('else the first line', () => {
		const mismatch = [
			"\x1b[31;1merror:\x1b[0m hash mismatch in fixed-output derivation '/nix/store/x-src.drv':",
			'         specified: sha256-AAAA',
			'            got:    sha256-BBBB'
		].join('\n');
		expect(nixGist(mismatch)).toBe(
			"hash mismatch in fixed-output derivation '/nix/store/x-src.drv'"
		);
		expect(nixGist('\n  \n')).toBeNull();
	});
});

describe('stepError', () => {
	const ls = [10, 20, 30];
	it('starts at the first or the last', () => {
		expect(stepError(ls, null, 1)).toBe(10);
		expect(stepError(ls, null, -1)).toBe(30);
		expect(stepError([], null, 1)).toBeNull();
	});
	it('steps and wraps', () => {
		expect(stepError(ls, 10, 1)).toBe(20);
		expect(stepError(ls, 30, 1)).toBe(10);
		expect(stepError(ls, 10, -1)).toBe(30);
		expect(stepError(ls, 20, -1)).toBe(10);
	});
	it('steps from a line that is not in the list', () => {
		// The head's errors went in before the tail's, or the cap left it out.
		expect(stepError([2, 4, 25, 31], 25, 1)).toBe(31);
		expect(stepError([2, 4, 6], 25, 1)).toBe(2);
		expect(stepError([2, 4, 6], 25, -1)).toBe(6);
		expect(stepError([2, 4, 30], 25, -1)).toBe(4);
	});
});
