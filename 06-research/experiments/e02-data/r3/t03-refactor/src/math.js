export function add(a, b) {
	return a + b;
}

export function clampReport(n, min, max) {
	const c = Math.min(Math.max(n, min), max);
	return `[${c}/${min}..${max}]`;
}
