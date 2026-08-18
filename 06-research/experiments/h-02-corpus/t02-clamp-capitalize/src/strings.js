export function upper(s) {
	return s.toUpperCase();
}

export function capitalize(s) {
	return s.length === 0 ? '' : s.charAt(0).toUpperCase() + s.slice(1);
}
