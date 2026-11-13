// Wire helpers shared by unit tests and the e2e fake farm.

/** One gRPC-web frame: flag byte, big-endian length, payload. */
export function grpcWebFrame(flag: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	out[0] = flag;
	new DataView(out.buffer).setUint32(1, payload.length);
	out.set(payload, 5);
	return out;
}

/** A gRPC-web trailer frame: grpc-status, grpc-message when given, then `extra`. */
export function grpcWebTrailer(
	code = 0,
	message?: string,
	extra: Record<string, string> = {}
): Uint8Array {
	let text = `grpc-status:${code}\r\n`;
	if (message !== undefined) text += `grpc-message:${encodeURIComponent(message)}\r\n`;
	for (const [k, v] of Object.entries(extra)) text += `${k}:${v}\r\n`;
	return grpcWebFrame(0x80, new TextEncoder().encode(text));
}
