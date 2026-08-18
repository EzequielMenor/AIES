export function upper(s) {
	return s.toUpperCase();
}

export function capitalize(s) {
	if (s.length === 0) return "";
	return s[0].toUpperCase() + s.slice(1);
}
