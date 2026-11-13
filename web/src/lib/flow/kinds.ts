// The kinds of line on the map, in the dashboard's terms. The model keeps
// the protocol's names, such as FlowKind's want and cached, in its types and
// edge ids; the map and the panels convert where they read the model and use
// these.

import { edgeId, parseEdgeId, type FlowKind } from '#lib/model/types.ts';

/**
 * client group to scheduler, scheduler to builder, scheduler to cache,
 * builder to cache, cache to builder, upstream substituters to builder.
 */
export type LineKind = 'request' | 'assign' | 'hit' | 'publish' | 'fetch' | 'substitute';

/** In the order the legend lists them. */
export const LINE_KINDS: readonly LineKind[] = [
	'request',
	'assign',
	'hit',
	'publish',
	'fetch',
	'substitute'
];

/** Only assignment and request lines count builds that ended. */
export const countsFailures = (kind: LineKind) => kind === 'assign' || kind === 'request';

/** A line the map draws: its id and kind. LineGeom fits. */
export type DrawnLine = Readonly<{ id: string; kind: LineKind }>;

const FLOW: Record<LineKind, FlowKind> = {
	request: 'want',
	assign: 'assign',
	hit: 'cached',
	publish: 'publish',
	fetch: 'fetch',
	substitute: 'substitute'
};

const KIND: Record<FlowKind, LineKind> = {
	want: 'request',
	assign: 'assign',
	cached: 'hit',
	publish: 'publish',
	fetch: 'fetch',
	substitute: 'substitute'
};

/** The line kind of a model flow kind. */
export const lineKind = (flow: FlowKind): LineKind => KIND[flow];

/** A line's id in the model: "want:ci", "assign:10.0.0.13:50051". */
export const lineId = (kind: LineKind, endpoint: string): string => edgeId(FLOW[kind], endpoint);

/** Kind and endpoint of a line id. null when the kind is unknown. */
export function parseLineId(id: string): { kind: LineKind; endpoint: string } | null {
	const p = parseEdgeId(id);
	return p && { kind: KIND[p.flow], endpoint: p.endpoint };
}
