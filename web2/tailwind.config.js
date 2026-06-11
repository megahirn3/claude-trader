/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "var(--paper)",
        "paper-2": "var(--paper-2)",
        ink: "var(--ink)",
        "ink-soft": "var(--ink-soft)",
        "ink-faint": "var(--ink-faint)",
        line: "var(--line)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        up: "var(--up)",
        down: "var(--down)",
      },
      fontFamily: {
        display: ['"Fraunces"', "Georgia", "serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
        sans: ['"Hanken Grotesk"', "system-ui", "sans-serif"],
      },
      borderRadius: { glass: "18px", chip: "999px" },
      boxShadow: {
        glass:
          "inset 0 1px 0 rgba(255,255,255,0.75), 0 14px 34px -16px rgba(40,30,20,0.28), 0 3px 10px -6px rgba(40,30,20,0.14)",
        chip: "inset 0 1px 0 rgba(255,255,255,0.6), 0 2px 6px -3px rgba(40,30,20,0.18)",
        glow: "0 0 0 1px rgba(190,91,54,0.5), 0 10px 34px -10px rgba(190,91,54,0.4)",
      },
      keyframes: {
        pulseSoft: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
      },
      animation: { pulseSoft: "pulseSoft 1.6s ease-in-out infinite" },
    },
  },
  plugins: [],
};
