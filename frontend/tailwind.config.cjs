/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx}"] ,
  theme: {
    extend: {
      colors: {
        ink: "#0f1115",
        fog: "#f6f7fb",
        glass: "#ffffffcc",
        neon: "#00b3ff",
        ember: "#ff6a3d"
      },
      boxShadow: {
        card: "0 18px 40px -30px rgba(15, 17, 21, 0.45)",
        soft: "0 12px 30px -20px rgba(15, 17, 21, 0.35)"
      },
      borderRadius: {
        xl: "1.25rem",
        "2xl": "1.75rem"
      }
    }
  },
  plugins: []
};
