export function countWords(s) {
	const t = s.trim();
	return t ? t.split(/\s+/).length : 0;
}
