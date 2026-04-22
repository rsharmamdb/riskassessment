import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50:  "#F8FAFC",
          100: "#F1F5F9",
          200: "#CBD5E1",
          300: "#94A3B8",
          400: "#64748B",
          500: "#475569",
          600: "#334155",
          700: "#1E2D3D",
          800: "#111827",
          900: "#0F1927",
          950: "#0A0E1A",
        },
        accent: {
          300: "#60A5FA",
          400: "#3B82F6",
          500: "#3B82F6",
          600: "#2563EB",
          700: "#1D4ED8",
          900: "#0D1424",
        },
        danger:  "#EF4444",
        warn:    "#F59E0B",
        success: "#10B981",
      },
      fontFamily: {
        sans: [
          "EuclidCircularA",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        serif: [
          "MongoDBValueSerif",
          "Georgia",
          "serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      borderRadius: {
        DEFAULT: "8px",
        sm:    "6px",
        md:    "8px",
        lg:    "8px",
        xl:    "8px",
        "2xl": "8px",
        "3xl": "8px",
        full:  "9999px",
      },
      boxShadow: {
        card: "none",
        menu: "none",
      },
    },
  },
  plugins: [],
};

export default config;
