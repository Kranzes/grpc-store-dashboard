// Svelte Flow node types. `data` holds only what layout decides; live
// numbers come from the FarmStore through the flow context. Lines are not
// Svelte Flow edges: the line canvas draws them from the layout.

import type { Node } from '@xyflow/svelte';
import type { LayoutNodeKind } from './layout.ts';

export type FlowNodeData = {
	/** Builder address, client group id, system or heading text. */
	ref: string;
	count?: number;
	/** Pools: builder address per cell, null for a free cell. */
	cells?: readonly (string | null)[];
	rows?: number;
	ports?: { publish: number; fetch: number };
};

export type FlowNode = Node<FlowNodeData, LayoutNodeKind>;
