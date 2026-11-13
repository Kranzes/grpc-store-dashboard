// What a source, live stream or mock, talks to.

import type { RecentBuildsBatch, WatchEvent } from '#lib/gen/events_pb.ts';
import type { GetBuildLogChunk } from '#lib/gen/nix_remote_pb.ts';
import type { ApplyResult } from '#lib/model/reducer.ts';
import type { ConnectionStatus } from '#lib/model/types.ts';
import type { DemoLogEvent, DemoLogPlan } from './mock.ts';

export interface SourceSink {
	/** A new stream starts: its first event must be a Reset. */
	beginStream(): void;
	/** Apply one stream message. On a failed result the source drops the stream and reconnects. */
	events(batch: readonly WatchEvent[]): ApplyResult;
	status(status: ConnectionStatus): void;
}

/** What the build list asks Events.RecentBuilds. Times are the scheduler's clock. */
export type RecentBuildsRequest = Readonly<{
	/** Only builds that finished before this. 0 means now. */
	beforeMs: number;
	limit: number;
	failedOnly: boolean;
	withError: boolean;
	/** Only these derivations, the newest record of each, error included. */
	drvPaths?: readonly string[];
}>;

export type RecentBuildsFn = (
	req: RecentBuildsRequest,
	signal: AbortSignal
) => AsyncIterable<RecentBuildsBatch>;

/**
 * Where build logs come from. demo: the demo makes them from its plan, and
 * tells the viewer as a running build moves on. none: the farm serves none.
 */
/** One GetBuildLog call. */
export type LogRequest = Readonly<{
	drvPath: string;
	/** The builder: x-nix-worker. */
	worker: string;
	/** One of its systems: x-nix-system. '' sends none. */
	system: string;
	assignId: number;
	offset: number;
	follow: boolean;
	/** 0: to the end. */
	limit: number;
	/** 0: from offset. */
	tail: number;
}>;

/** A call's messages, and who answered: x-nix-node from the headers, or the trailers and error. */
export type LogCall = AsyncIterable<GetBuildLogChunk> & {
	readonly node: Promise<string | null>;
	/** x-nix-rebuilding on a NOT_FOUND: the assignment that replaced the log. */
	readonly rebuilding: Promise<number | null>;
};

export type LogBackend =
	| { kind: 'grpc'; open(req: LogRequest, signal: AbortSignal): LogCall }
	| {
			kind: 'demo';
			plan(drvPath: string, assignId: number): DemoLogPlan;
			subscribe(drvPath: string, assignId: number, fn: (e: DemoLogEvent) => void): () => void;
	  }
	| { kind: 'none' };

export interface Source {
	stop(): void;
	/** Older finished builds, newest first. Absent: the source has none. */
	recentBuilds?: RecentBuildsFn;
	/** Build logs. Absent: none. */
	readonly logs?: LogBackend;
}
