export function countWords(s) {
	if (s === '') return 0;
	return s.trim().split(/\s+/).length;
}
