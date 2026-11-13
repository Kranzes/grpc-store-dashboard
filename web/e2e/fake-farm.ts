// A fake farm for e2e tests of the live path: the farm's auth proxy, its
// Envoy and its scheduler on one localhost port, in front of the page's own
// server. Like Envoy it serves dashboard.json and the RPCs. Every other
// request goes to the page's server, so the page and its stream share one
// origin.
//
// In proxy mode, the default, the proxy has signed this browser in. A test
// can end that session (`lapsed`): the RPCs then get a 401 or a redirect to
// the proxy's sign-in, and the next page load signs in again. In anonymous
// mode the network watches without signing in.
//
// By default Watch streams a MockFarm, so the browser sees a busy farm
// through the real transport, reducer and store.

import {
	createServer,
	request,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type ServerResponse
} from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { constants as zlib, createZstdCompress, zstdCompressSync } from 'node:zlib';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
	DrvGone_Outcome,
	DrvGone_Status,
	FinishedBuildSchema,
	RecentBuildsBatchSchema,
	RecentBuildsRequestSchema,
	WatchEventsSchema,
	type WatchEvent
} from '../src/lib/gen/events_pb.ts';
import {
	BuildLogInfoSchema,
	BuildLogInfo_Source,
	GetBuildLogChunkSchema,
	GetBuildLogRequestSchema
} from '../src/lib/gen/nix_remote_pb.ts';
import { bytes, finalLog, planLog, runningLog, type LogLines } from '../src/lib/source/mock-log.ts';
import { MockFarm, mockOptions, type MockOptions } from '../src/lib/source/mock.ts';
import { grpcWebFrame as frame, grpcWebTrailer } from '../src/lib/test-helpers.ts';

/** What one Watch call does. */
export type WatchHandler = (call: WatchCall) => void | Promise<void>;

export type WatchCall = {
	/** Send one stream message. */
	send(events: WatchEvent[]): void;
	/** End the stream with a status in the trailers. */
	end(code?: number, message?: string): void;
	/** Answer with no messages and the status in the headers, as Envoy does for errors. */
	fail(code: number, message: string): void;
	/**
	 * Answer with an HTTP status and headers from in front of the scheduler,
	 * as Envoy's filters and limits and the auth proxy do. Plain text by default.
	 */
	reply(status: number, headers?: OutgoingHttpHeaders, body?: string): void;
	/** True once the browser went away. */
	readonly closed: boolean;
	/** Keep the stream open, sending nothing, until the browser goes away. */
	hold(): Promise<void>;
	/**
	 * Stream a MockFarm until the browser goes away: snapshot, then a batch
	 * every 100 ms. Streams of one MockFarm all see the same farm, as the
	 * browser's tabs would.
	 */
	streamMock(farm: MockFarm): Promise<void>;
};

export type FakeFarmOptions = {
	/** The page's server, such as the Vite dev server. Required. Only its host and port count. */
	site?: string;
	/** Where the page lives on the farm, with slashes at both ends. Default '/'. */
	base?: string;
	/**
	 * What <base>dashboard.json says: an object, null for 404, or a string
	 * for a body that is not valid JSON. Default { name: 'Test farm', auth: 'proxy' },
	 * with `signOutUrl` when one is given.
	 */
	dashboardJson?: Record<string, unknown> | string | null;
	/** The proxy's sign-out address in the default dashboard.json. */
	signOutUrl?: string;
	/** Options of the default MockFarm. */
	mock?: Partial<MockOptions>;
	/** How builders answer GetBuildLog. */
	logs?: FakeLogOptions;
};

/** Knobs for the fake builders' GetBuildLog. */
export type FakeLogOptions = {
	notFound?: boolean;
	unimplemented?: boolean;
	denied?: boolean;
	/** DATA_LOSS once this many decoded bytes went out. */
	dataLossAfter?: number;
	/** Cut the stream, with no trailers, once this many decoded bytes went out, on the first call. */
	dropAfter?: number;
	/** As PR 257 alone: no info, no x-nix-node, offset, limit and tail ignored. */
	oldServer?: boolean;
	/** The first n calls are answered NOT_FOUND by another node, as during EDS lag. */
	misroute?: number;
	/** No info.size, as a .bz2 before decoding. */
	sizeUnknown?: boolean;
	/** RESOURCE_EXHAUSTED for the first n calls. */
	busy?: number;
	/** UNAVAILABLE "… cannot be read now" for the first n calls, as from a log store that is down. */
	unreadable?: number;
	/** A fixed log instead of the generated one. */
	text?: string;
	/**
	 * The builder builds the derivation again as this assignment: a call for
	 * a finished build gets NOT_FOUND with x-nix-rebuilding, as while a retry
	 * rewrites the kept log.
	 */
	rebuilding?: number;
	/** The kept log was written by this later assignment, as after a retry on the same builder. */
	keptBy?: number;
	/**
	 * Derivations the farm does not build that its scheduler keeps as failed
	 * on its first builder, a minute ago: RecentBuilds names them, and their
	 * logs end as failed builds do.
	 */
	failed?: string[];
};

/** One GetBuildLog call, as the fake builders saw it. */
export type LogCallRecord = {
	drvPath: string;
	worker: string;
	assignId: number;
	offset: number;
	limit: number;
	tail: number;
	follow: boolean;
	/** Decoded bytes sent. */
	bytes: number;
	cancelled: boolean;
	ended: boolean;
};

/**
 * How the auth proxy answers the RPCs once its session ended: 401, or a
 * redirect to its sign-in.
 */
export type Lapse = 'unauthorized' | 'redirect';

export class FakeFarm {
	readonly #server = createServer((req, res) => void this.#handle(req, res));
	/** Upgraded connections, which the server no longer tracks. */
	readonly #tunnels = new Set<Socket>();
	readonly #options: FakeFarmOptions;
	readonly #site: URL;
	readonly #base: string;
	#port = 0;
	/** Every Watch call, in order, with the Authorization header the page sent, if any. */
	readonly watches: { authorization: string | undefined }[] = [];
	/**
	 * Set to end the auth proxy's session: the RPCs get a 401 or a redirect.
	 * The next page load signs in again and clears it.
	 */
	lapsed: Lapse | null = null;
	/** Every GetBuildLog call, in order. */
	readonly logCalls: LogCallRecord[] = [];
	/** Every RecentBuilds call's request, in order. */
	readonly historyCalls: { failedOnly: boolean; beforeMs: number; drvPaths: string[] }[] = [];
	logOptions: FakeLogOptions;
	/** Replace to script the stream. By default it streams `mock`. */
	watch: WatchHandler = (call) => call.streamMock(this.mock);
	readonly mock: MockFarm;

	constructor(options: FakeFarmOptions = {}) {
		if (!options.site) throw new Error('FakeFarm needs the page server in `site`');
		this.#options = options;
		this.#site = new URL(options.site);
		this.#base = options.base ?? '/';
		this.mock = new MockFarm(mockOptions({ builders: 6, ...options.mock }), Date.now());
		this.logOptions = options.logs ?? {};
		this.#server.on('upgrade', (req, socket, head) => {
			// Vite's client keeps a websocket to the dev server.
			const upstream = connect(Number(this.#site.port), this.#site.hostname, () => {
				const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
				for (let i = 0; i < req.rawHeaders.length; i += 2)
					lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
				upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
				upstream.write(head);
				socket.pipe(upstream).pipe(socket);
			});
			for (const s of [socket as Socket, upstream]) {
				this.#tunnels.add(s);
				s.on('close', () => this.#tunnels.delete(s));
			}
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
		});
	}

	async start(port = 0): Promise<this> {
		await new Promise<void>((resolve) => this.#server.listen(port, '127.0.0.1', resolve));
		this.#port = (this.#server.address() as AddressInfo).port;
		return this;
	}

	async stop(): Promise<void> {
		for (const s of this.#tunnels) s.destroy();
		this.#server.closeAllConnections();
		await new Promise((resolve) => this.#server.close(resolve));
	}

	/** The page on the farm, as users open it. */
	get url(): string {
		return `${this.origin}${this.#base}`;
	}

	get origin(): string {
		return `http://localhost:${this.#port}`;
	}

	async #handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? '/', this.origin);
		const base = this.#base;
		// A page load goes through the proxy's sign-in, which signs everyone in at once.
		if (req.headers['sec-fetch-mode'] === 'navigate') this.lapsed = null;
		switch (url.pathname) {
			case `${base}dashboard.json`: {
				const d =
					this.#options.dashboardJson === undefined
						? {
								name: 'Test farm',
								auth: 'proxy',
								...(this.#options.signOutUrl && { signOutUrl: this.#options.signOutUrl })
							}
						: this.#options.dashboardJson;
				if (d === null) {
					res.writeHead(404, { 'content-type': 'text/plain' });
					res.end('not found');
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
				res.end(typeof d === 'string' ? d : JSON.stringify(d));
				return;
			}
			case `${base}nix.remote.Events/Watch`:
				if (req.method === 'POST') return this.#watch(req, res);
				break;
			case `${base}nix.remote.Events/RecentBuilds`:
				if (req.method === 'POST') return this.#recentBuilds(req, res);
				break;
			case `${base}nix.remote.NixRemote/GetBuildLog`:
				if (req.method === 'POST') return this.#getBuildLog(req, res);
				break;
		}
		this.#proxy(req, res);
	}

	#proxy(req: IncomingMessage, res: ServerResponse) {
		const upstream = request(
			{
				host: this.#site.hostname,
				port: this.#site.port,
				method: req.method,
				path: req.url,
				headers: req.headers
			},
			(r) => {
				res.writeHead(r.statusCode ?? 502, r.headers);
				r.pipe(res);
			}
		);
		upstream.on('error', () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	}

	/**
	 * The auth proxy in front of an RPC: once its session ended, a 401 or a
	 * redirect to its sign-in. Returns the response headers, or null once it
	 * answered.
	 */
	#admit(res: ServerResponse): OutgoingHttpHeaders | null {
		if (this.lapsed === 'unauthorized') {
			res.writeHead(401, { 'content-type': 'text/plain' });
			res.end('Unauthorized');
			return null;
		}
		if (this.lapsed === 'redirect') {
			res.writeHead(302, { location: `${this.#base}sign-in` });
			res.end();
			return null;
		}
		return { 'content-type': 'application/grpc-web+proto' };
	}

	/** The request's one gRPC-web frame. */
	async #body(req: IncomingMessage): Promise<Uint8Array> {
		const parts: Buffer[] = [];
		for await (const c of req) parts.push(c as Buffer);
		const all = Buffer.concat(parts);
		if (all.length < 5) return new Uint8Array(0);
		return new Uint8Array(all.subarray(5, 5 + all.readUInt32BE(1)));
	}

	async #recentBuilds(req: IncomingMessage, res: ServerResponse) {
		const body = await this.#body(req);
		const headers = this.#admit(res);
		if (!headers) return;
		const r = fromBinary(RecentBuildsRequestSchema, body);
		this.historyCalls.push({
			failedOnly: r.failedOnly,
			beforeMs: Number(r.beforeMs),
			drvPaths: [...r.drvPaths]
		});
		res.writeHead(200, headers);
		const failed = (this.logOptions.failed ?? []).filter((p) => r.drvPaths.includes(p));
		if (failed.length) {
			const worker = Object.keys(this.mock.inspect().machines)[0] ?? '';
			const now = Date.now();
			const builds = failed.map((p) =>
				create(FinishedBuildSchema, {
					drvPath: p,
					system: 'x86_64-linux',
					workerAddr: worker,
					outcome: DrvGone_Outcome.FAILED,
					status: DrvGone_Status.PERMANENT_FAILURE,
					error: 'builder for this derivation failed with exit code 2',
					assignId: 0n,
					assignedMs: BigInt(now - 600_000),
					buildStartedMs: BigInt(now - 600_000),
					finishedMs: BigInt(now - 60_000)
				})
			);
			res.write(
				frame(0, toBinary(RecentBuildsBatchSchema, create(RecentBuildsBatchSchema, { builds })))
			);
			res.end(grpcWebTrailer());
			return;
		}
		const batches = this.mock.recentBuilds({
			beforeMs: Number(r.beforeMs),
			limit: r.limit,
			failedOnly: r.failedOnly,
			withError: r.withError,
			drvPaths: r.drvPaths
		});
		for (const b of batches) res.write(frame(0, toBinary(RecentBuildsBatchSchema, b)));
		res.end(grpcWebTrailer());
	}

	/** The fake builder's log of a build: kept, or as it runs. */
	#logOf(drvPath: string, assignId: number): { log: LogLines; running: boolean } {
		const text = this.logOptions.text;
		if (text !== undefined) {
			const lines = text.split('\n');
			if (lines.at(-1) === '') lines.pop();
			return { log: { count: lines.length, line: (i) => lines[i] }, running: false };
		}
		const p = this.mock.logPlan(drvPath, assignId);
		const plan = planLog({
			seed: p.seed,
			drvPath,
			name: p.name,
			system: p.system,
			assignId: p.assignId,
			plannedMs: p.plannedMs || undefined,
			logsize: p.logsize
		});
		if (this.logOptions.failed?.includes(drvPath))
			return {
				log: finalLog(plan, {
					outcome: DrvGone_Outcome.FAILED,
					status: DrvGone_Status.PERMANENT_FAILURE
				}),
				running: false
			};
		if (p.ending) return { log: finalLog(plan, p.ending), running: false };
		const sim = p.startedMs === null ? 0 : (this.mock.now - p.startedMs) * p.speed;
		const run = runningLog(plan, sim);
		return { log: { count: Math.min(run.count, plan.failAt), line: run.line }, running: true };
	}

	/**
	 * The last finished log made, kept for the calls that follow: head, tail
	 * and resume. A promise, so calls that arrive at once share one making.
	 */
	#kept: { key: string; bytes: Promise<Uint8Array> } | null = null;
	/**
	 * Time spent making and compressing finished logs in ms, to tell how much of
	 * a load is the fake farm's own.
	 */
	logMakeMs = 0;

	/** The bytes a fake builder serves for a build now, as a test expects them. */
	logBytes(drvPath: string, assignId = 0): Promise<Uint8Array> {
		return FakeFarm.#bytes(this.#logOf(drvPath, assignId).log);
	}

	/** The bytes of a log, with its newlines, made in pieces so the farm's streams go on meanwhile. */
	static async #bytes(log: LogLines): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		for (let i = 0; i < log.count; i += 20_000) {
			parts.push(bytes(log, i, i + 20_000));
			await new Promise((r) => setImmediate(r));
		}
		return new Uint8Array(Buffer.concat(parts));
	}

	/**
	 * A builder's GetBuildLog: the log from offset, limit or
	 * tail, as one zstd stream in messages of up to 256 KiB with info first,
	 * x-nix-node in headers and trailers; a running build follows until it ends.
	 */
	async #getBuildLog(req: IncomingMessage, res: ServerResponse) {
		const body = await this.#body(req);
		const admitted = this.#admit(res);
		if (!admitted) return;
		const r = fromBinary(GetBuildLogRequestSchema, body);
		const o = this.logOptions;
		const worker = String(req.headers['x-nix-worker'] ?? '');
		const rec: LogCallRecord = {
			drvPath: r.drvPath,
			worker,
			assignId: Number(r.assignId),
			offset: Number(r.offset),
			limit: Number(r.limit),
			tail: Number(r.tail),
			follow: r.follow,
			bytes: 0,
			cancelled: false,
			ended: false
		};
		this.logCalls.push(rec);
		const n = this.logCalls.length;
		let closed = false;
		res.on('close', () => {
			if (!rec.ended) rec.cancelled = true;
			closed = true;
		});
		const machines = this.mock.inspect().machines;
		const known = worker in machines;
		// The node that answers: the named builder, or another one.
		const other = Object.keys(machines).find((a) => a !== worker) ?? 'other:50051';
		const misrouted = (o.misroute ?? 0) >= n;
		const node = !known || misrouted ? other : worker;
		const headers: OutgoingHttpHeaders = { ...admitted };
		if (!o.oldServer) headers['x-nix-node'] = node;
		const fail = (code: number, message: string) => {
			rec.ended = true;
			trailersOnly(res, headers, code, message);
		};
		if (o.unimplemented) return fail(12, 'build logs need a LocalFSStore');
		if (o.denied) return fail(7, 'watch role needed');
		if ((o.busy ?? 0) >= n) return fail(8, `too many build log readers on ${node}`);
		if ((o.unreadable ?? 0) >= n) return fail(14, "the log store's copy cannot be read now");
		if (o.notFound || !known || misrouted)
			return fail(5, `no build log of ${r.drvPath} on ${node}`);
		if (o.rebuilding && !r.follow) {
			headers['x-nix-rebuilding'] = String(o.rebuilding);
			return fail(5, `${r.drvPath} is being built again on ${node}`);
		}

		const first = this.#logOf(r.drvPath, Number(r.assignId));
		const key = `${r.drvPath}#${Number(r.assignId)}`;
		let full: Uint8Array;
		if (!first.running && this.#kept?.key === key) full = await this.#kept.bytes;
		else if (first.running) full = await FakeFarm.#bytes(first.log);
		else {
			const t0 = performance.now();
			const bytes = FakeFarm.#bytes(first.log);
			this.#kept = { key, bytes };
			full = await bytes;
			this.logMakeMs += performance.now() - t0;
		}
		if (closed) return;
		const running = first.running;
		const follow = r.follow && running && !o.oldServer;
		let start = o.oldServer ? 0 : Number(r.offset);
		const size = full.length;
		if (!follow && start > size) return fail(11, 'offset past the end');
		if (!o.oldServer && Number(r.tail) > 0) {
			const s = Math.max(start, size - Number(r.tail));
			if (s > start) {
				let k = s;
				while (k < size && full[k - 1] !== 10) k++;
				start = k;
			}
		}
		let firstLine = 0;
		for (let k = 0; k < start; k++) if (full[k] === 10) firstLine++;
		const end =
			o.oldServer || Number(r.limit) === 0 ? size : Math.min(size, start + Number(r.limit));
		res.writeHead(200, headers);
		res.flushHeaders();
		const info = o.oldServer
			? undefined
			: create(BuildLogInfoSchema, {
					source: running ? BuildLogInfo_Source.LIVE : BuildLogInfo_Source.KEPT,
					size: BigInt(o.sizeUnknown && !running ? 0 : size),
					offset: BigInt(start),
					firstLine: BigInt(firstLine),
					assignId: BigInt(o.keptBy && !running ? o.keptBy : Number(r.assignId)),
					modifiedMs: BigInt(Date.now()),
					startedMs: running ? 1n : 0n
				});
		const send = (data: Uint8Array, withInfo: boolean, ended = false) => {
			if (closed) return;
			const chunk = create(GetBuildLogChunkSchema, {
				data,
				info: withInfo ? info : undefined,
				ended
			});
			res.write(frame(0, toBinary(GetBuildLogChunkSchema, chunk)));
		};
		const trailer = (code = 0, message = '') => {
			if (closed) return;
			rec.ended = true;
			res.end(grpcWebTrailer(code, message, o.oldServer ? {} : { 'x-nix-node': node }));
		};
		if (!follow) {
			let piece = full.subarray(start, end);
			// With PR 257 alone, a running build's .bz2 is not complete.
			if (o.oldServer && running) {
				const z = new Uint8Array(zstdCompressSync(piece.subarray(0, Math.min(piece.length, 4096))));
				send(z, false);
				return trailer(15, 'bz2: unexpected end of stream');
			}
			// Cut short: a drop with no trailers on the first call, or DATA_LOSS.
			const cutAt = o.dropAfter !== undefined && n === 1 ? o.dropAfter : o.dataLossAfter;
			const cut = cutAt !== undefined && piece.length > cutAt;
			if (cut) piece = piece.subarray(0, cutAt);
			const z0 = performance.now();
			const z = new Uint8Array(zstdCompressSync(piece));
			this.logMakeMs += performance.now() - z0;
			const MSG = 256 * 1024;
			for (let k = 0; k < z.length || k === 0; k += MSG) {
				send(z.subarray(k, k + MSG), k === 0);
				if (k + MSG >= z.length) break;
			}
			rec.bytes = piece.length;
			if (cut && o.dropAfter !== undefined && n === 1)
				// The connection breaks after what went out, as Envoy reports an upstream reset.
				return trailer(14, 'upstream connect error or disconnect/reset before headers');
			if (cut) return trailer(15, 'bz2: data error');
			return trailer();
		}
		// Follow: what the spill holds, then more as the build writes, flushed per message.
		const z = createZstdCompress();
		z.on('data', (d: Buffer) => send(new Uint8Array(d), false));
		const flush = () => new Promise<void>((resolve) => z.flush(zlib.ZSTD_e_flush, () => resolve()));
		let sent = start;
		send(new Uint8Array(0), true);
		let endedBuild = false;
		const off = this.mock.onEnded((path) => {
			if (path === r.drvPath) endedBuild = true;
		});
		try {
			while (!closed) {
				const now = this.#logOf(r.drvPath, Number(r.assignId));
				full = await FakeFarm.#bytes(now.log);
				if (full.length > sent) {
					z.write(full.subarray(sent));
					rec.bytes += full.length - sent;
					sent = full.length;
					await flush();
				}
				if (endedBuild || !now.running) break;
				await sleep(250);
			}
		} finally {
			off();
		}
		if (closed) return;
		await new Promise<void>((resolve) => z.end(() => resolve()));
		await sleep(20);
		send(new Uint8Array(0), false, true);
		trailer();
	}

	async #watch(req: IncomingMessage, res: ServerResponse) {
		const headers = this.#admit(res);
		if (!headers) return;
		this.watches.push({ authorization: req.headers.authorization });
		let closed = false;
		let started = false;
		res.on('close', () => (closed = true));
		const head = () => {
			if (started) return;
			started = true;
			res.writeHead(200, headers);
			res.flushHeaders();
		};
		const call: WatchCall = {
			get closed() {
				return closed;
			},
			async hold() {
				while (!closed) await sleep(100);
			},
			send(events) {
				if (closed) return;
				head();
				res.write(
					frame(0, toBinary(WatchEventsSchema, create(WatchEventsSchema, { msgs: events })))
				);
			},
			end(code = 0, message = '') {
				if (closed) return;
				head();
				res.end(grpcWebTrailer(code, message));
			},
			fail(code, message) {
				if (closed) return;
				started = true;
				trailersOnly(res, headers, code, message);
			},
			reply(status, extra = {}, body = '') {
				if (closed) return;
				started = true;
				res.writeHead(status, { 'content-type': 'text/plain', ...extra });
				res.end(body);
			},
			async streamMock(farm) {
				let feed = feeds.get(farm);
				if (!feed) feeds.set(farm, (feed = new MockFeed(farm)));
				const leave = feed.join((batch) => call.send(batch));
				try {
					while (!closed) await sleep(100);
				} finally {
					leave();
				}
			}
		};
		// Wait for the request body, an empty WatchRequest, before answering.
		await this.#body(req);
		await this.watch(call);
	}
}

/**
 * One MockFarm streamed to any number of Watch calls, as the scheduler
 * streams its one state to every watcher: a new stream gets a fresh
 * snapshot, and every stream gets every event after it.
 */
class MockFeed {
	readonly #streams = new Set<(batch: WatchEvent[]) => void>();
	#timer: ReturnType<typeof setInterval> | null = null;
	readonly farm: MockFarm;

	constructor(farm: MockFarm) {
		this.farm = farm;
	}

	/** Start a stream with a snapshot. Returns what ends it. */
	join(send: (batch: WatchEvent[]) => void): () => void {
		// The open streams get everything up to the new one's snapshot.
		this.#flush();
		send(this.farm.snapshot());
		this.#streams.add(send);
		this.#timer ??= setInterval(() => this.#flush(), 100);
		return () => {
			this.#streams.delete(send);
			if (this.#streams.size > 0 || !this.#timer) return;
			clearInterval(this.#timer);
			this.#timer = null;
		};
	}

	#flush() {
		const batch = this.farm.advance(Date.now());
		if (batch.length > 0) for (const send of this.#streams) send(batch);
	}
}

const feeds = new WeakMap<MockFarm, MockFeed>();

/** A gRPC-web error with no body: the status in the response headers. */
function trailersOnly(
	res: ServerResponse,
	headers: OutgoingHttpHeaders,
	code: number,
	message: string
) {
	res.writeHead(200, {
		...headers,
		'grpc-status': String(code),
		'grpc-message': encodeURIComponent(message)
	});
	res.end();
}

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
