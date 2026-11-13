<script lang="ts">
	// Short text on screen, words for screen readers: "3m 20s" is read as
	// "3 minutes 20 seconds".
	type Props = { text: string; words: string };
	let { text, words }: Props = $props();
</script>

<span aria-hidden="true">{text}</span><span class="visually-hidden">{words}</span>
