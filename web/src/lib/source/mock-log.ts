// The demo's build logs, generated from the seed, line by line on demand.
// A plan is pure: every choice comes from hash32 of the seed, the
// derivation and its assignment, never from the farm's Rng, so a seed
// draws the same farm whatever the log options are.
//
// A log is a list of blocks: a stdenv phase is its two marker lines, its
// body and stdenv's footer when it took 30 s or more; a NixOS test has no
// phases, only the driver's blocks as nixosTests.openbao prints them: start
// all VLans, run the VM test script with the VM's start, its boot and the
// subtests, then cleanup. While a build runs it shows the lines its time
// reached, through its last long phase or subtest. Install, fixup and the
// test's end come when it finishes, and a failure appends what that failure
// prints.

import { DrvGone_Outcome, DrvGone_Status } from '#lib/gen/events_pb.ts';

export type LogPlanInput = Readonly<{
	seed: number;
	drvPath: string;
	/** The derivation name, without hash and ".drv". */
	name: string;
	system: string;
	assignId: number;
	/** The build's duration in simulated ms. Default: from the hash. */
	plannedMs?: number;
	/** Scales the line count, 0.01 to 100. Default 1. */
	logsize?: number;
}>;

export type LogProfile =
	| 'autotools'
	| 'cmake'
	| 'meson'
	| 'cargo'
	| 'go'
	| 'node'
	| 'python'
	| 'cabal'
	| 'perl'
	| 'kernel'
	| 'nixos-test'
	| 'image';

/** One run of lines that come from one generator. Times in simulated ms from the build's start. */
type Block = {
	/** First line, 0-based. */
	start: number;
	count: number;
	gen: (k: number) => string;
	/** Shown from t0, all of it by t1. */
	t0: number;
	t1: number;
	/** Only once the build ended: install, fixup, installCheck, the test's end. */
	ending: boolean;
};

type Phase = Readonly<{
	name: string;
	t0: number;
	t1: number;
	long: boolean;
	ending: boolean;
	/** The line after its body: where a failure in it cuts in, before the footer. */
	bodyEnd: number;
}>;

export type LogPlan = Readonly<{
	input: LogPlanInput;
	profile: LogProfile;
	/** The plan's hash, the base of every line's choice. */
	h: number;
	plannedMs: number;
	darwin: boolean;
	blocks: readonly Block[];
	/** Lines of the log as a BUILT build leaves it. */
	total: number;
	/** Lines before the first ending block: the most a running build shows. */
	runningMax: number;
	/** Where a failure cuts the log: the end of the last long phase's body, or inside a subtest. */
	failAt: number;
	/** stdenv phases with their times; empty for a NixOS test. */
	phases: readonly Phase[];
	/** The failing subtest of a NixOS test, and the subtests around it, innermost first. */
	failingSubtests: readonly string[];
}>;

// ------------------------------------------------------------------ hashes

/** FNV-1a over strings and numbers, mixed. */
export function hash32(...parts: readonly (string | number)[]): number {
	let h = 2166136261;
	for (const p of parts) {
		const s = typeof p === 'number' ? String(p) : p;
		for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
		h = Math.imul(h ^ 0xff, 16777619);
	}
	// A final mix so nearby inputs spread.
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/** The k-th draw in [0, 1) of a plan's hash. */
function draw(h: number, k: number): number {
	let x = (h ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
	x ^= x >>> 15;
	x = Math.imul(x, 0x2c1b3c6d);
	x ^= x >>> 12;
	x = Math.imul(x, 0x297a2d39);
	x ^= x >>> 15;
	return (x >>> 0) / 4294967296;
}

const pick = <T>(xs: readonly T[], r: number): T => xs[Math.floor(r * xs.length) % xs.length];

/** A normal draw from two uniform ones. */
export function normal(a: number, b: number): number {
	return Math.sqrt(-2 * Math.log(1 - a)) * Math.cos(2 * Math.PI * b);
}

/** Nix's base32 alphabet, for store hashes. */
export const NIX_BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';
function storeHash(h: number): string {
	let s = '';
	for (let i = 0; i < 32; i++) s += NIX_BASE32[Math.floor(draw(h, i) * 32)];
	return s;
}

// ----------------------------------------------------------------- profiles

const AUTOTOOLS = [
	'hello',
	'openssl',
	'zlib',
	'curl',
	'coreutils',
	'bash',
	'ncurses',
	'gnumake',
	'sqlite',
	'libxml2',
	'glibc',
	'gcc'
];
const CMAKE = ['cmake', 'llvm', 'boost', 'qtbase', 'protobuf', 'grpc'];
const MESON = ['meson', 'systemd'];
const CARGO = ['rustc', 'cargo-vendor'];

/** The profile of a derivation, by its name. */
export function profileOf(name: string, h: number): LogProfile {
	const base = name.replace(/-\d.*$/, '');
	if (name.startsWith('linux-')) return 'kernel';
	if (/-vm-test-\d+$/.test(name) || /^(?:vm|container)(?:-and-vm)?-test-run-/.test(name))
		return 'nixos-test';
	if (/-image-\d+$/.test(name)) return 'image';
	if (AUTOTOOLS.includes(base)) return 'autotools';
	if (CMAKE.includes(base)) return 'cmake';
	if (MESON.includes(base)) return 'meson';
	if (CARGO.includes(base)) return 'cargo';
	if (base === 'go') return 'go';
	if (base === 'nodejs') return 'node';
	if (name.startsWith('python3')) return 'python';
	if (base === 'ghc' || name.startsWith('haskell-')) return 'cabal';
	if (name.startsWith('perl5')) return 'perl';
	// A client project's derivation, such as api-server-12.
	if (/^[a-z]+-[a-z]+-\d+$/.test(name))
		return pick(['cargo', 'go', 'node', 'python'] as const, draw(h, 900));
	return 'autotools';
}

const TYPICAL: Record<LogProfile, number> = {
	autotools: 1500,
	cmake: 4000,
	meson: 3000,
	cargo: 2500,
	go: 1200,
	node: 6000,
	python: 900,
	cabal: 2000,
	perl: 300,
	kernel: 710_000,
	'nixos-test': 2500,
	image: 400
};

// ------------------------------------------------------------------- text

const ESC = '\x1b';
const green = (s: string) => `${ESC}[0;32m${s}${ESC}[m`;
/** The NixOS test driver's nested() styles the whole line. A machine's own step has its name in front. */
const nested = (s: string) => `${ESC}[1m${ESC}[32m${s}${ESC}[0m`;
const driverError = (s: string) => `${ESC}[31m!!! ${ESC}[0m${s}`;
/** The pid of a NixOS test's VM. */
const qemuPid = (h: number) => 1000 + (h % 8000);
/** The driver's cleanup, which it runs after the test script whether that passed or failed. */
const cleanup = (pid: number) => [
	nested('cleanup'),
	`kill QemuMachine (pid ${pid})`,
	`machine # qemu-system-x86_64: terminating on signal 15 from pid ${pid - 3} (/nix/store/python3-3.12.9/bin/python3.12)`,
	'(finished: cleanup, in 0.02 seconds)'
];

const FILES = [
	'main',
	'util',
	'parse',
	'buffer',
	'hash',
	'list',
	'io',
	'config',
	'error',
	'string',
	'signal',
	'net',
	'xmalloc',
	'progname'
];
const DIRS = ['src', 'lib', 'gnulib/lib', 'src/core', 'src/util', 'tests'];
const CRATES = [
	'serde v1.0.219',
	'proc-macro2 v1.0.94',
	'quote v1.0.40',
	'syn v2.0.100',
	'libc v0.2.171',
	'tokio v1.44.1',
	'hyper v1.6.0',
	'regex v1.11.1',
	'anyhow v1.0.97',
	'clap v4.5.35'
];
const GO_PKGS = [
	'net/http',
	'encoding/json',
	'internal/cache',
	'cmd/server',
	'pkg/api',
	'pkg/store'
];
const HS = [
	'Data.Aeson.Types',
	'Data.Aeson.Parser',
	'Data.Text.Internal',
	'Control.Monad.State',
	'GHC.Hs.Expr'
];
const KDIRS = [
	'drivers/net/ethernet/mellanox/mlx5/core/steering',
	'drivers/gpu/drm/amd/display/dc/dml/dcn32',
	'drivers/gpu/drm/i915/display',
	'drivers/net/wireless/realtek/rtw89',
	'arch/x86/kvm/vmx',
	'net/netfilter/ipvs',
	'fs/btrfs/tests',
	'drivers/scsi/mpt3sas',
	'sound/soc/intel/boards',
	'drivers/media/platform/qcom/venus',
	'drivers/infiniband/hw/mlx5'
];
const KFILES = [
	'amdgpu_dm_mst_types_helper',
	'nf_conntrack_proto_tcp_window',
	'intel_display_power_well_ops',
	'mlx5_flow_table_steering_rules',
	'extent-tree-delayed-refs',
	'mpt3sas_scsih_error_handling',
	'uvc_video_queue_buffers',
	'fair_sched_group_bandwidth'
];
const UNITS = [
	'multi-user.target',
	'nginx.service',
	'postgresql.service',
	'sshd.service',
	'network-online.target'
];
const SUBTESTS = [
	'boot',
	'networking',
	'login',
	'services start',
	'api responds',
	'database migrates',
	'backup runs',
	'firewall'
];

function storePath(h: number, k: number, name: string): string {
	return `/nix/store/${storeHash(hash32(h, k))}-${name}`;
}

/** A command line of 300 to 2,000 characters, as compilers print them. */
function longCommand(h: number, i: number, file: string, out: string): string {
	const n = 8 + Math.floor(draw(h, i * 7 + 3) * 45);
	const flags: string[] = [];
	for (let k = 0; k < n; k++)
		flags.push(
			k % 3 === 0
				? `-I${storePath(h, k, pick(['zlib-1.3.1-dev', 'openssl-3.4.1-dev', 'glib-2.82.4-dev', 'libxml2-2.13.6-dev'], draw(h, k)))}/include`
				: pick(
						[
							'-O2',
							'-g',
							'-Wall',
							'-Wextra',
							'-fPIC',
							'-pipe',
							'-DNDEBUG',
							'-D_FORTIFY_SOURCE=3',
							'-fstack-protector-strong',
							'-std=gnu17'
						],
						draw(h, i + k)
					)
		);
	return `gcc -DHAVE_CONFIG_H -I. ${flags.join(' ')} -c -o ${out} ${file}`;
}

/** A linker command of about 20,000 characters. */
function linkerLine(h: number): string {
	const objs: string[] = [];
	let len = 0;
	for (let k = 0; len < 20_000; k++) {
		const o = `${pick(DIRS, draw(h, k))}/${pick(FILES, draw(h, k + 1))}${k}.o`;
		objs.push(o);
		len += o.length + 1;
	}
	return `gcc -o bin/program ${objs.join(' ')} -lz -lssl -lcrypto -lpthread`;
}

function gccWarning(h: number, i: number): string {
	const f = `${pick(DIRS, draw(h, i))}/${pick(FILES, draw(h, i + 1))}.c`;
	const l = 10 + Math.floor(draw(h, i + 2) * 900);
	return `${ESC}[01m${ESC}[K${f}:${l}:5:${ESC}[m${ESC}[K ${ESC}[01;35m${ESC}[Kwarning: ${ESC}[m${ESC}[Kunused variable ‘tmp’ [${ESC}[01;35m${ESC}[K-Wunused-variable${ESC}[m${ESC}[K]`;
}

// --------------------------------------------------------------- phase bodies

type Ctx = { h: number; name: string; out: string; darwin: boolean; big: boolean };

function phaseLine(p: LogProfile, phase: string, c: Ctx, k: number, n: number): string {
	const { h } = c;
	const r = draw(h, k * 31 + phase.length);
	const r2 = draw(h, k * 31 + 17);
	const file = `${pick(DIRS, r)}/${pick(FILES, r2)}`;
	switch (phase) {
		case 'unpackPhase':
			if (k === 0) return `unpacking source archive ${storePath(h, 1, `${c.name}.tar.xz`)}`;
			if (k === 1) return `source root is ${c.name}`;
			if (k === 2 && draw(h, 5) < 0.3)
				return `Receiving objects:  12% (120/1000)\rReceiving objects:  57% (570/1000)\rReceiving objects: 100% (1000/1000), 4.20 MiB | 12.00 MiB/s, done.`;
			return `setting SOURCE_DATE_EPOCH to timestamp ${1_700_000_000 + (h % 9_000_000)} of file "${c.name}/ChangeLog"`;
		case 'patchPhase':
			return k % 2 === 0
				? `applying patch ${storePath(h, k + 7, 'fix-cross-build.patch')}`
				: `patching file ${file}.c`;
		case 'configurePhase':
			if (k === 0)
				return p === 'cmake'
					? `cmake flags: -DCMAKE_INSTALL_PREFIX=${c.out} -DCMAKE_BUILD_TYPE=Release -GNinja`
					: p === 'meson'
						? `meson flags: --prefix=${c.out} --buildtype=plain --wrap-mode=nodownload`
						: `configure flags: --prefix=${c.out} --disable-dependency-tracking --enable-shared`;
			switch (p) {
				case 'cmake':
					return k === n - 1
						? '-- Generating done (0.4s)'
						: pick(
								[
									'-- Looking for pthread.h - found',
									'-- Performing Test HAVE_STDATOMIC - Success',
									'-- Found ZLIB: /nix/store/zlib/lib/libz.so (found version "1.3.1")',
									'-- Check if compiler accepts -pthread - yes'
								],
								r
							);
				case 'meson':
					return k === n - 1
						? 'Build targets in project: 412'
						: pick(
								[
									'Checking for function "mmap" : YES',
									'Run-time dependency glib-2.0 found: YES 2.82.4',
									'Compiler for C supports arguments -Wno-unused: YES',
									'Has header "sys/epoll.h" : YES'
								],
								r
							);
				case 'kernel':
					return `  HOSTCC  scripts/${pick(['basic/fixdep', 'kconfig/conf.o', 'kconfig/confdata.o', 'kconfig/expr.o'], r)}`;
				case 'perl':
					return pick(
						[
							'Checking if your kit is complete...',
							'Looks good',
							'Generating a Unix-style Makefile',
							'Writing Makefile for JSON',
							'Writing MYMETA.yml and MYMETA.json'
						],
						r
					);
				case 'node':
					return pick(
						[
							'gyp info it worked if it ends with ok',
							'gyp info using node-gyp@11.1.0',
							"gyp info spawn args [ '--generator=ninja' ]",
							'Node.js configure: Found Python 3.12.9...'
						],
						r
					);
				default:
					return k === n - 1
						? 'config.status: creating Makefile'
						: `checking ${pick(['for gcc', 'whether the C compiler works', 'for C compiler default output file name', 'for suffix of object files', 'whether we are using the GNU C compiler', 'for a thread-safe mkdir -p', 'for stdint.h', 'for unistd.h', 'whether byte ordering is bigendian', 'for working mmap'], r)}... ${pick(['yes', 'no', 'gcc', '.o', 'none needed'], r2)}`;
			}
		case 'buildPhase':
			if (k === 0) return `build flags: -j16 SHELL=${storePath(h, 3, 'bash-5.3p20')}/bin/bash`;
			if (c.big && k === Math.floor(n / 2)) return linkerLine(h);
			switch (p) {
				case 'cmake':
					return `[${String(Math.floor((k / n) * 100)).padStart(3)}%] Building CXX object ${file}.cc.o`;
				case 'meson':
					return `[${k}/${n}] Compiling C object ${file}.c.o`;
				case 'node':
					return `[${k}/${n}] CXX obj/src/${pick(FILES, r)}.o`;
				case 'cargo':
					return `   Compiling ${pick(CRATES, r)}`;
				case 'go':
					return `github.com/example/${c.name.replace(/-\d+$/, '')}/${pick(GO_PKGS, r)}`;
				case 'python':
					return pick(
						[
							`copying ${file}.py -> build/lib/${file}.py`,
							'running build_py',
							'running egg_info',
							`creating build/lib/${pick(DIRS, r)}`
						],
						r2
					);
				case 'cabal':
					return `[${String(k).padStart(3)} of ${n}] Compiling ${pick(HS, r)} ( src/${pick(HS, r).replaceAll('.', '/')}.hs, dist/build/${pick(HS, r).replaceAll('.', '/')}.o )`;
				case 'perl':
					return `cp lib/JSON/${pick(['PP', 'XS', 'backportPP'], r)}.pm blib/lib/JSON/${pick(['PP', 'XS', 'backportPP'], r)}.pm`;
				case 'image':
					return `Creating layer ${k} from paths: ['${storePath(h, k, pick(['glibc-2.40-66', 'bash-5.2p37', 'openssl-3.4.1', 'zlib-1.3.1'], r))}']`;
				case 'kernel': {
					const d = pick(KDIRS, r);
					const f = pick(KFILES, r2);
					return k % 23 === 0
						? `  LD [M]  ${d}/${f}.ko`
						: k % 47 === 0
							? `  AR      ${d}/built-in.a`
							: `  CC      ${d}/${f}${k % 7}.o`;
				}
				default:
					if (k % 97 === 13) return gccWarning(h, k);
					if (k % 29 === 5) return longCommand(h, k, `${file}.c`, `${file}.o`);
					if (k % 11 === 0)
						return `make[2]: Entering directory '/build/${c.name}/${pick(DIRS, r)}'`;
					return `  CC       ${file}.o`;
			}
		case 'checkPhase':
			if (k === 0) return 'check flags: -j16 VERBOSE=y check';
			switch (p) {
				case 'cmake':
					return `${String(k).padStart(4)}/${n} Test #${k}: unit_${pick(FILES, r)} ...........   Passed    0.${String(Math.floor(r2 * 99)).padStart(2, '0')} sec`;
				case 'meson':
					return k === n - 1
						? `Ok:                 ${n - 1}`
						: `${String(k).padStart(3)}/${n} ${pick(FILES, r)}-test  OK  0.${Math.floor(r2 * 99)}s`;
				case 'cargo':
					return k === n - 1
						? `test result: ok. ${n - 2} passed; 0 failed; 0 ignored`
						: `test tests::${pick(FILES, r)}_${k} ... ok`;
				case 'go':
					return `ok  \t${pick(GO_PKGS, r)}\t${(r2 * 20).toFixed(3)}s`;
				case 'python':
					if (k % 41 === 7)
						return `${ESC}[38;5;208m⚠ deprecated: pkg_resources is deprecated as an API${ESC}[0m`;
					if (k % 53 === 11)
						return `${ESC}[38;2;30;60;160m━━━━━━━━━━━━━━━━━━━━ ${Math.floor(r * 100)}% ━━━━━━━━━━━━━━━━━━━━${ESC}[0m`;
					return `tests/test_${pick(FILES, r)}.py ${'.'.repeat(1 + Math.floor(r2 * 30))}  [${String(Math.floor((k / n) * 100)).padStart(3)}%]`;
				case 'perl':
					return `t/${String(k).padStart(2, '0')}-${pick(FILES, r)}.t .. ok`;
				default:
					return `${green('PASS')}: tests/${c.name.replace(/-\d.*$/, '')}-${k}`;
			}
		case 'installPhase':
			if (k === 0)
				return `install flags: -j16 SHELL=${storePath(h, 3, 'bash-5.3p20')}/bin/bash install`;
			return k % 2
				? ` ${storePath(h, 4, 'coreutils-9.6')}/bin/mkdir -p '${c.out}/${pick(['bin', 'lib', 'share/man/man1', 'share/info'], r)}'`
				: `  ${storePath(h, 4, 'coreutils-9.6')}/bin/install -c ${pick(FILES, r)} '${c.out}/bin'`;
		case 'fixupPhase': {
			const lines = c.darwin
				? [
						`checking for references to /private/tmp/ in ${c.out}...`,
						`patching script interpreter paths in ${c.out}`,
						`stripping (with command strip and flags -S) in  ${c.out}/lib ${c.out}/bin`
					]
				: [
						`shrinking RPATHs of ELF executables and libraries in ${c.out}`,
						`shrinking ${c.out}/bin/${c.name.replace(/-\d.*$/, '')}`,
						`checking for references to /build/ in ${c.out}...`,
						`patchelf --set-rpath ${c.out}/lib ${c.out}/bin/${c.name.replace(/-\d.*$/, '')}`,
						`patching script interpreter paths in ${c.out}`,
						`stripping (with command strip and flags -S -p) in  ${c.out}/lib ${c.out}/bin`
					];
			return lines[k % lines.length];
		}
		case 'installCheckPhase':
			return k === 0
				? 'installCheck flags: VERBOSE=y installcheck'
				: `${c.out}/bin/${c.name.replace(/-\d.*$/, '')} --version`;
		default:
			return '';
	}
}

/** stdenv's footer for a phase that took 30 s or more, else null. */
export function phaseFooter(name: string, ms: number): string | null {
	const delta = Math.floor(ms / 1000);
	if (delta < 30) return null;
	const H = Math.floor(delta / 3600);
	const M = Math.floor((delta % 3600) / 60);
	const S = delta % 60;
	return `${name} completed in ${H > 0 ? `${H} hours ` : ''}${M > 0 ? `${M} minutes ` : ''}${S} seconds`;
}

// ------------------------------------------------------------------- plan

const KB_STDENV: readonly {
	name: string;
	lines: number;
	time: number;
	ending?: true;
	long?: true;
}[] = [
	{ name: 'unpackPhase', lines: 0.004, time: 0.02 },
	{ name: 'patchPhase', lines: 0.002, time: 0.01 },
	{ name: 'configurePhase', lines: 0.18, time: 0.2, long: true },
	{ name: 'buildPhase', lines: 0.62, time: 0.57, long: true },
	{ name: 'checkPhase', lines: 0.17, time: 0.2, long: true },
	{ name: 'installPhase', lines: 0.015, time: 0, ending: true },
	{ name: 'fixupPhase', lines: 0.006, time: 0, ending: true },
	{ name: 'installCheckPhase', lines: 0.003, time: 0, ending: true }
];
/** At least this many body lines per phase. */
const MIN_BODY: Record<string, number> = {
	unpackPhase: 3,
	patchPhase: 1,
	configurePhase: 4,
	buildPhase: 6,
	checkPhase: 3,
	installPhase: 6,
	fixupPhase: 3,
	installCheckPhase: 2
};

export function planLog(input: LogPlanInput): LogPlan {
	const h = hash32(input.seed, input.drvPath, input.assignId, 'log');
	const profile = profileOf(input.name, h);
	const logsize = Math.min(100, Math.max(0.01, input.logsize ?? 1));
	const plannedMs =
		input.plannedMs && input.plannedMs > 0
			? input.plannedMs
			: Math.min(3_600_000, 20_000 * Math.exp(1.2 * normal(draw(h, 1), draw(h, 2))));
	const darwin = input.system.endsWith('-darwin');
	let lines =
		profile === 'kernel'
			? TYPICAL.kernel
			: Math.min(
					200_000,
					Math.max(40, TYPICAL[profile] * Math.exp(0.9 * normal(draw(h, 3), draw(h, 4))))
				);
	lines = Math.max(profile === 'nixos-test' ? 60 : 40, Math.round(lines * logsize));
	const ctx: Ctx = {
		h,
		name: input.name,
		out: `/nix/store/${input.drvPath.slice(0, 32)}-${input.name}`,
		darwin,
		big: lines >= 10_000
	};
	if (profile === 'nixos-test') return planTest(input, h, plannedMs, lines);

	const blocks: Block[] = [];
	const phases: Phase[] = [];
	let start = 0;
	const add = (
		count: number,
		gen: (k: number) => string,
		t0: number,
		t1: number,
		ending: boolean
	) => {
		if (count <= 0) return;
		blocks.push({ start, count, gen, t0, t1, ending });
		start += count;
	};
	const check = profile !== 'image' && profile !== 'kernel' && draw(h, 6) < 0.6;
	const installCheck = draw(h, 7) < 0.25;
	const chosen = KB_STDENV.filter(
		(p) =>
			(p.name !== 'checkPhase' || check) &&
			(p.name !== 'installCheckPhase' || installCheck) &&
			(profile !== 'kernel' || p.name !== 'patchPhase' || draw(h, 8) < 0.5)
	);
	const timeSum = chosen.reduce((s, p) => s + p.time, 0);
	const lineSum = chosen.reduce((s, p) => s + p.lines, 0);
	let t = 0;
	for (const p of chosen) {
		// The kernel prints nearly everything while it builds.
		const share =
			profile === 'kernel'
				? p.name === 'buildPhase'
					? 0.975
					: p.name === 'configurePhase'
						? 0.02
						: 0
				: p.lines / lineSum;
		const body = Math.max(MIN_BODY[p.name] ?? 1, Math.round(lines * share));
		const dt = p.ending ? 0 : (plannedMs * p.time) / timeSum;
		const t0 = t;
		const t1 = t + dt;
		const name = p.name;
		const ending = !!p.ending;
		add(
			2,
			(k) =>
				k === 0 ? `Running phase: ${name}` : `@nix { "action": "setPhase", "phase": "${name}" }`,
			t0,
			t0,
			ending
		);
		add(body, (k) => phaseLine(profile, name, ctx, k, body), t0, t1, ending);
		const bodyEnd = start;
		const footer = ending ? null : phaseFooter(name, dt);
		if (footer) add(1, () => footer, t1, t1, ending);
		phases.push({ name, t0, t1, long: !!p.long, ending, bodyEnd });
		t = t1;
	}
	const firstEnding = blocks.find((b) => b.ending);
	const runningMax = firstEnding ? firstEnding.start : start;
	// A failure cuts in after the last long phase's body: a phase that fails prints no footer.
	const lastLong = phases.findLast((p) => p.long) ?? phases[phases.length - 1];
	return {
		input,
		profile,
		h,
		plannedMs,
		darwin,
		blocks,
		total: start,
		runningMax,
		failAt: lastLong?.bodyEnd ?? runningMax,
		phases,
		failingSubtests: []
	};
}

type TestNode = { name: string; lines: number; child?: TestNode };

/** A NixOS test: no phases, the driver's blocks, and the subtests in "run the VM test script". */
function planTest(input: LogPlanInput, h: number, plannedMs: number, lines: number): LogPlan {
	const blocks: Block[] = [];
	let start = 0;
	const add = (
		count: number,
		gen: (k: number) => string,
		t0: number,
		t1: number,
		ending = false
	) => {
		if (count <= 0) return;
		blocks.push({ start, count, gen, t0, t1, ending });
		start += count;
	};
	const pid = qemuPid(h);
	const consoleLines = [
		'systemd[1]: Started Journal Service.',
		'systemd[1]: Reached target Local File Systems.',
		'kernel: virtio_net virtio0 eth1: renamed from eth0',
		'systemd-logind[612]: New session 1 of user alice.',
		'dhcpcd[701]: eth1: adding default route via 192.168.1.1',
		'systemd[1]: Starting nginx.service...',
		'kernel: EXT4-fs (vda): mounted filesystem with ordered data mode.'
	];
	const serial = (k: number, at: number, msg = pick(consoleLines, draw(h, k * 13 + 5))) =>
		`machine # [${at.toFixed(6).padStart(12)}] ${msg}`;
	const bodyLine = (k: number, base: number) => {
		const r = draw(h, k * 7 + base);
		const unit = pick(UNITS, draw(h, k + base));
		if (r < 0.45) return serial(k + base, 2 + (k + base) * 0.137);
		if (r < 0.6) return `machine: ${nested(`must succeed: systemctl is-active ${unit}`)}`;
		if (r < 0.75)
			return `machine: (finished: must succeed: systemctl is-active ${unit}, in 0.${String(Math.floor(r * 99)).padStart(2, '0')} seconds)`;
		if (r < 0.88) return `machine: ${nested(`waiting for unit ${unit}`)}`;
		return `machine: (finished: waiting for unit ${unit}, in ${(r * 20).toFixed(2)} seconds)`;
	};
	// The driver's first lines, as nixosTests.openbao prints them, then the VM's boot.
	const opening = [
		'Machine state will be reset. To keep it, pass --keep-machine-state',
		nested('start all VLans'),
		'(finished: start all VLans, in 0.00 seconds)',
		'Test will time out and terminate in 3600.0 seconds',
		nested('run the VM test script'),
		'additionally exposed symbols:',
		'    machine,',
		'    vlan1,',
		'    start_all, test_script, machines, machines_qemu, machines_nspawn, vlans, driver, log, os, create_machine, subtest, run_tests, join_all, retry, serial_stdout_off, serial_stdout_on, polling_condition, BaseMachine, QemuMachine, NspawnMachine, t, debug, dump_machine_ssh',
		nested('start all VMs'),
		'machine: starting vm',
		`machine: QEMU running (pid ${pid})`,
		'(finished: start all VMs, in 0.25 seconds)',
		`machine: ${nested('waiting for unit multi-user.target')}`,
		'machine # [    0.000000] Linux version 6.12.21 (nixbld@localhost) (gcc (GCC) 14.2.1) #1-NixOS SMP PREEMPT_DYNAMIC'
	];
	const bootLines = Math.max(opening.length + 2, Math.round(lines / 4));
	const nSub = 3 + Math.floor(draw(h, 20) * 10);
	const nest = draw(h, 21) < 0.2 ? Math.floor(draw(h, 22) * nSub) : -1;
	const names: string[] = [];
	for (let i = 0; i < nSub; i++) {
		const n = SUBTESTS[(Math.floor(draw(h, 30) * SUBTESTS.length) + i) % SUBTESTS.length];
		names.push(i >= SUBTESTS.length ? `${n} ${Math.floor(i / SUBTESTS.length) + 1}` : n);
	}
	const per = Math.max(6, Math.floor((lines - bootLines - 10) / nSub));
	const tests: TestNode[] = names.map((name) => ({ name, lines: per }));
	if (nest >= 0 && nest < tests.length - 1) {
		const child = tests.splice(nest + 1, 1)[0];
		tests[nest].child = { ...child, lines: Math.max(4, Math.floor(child.lines / 2)) };
	}
	// The boot takes a fifth of the time, the subtests the rest, and the end comes at the finish.
	const bootT = plannedMs * 0.2;
	add(
		bootLines,
		(k) => {
			if (k < opening.length) return opening[k];
			if (k === bootLines - 1)
				return `machine: (finished: waiting for unit multi-user.target, in ${(8 + draw(h, 40) * 20).toFixed(2)} seconds)`;
			return serial(k, k * 0.0213);
		},
		0,
		bootT
	);
	const failIndex = Math.floor(draw(h, 23) * tests.length);
	let failAt = 0;
	let failingSubtests: string[] = [];
	let t = bootT;
	const dt = (plannedMs * 0.8) / tests.length;
	tests.forEach((node, i) => {
		const t0 = t;
		const t1 = t + dt;
		const secs = (dt / 1000).toFixed(2);
		add(1, () => nested(`subtest: ${node.name}`), t0, t0);
		const first = node.child ? Math.floor(node.lines / 2) : node.lines;
		const base = 1000 * (i + 1);
		add(first, (k) => bodyLine(k, base), t0, node.child ? (t0 + t1) / 2 : t1);
		if (node.child) {
			const c = node.child;
			const tm = (t0 + t1) / 2;
			add(1, () => nested(`subtest: ${c.name}`), tm, tm);
			add(c.lines, (k) => bodyLine(k, base + 500), tm, tm + dt / 4);
			if (i === failIndex) {
				failAt = start - Math.floor(c.lines / 3);
				failingSubtests = [c.name, node.name];
			}
			add(
				1,
				() => `(finished: subtest: ${c.name}, in ${(dt / 4000).toFixed(2)} seconds)`,
				tm + dt / 4,
				tm + dt / 4
			);
			add(node.lines - first, (k) => bodyLine(k + first, base), tm + dt / 4, t1);
		} else if (i === failIndex) {
			failAt = start - Math.floor(first / 3);
			failingSubtests = [node.name];
		}
		add(1, () => `(finished: subtest: ${node.name}, in ${secs} seconds)`, t1, t1);
		if (i < tests.length - 1) {
			// The consoleLines runs on after a subtest finishes: two lines that join it,
			// stamped after its own consoleLines lines.
			if (draw(h, 50 + i) < 0.5) {
				const j = Math.floor(draw(h, 55 + i) * consoleLines.length);
				add(
					2,
					(k) =>
						serial(
							base + 900 + k,
							2 + (base + 998 + k) * 0.137,
							consoleLines[(j + k) % consoleLines.length]
						),
					t1,
					t1
				);
			}
			// A command of the script's own between subtests, outside them.
			if (draw(h, 60 + i) < 0.3)
				add(
					1,
					() =>
						`machine: ${nested(`must succeed: systemctl is-active ${pick(UNITS, draw(h, 65 + i))}`)}`,
					t1,
					t1
				);
		}
		t = t1;
	});
	const runningMax = start;
	add(
		6,
		(k) =>
			[
				`(finished: run the VM test script, in ${(plannedMs / 1000).toFixed(2)} seconds)`,
				`test script finished in ${(plannedMs / 1000 + 0.03).toFixed(2)}s`,
				...cleanup(pid)
			][k],
		plannedMs,
		plannedMs,
		true
	);
	return {
		input,
		profile: 'nixos-test',
		h,
		plannedMs,
		darwin: false,
		blocks,
		total: start,
		runningMax,
		failAt,
		phases: [],
		failingSubtests
	};
}

// ------------------------------------------------------------------ lines

function blockAt(blocks: readonly Block[], i: number): Block {
	let lo = 0;
	let hi = blocks.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (blocks[mid].start <= i) lo = mid;
		else hi = mid - 1;
	}
	return blocks[lo];
}

/** Line i of the log as a BUILT build leaves it, without its newline. */
export function baseLine(plan: LogPlan, i: number): string {
	const b = blockAt(plan.blocks, i);
	return b.gen(i - b.start);
}

/** How many lines a running build shows `simMs` after its start. */
export function linesAt(plan: LogPlan, simMs: number): number {
	let n = 0;
	for (const b of plan.blocks) {
		if (b.ending || b.t0 > simMs) break;
		if (b.t1 <= simMs) n = b.start + b.count;
		else n = b.start + Math.floor((b.count * (simMs - b.t0)) / Math.max(1, b.t1 - b.t0));
		if (b.t1 > simMs) break;
	}
	return Math.min(n, plan.runningMax);
}

/** The stdenv phase a running build is in, and when it began, in simulated ms from the start. */
export function phaseAt(plan: LogPlan, simMs: number): { phase: string; startedMs: number } | null {
	let cur: Phase | null = null;
	for (const p of plan.phases) {
		if (p.ending || p.t0 > simMs) break;
		cur = p;
	}
	return cur ? { phase: cur.name, startedMs: cur.t0 } : null;
}

export type LogEnding = Readonly<{
	outcome: DrvGone_Outcome;
	status: DrvGone_Status;
	failing?: boolean;
}>;

/** The log once the build ended: how many base lines it keeps, and what it appends. */
export type FinalLog = Readonly<{ keep: number; extra: readonly string[] }>;

export function ending(plan: LogPlan, end: LogEnding): FinalLog {
	const { outcome, status } = end;
	if (outcome === DrvGone_Outcome.BUILT) return { keep: plan.total, extra: [] };
	if (outcome !== DrvGone_Outcome.FAILED) return { keep: plan.runningMax, extra: [] };
	const h = plan.h;
	// A broken builder crashes whatever it builds.
	if (end.failing)
		return {
			keep: plan.failAt,
			extra: ['Illegal instruction (core dumped)', 'make: *** [Makefile:1234: all] Error 132']
		};
	switch (status) {
		case DrvGone_Status.TIMED_OUT:
		case DrvGone_Status.LOG_LIMIT_EXCEEDED:
			return { keep: plan.failAt, extra: [] };
		// The build ran to its end, and Nix rejected what it made.
		case DrvGone_Status.OUTPUT_REJECTED:
		case DrvGone_Status.NOT_DETERMINISTIC:
			return { keep: plan.total, extra: [] };
	}
	if (plan.profile === 'nixos-test') {
		const name = plan.failingSubtests[0];
		const why = pick(
			[
				'action timed out after 900.00 seconds (timeout=900.0)',
				'unit "nginx.service" reached state "failed"',
				'command `curl -f http://localhost/` failed (exit code 7)'
			],
			draw(h, 60)
		);
		const script = [
			['machine.wait_for_unit("multi-user.target")', 3],
			[`machine.succeed("systemctl is-active nginx")`, 12],
			['machine.wait_until_succeeds("curl -f http://localhost/")', 17]
		] as const;
		const frames = 2 + Math.floor(draw(h, 61) * 2);
		// The driver names the failed subtest, when the failure is in one.
		const extra =
			name === undefined ? [] : [driverError(`Test "${name}" failed with error: "${why}"`)];
		extra.push(driverError('Traceback (most recent call last):'));
		for (let f = 0; f < frames; f++) {
			const [line, n] = script[f % script.length];
			extra.push(driverError(`  File "<string>", line ${n + f * 7}, in <module>`));
			extra.push(driverError(`    ${line}`));
		}
		extra.push(driverError(''));
		extra.push(driverError(`RequestedAssertionFailed: ${why}`));
		// The failed blocks print no finish lines, and the driver cleans up after them.
		extra.push(...cleanup(qemuPid(h)));
		return { keep: plan.failAt, extra };
	}
	switch (status) {
		case DrvGone_Status.TRANSIENT_FAILURE:
			return {
				keep: plan.failAt,
				extra: [
					'curl: (6) Could not resolve host: example.org',
					`ERROR: fetchurl: cannot download ${plan.input.name}.tar.gz from any mirror`
				]
			};
		case DrvGone_Status.MISC_FAILURE:
			return {
				keep: plan.failAt,
				extra: [
					`ERROR: noBrokenSymlinks: the symlink /nix/store/${plan.input.drvPath.slice(0, 32)}-${plan.input.name}/lib/libfoo.so points to a missing target`
				]
			};
		default: {
			const lastLong = plan.phases.findLast((p) => p.long);
			if (lastLong?.name === 'checkPhase')
				return {
					keep: plan.failAt,
					extra: [
						`FAIL: tests/${plan.input.name.replace(/-\d.*$/, '')}-3`,
						'# FAIL:  1',
						'make[3]: *** [Makefile:2100: check-TESTS] Error 1'
					]
				};
			return {
				keep: plan.failAt,
				extra: [
					"src/foo.c:12:5: error: 'foo' undeclared (first use in this function)",
					'make: *** [Makefile:1234: all] Error 2'
				]
			};
		}
	}
}

/** A view of one log: its line count and lines. */
export type LogLines = Readonly<{ count: number; line: (i: number) => string }>;

/** The log of a finished build. */
export function finalLog(plan: LogPlan, end: LogEnding): LogLines {
	const f = ending(plan, end);
	return {
		count: f.keep + f.extra.length,
		line: (i) => (i < f.keep ? baseLine(plan, i) : f.extra[i - f.keep])
	};
}

/** The log of a running build, `simMs` after its start. */
export function runningLog(plan: LogPlan, simMs: number): LogLines {
	return { count: linesAt(plan, simMs), line: (i) => baseLine(plan, i) };
}

/** The last n lines of the finished log. Nix's message quotes them. */
export function tail(plan: LogPlan, end: LogEnding, n: number): string[] {
	const log = finalLog(plan, end);
	const out: string[] = [];
	for (let i = Math.max(0, log.count - n); i < log.count; i++) out.push(log.line(i));
	return out;
}

const encoder = new TextEncoder();

/** Lines [from, to) with their newlines, as bytes. */
export function bytes(log: LogLines, from: number, to: number): Uint8Array {
	const parts: string[] = [];
	for (let i = Math.max(0, from); i < Math.min(to, log.count); i++) parts.push(log.line(i), '\n');
	return encoder.encode(parts.join(''));
}
