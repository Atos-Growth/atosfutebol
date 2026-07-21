/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {
    colors: { ink: '#071812', turf: { 50: '#eefbf3', 100: '#d7f5e2', 300: '#7dd69e', 500: '#18a957', 600: '#0c8a43', 700: '#086d36', 900: '#08351f' }, lime: '#ccff33', cream: '#f7f7f1', orange: '#ff7a3d' },
    fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'], display: ['Arial Black', 'Inter', 'sans-serif'] },
    boxShadow: { card: '0 12px 35px rgba(7,24,18,.08)', glow: '0 0 0 4px rgba(204,255,51,.16)' },
  } },
  plugins: [],
}
