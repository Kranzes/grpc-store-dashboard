// What the detail panel calls its views: headings, back labels and kickers.

import {
	kindName,
	lineHeading,
	lineTitle,
	type LineNames,
	type LineTitle
} from '#lib/flow/lines.ts';
import { OTHER_CLIENTS, drvName, parseNodeId, type NodeRef } from '#lib/model/types.ts';
import type { PanelView } from '../stack.ts';

/** What the panel needs to name builders and client groups. */
export type PanelNames = LineNames & { groupLabel: (group: string) => string | undefined };

/** A node's heading: "Scheduler", "10.0.0.13:50051", "x86_64-linux", a group's label. */
export function nodeTitle(id: string, names: PanelNames): string {
	const t = parseNodeId(id);
	if (!t) return '';
	switch (t.kind) {
		case 'scheduler':
			return 'Scheduler';
		case 'cache':
			return 'Binary cache';
		case 'upstream':
			return 'Substituters';
		case 'builder':
			return t.addr;
		case 'pool':
			return t.system;
		case 'clients':
			return t.group === OTHER_CLIENTS ? 'Other clients' : (names.groupLabel(t.group) ?? t.group);
	}
}

/** Builder addresses, systems and identities use the mono face. */
export function nodeMono(id: string): boolean {
	const t = parseNodeId(id);
	return (
		t?.kind === 'builder' ||
		t?.kind === 'pool' ||
		(t?.kind === 'clients' && t.group !== OTHER_CLIENTS)
	);
}

const KICKER: Record<NodeRef['kind'], string> = {
	builder: 'Builder',
	pool: 'Builder pool',
	clients: 'Client group',
	cache: 'Hits and transfers',
	upstream: 'Upstream',
	scheduler: 'Queue and slots'
};

/**
 * The small caps line above the heading. A line view's kicker is its kind,
 * such as "Fetches", drawn after a dot in the line's color, and it stays
 * when Back shows. Back replaces the others.
 */
export function viewKicker(v: PanelView): string {
	switch (v.kind) {
		case 'node': {
			const t = parseNodeId(v.nodeId);
			return t ? KICKER[t.kind] : '';
		}
		case 'lines':
			return kindName(v.flow);
		case 'derivation':
			return 'Derivation';
	}
}

const plain = (text: string, mono = false): LineTitle => ({ text, parts: [{ text, mono }] });

/** A view's heading, in parts so names can use the mono face. A line names only its varying end. */
export function viewTitle(v: PanelView, names: PanelNames): LineTitle {
	switch (v.kind) {
		case 'node':
			return plain(nodeTitle(v.nodeId, names), nodeMono(v.nodeId));
		case 'lines':
			return lineHeading(v.flow, v.edgeIds, names);
		case 'derivation':
			// DrvView.name, without a store query per frame.
			return plain(drvName(v.drvPath));
	}
}

/**
 * A view's name in one string, for screen readers and the back button. A
 * line says its kind, as in "Fetches to the x86_64-linux pool", and a pool says so.
 */
export function viewName(v: PanelView, names: PanelNames): string {
	if (v.kind === 'lines') return lineTitle(v.flow, v.edgeIds, names).text;
	if (v.kind === 'node' && parseNodeId(v.nodeId)?.kind === 'pool')
		return `${nodeTitle(v.nodeId, names)} pool`;
	return viewTitle(v, names).text;
}

/** The back button's label: the name of the view below. */
export const backLabel = viewName;
