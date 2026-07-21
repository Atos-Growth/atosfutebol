/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {
    colors: { ink: '#0D1B2A', turf: { 50: '#e8f9f7', 100: '#c9f0ec', 300: '#7fdcd3', 500: '#1FB8AE', 600: '#189e95', 700: '#127b74', 900: '#0a3d39' }, lime: '#4DD8CF', cream: '#FAF7F0', orange: '#1B3A5C' },
    fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'], display: ['Arial Black', 'Inter', 'sans-serif'] },
    boxShadow: { card: '0 12px 35px rgba(7,24,18,.08)', glow: '0 0 0 4px rgba(77,216,207,.16)' },
  } },
  plugins: [],
}
