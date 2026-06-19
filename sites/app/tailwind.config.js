/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        orange: {
          DEFAULT: "hsl(var(--orange))",
          dark: "hsl(var(--orange-dark))",
        },
      },
    },
  },
  plugins: [],
};
