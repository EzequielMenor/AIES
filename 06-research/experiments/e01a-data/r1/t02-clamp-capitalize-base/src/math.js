export function add(a, b) {
	return a + b;
}

export function multiply(a, b) {
	return a * b;
}

export function clamp(n, min, max) {
	if (n < min) return min;
	if (n > max) return max;
	return n;
}
