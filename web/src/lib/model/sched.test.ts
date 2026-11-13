import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { SubstituterTrafficSchema } from '#lib/gen/events_pb.ts';
import { reduceSubstituterUrl, substitutersFromProto } from './sched.ts';

describe('reduceSubstituterUrl', () => {
	it('drops user, password, query and fragment, and keeps scheme, host, port and path', () => {
		expect(
			reduceSubstituterUrl('https://user:secret@cache.example:8443/nix/store?priority=40#x')
		).toBe('https://cache.example:8443/nix/store');
		expect(reduceSubstituterUrl('s3://bucket?region=eu-west-1&profile=ci')).toBe('s3://bucket');
		expect(reduceSubstituterUrl('ssh://deploy@builder.example')).toBe('ssh://builder.example');
		expect(reduceSubstituterUrl('ssh-ng://a@b@host.example:2222/x')).toBe(
			'ssh-ng://host.example:2222/x'
		);
		expect(reduceSubstituterUrl('https://cache.example#frag')).toBe('https://cache.example');
		// An @ in the path is not userinfo.
		expect(reduceSubstituterUrl('https://cache.example/a@b?q=1')).toBe('https://cache.example/a@b');
		expect(reduceSubstituterUrl('file:///var/cache/nix?trusted=1')).toBe('file:///var/cache/nix');
	});

	it('keeps a store reference without "://" up to its query', () => {
		expect(reduceSubstituterUrl('daemon')).toBe('daemon');
		expect(reduceSubstituterUrl('local?root=/mnt')).toBe('local');
		expect(reduceSubstituterUrl('other')).toBe('other');
	});

	it('changes nothing the server already reduced', () => {
		for (const url of [
			'https://cache.nixos.org',
			'https://nix-community.cachix.org',
			'http://10.0.0.5:5000/nix',
			's3://bucket',
			'ssh://builder.example',
			'file:///var/cache/nix',
			'daemon',
			'auto',
			'other',
			''
		]) {
			expect(reduceSubstituterUrl(url)).toBe(url);
			expect(reduceSubstituterUrl(reduceSubstituterUrl(url))).toBe(url);
		}
	});
});

describe('substitutersFromProto', () => {
	const sub = (url: string, nar: number) =>
		create(SubstituterTrafficSchema, { url, narBytes: BigInt(nar), paths: 1n });

	it('keys counts by the reduced URL, and adds up two that reduce to one', () => {
		const m = substitutersFromProto([
			sub('https://a:b@cache.example?x=1', 10),
			sub('https://cache.example', 5),
			sub('https://cache.nixos.org', 7)
		]);
		expect([...m.keys()]).toEqual(['https://cache.example', 'https://cache.nixos.org']);
		expect(m.get('https://cache.example')).toEqual({ nar: 15, download: 0, paths: 2, failures: 0 });
	});
});
