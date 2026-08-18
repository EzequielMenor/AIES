export function countWords(s) {
	return s.trim().split(/\s+/).filter(Boolean).length;
}
