/** @type {import('tailwindcss').Config} */
// Colors mirror themes/aies.json; keep both in sync.
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        bg: '#181b21',
        surface: '#20242e',
        raised: '#262b36',
        line: '#3a3f4b',
        accent: '#5aa9e6',
        amber: '#d9a441',
        ok: '#4caf72',
        muted: '#8b93a7',
        ink: '#e1e4ea',
      },
    },
  },
  plugins: [],
};
