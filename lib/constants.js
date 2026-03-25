const HOME = process.env.HOME || "";

const DEV_PORTS = new Set([
  3000,
  3001,
  3002,
  3003,
  4173,
  4200,
  4321,
  5000,
  5001,
  5173,
  5174,
  5175,
  5176,
  5500,
  5501,
  6006,
  8000,
  8001,
  8080,
  8081,
  8082,
  8088,
  8787,
  9000,
  9001,
  9229,
  24678,
]);

const DEV_KEYWORDS = [
  "vite",
  "next",
  "nuxt",
  "astro",
  "webpack",
  "webpack-dev-server",
  "react-scripts",
  "parcel",
  "storybook",
  "cypress",
  "playwright",
  "preview",
  "serve",
  "ts-node",
  "tsx",
  "nodemon",
  "bun",
  "deno",
  "uvicorn",
  "gunicorn",
  "flask",
  "django",
  "rails",
  "artisan",
  "spring",
  "gradle",
  "phoenix",
  "mix phx.server",
];

const RUNTIME_NAMES = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "uvicorn",
  "gunicorn",
  "ruby",
  "rails",
  "php",
  "java",
  "go",
  "air",
  "cargo",
  "dotnet",
]);

const MAIN_SHORTCUTS = [
  ["j/k", "move"],
  ["←/→", "reorder"],
  ["a", "all/main"],
  ["m", "move-port"],
  ["o", "open"],
  ["p", "pin"],
  ["x", "stop"],
  ["f", "force-stop"],
  ["s", "settings"],
  ["q", "quit"],
];

const SETTINGS_MENU_SHORTCUTS = [
  ["j/k", "move"],
  ["enter", "open/toggle"],
  ["s", "back"],
];

const SETTINGS_BROWSER_SHORTCUTS = [
  ["j/k", "move"],
  ["enter", "save"],
  ["s", "back"],
];

const KNOWN_BROWSER_NAMES = [
  "Arc",
  "Google Chrome",
  "Safari",
  "Firefox",
  "Firefox Developer Edition",
  "Brave Browser",
  "Microsoft Edge",
  "Vivaldi",
  "Opera",
  "Zen",
  "Orion",
  "DuckDuckGo",
];

const BROWSER_KEYWORDS = ["arc", "chrome", "safari", "firefox", "brave", "edge", "vivaldi", "opera", "zen", "orion", "duckduckgo"];

const KEY_POSITION_ALIASES = new Map([
  ["ㅁ", "a"],
  ["ㄴ", "s"],
  ["ㅂ", "q"],
  ["ㅃ", "q"],
  ["ㅐ", "o"],
  ["ㅒ", "o"],
  ["ㅔ", "p"],
  ["ㅖ", "p"],
  ["ㅡ", "m"],
  ["ㅌ", "x"],
  ["ㄹ", "f"],
  ["ㅓ", "j"],
  ["ㅏ", "k"],
]);

module.exports = {
  BROWSER_KEYWORDS,
  DEV_KEYWORDS,
  DEV_PORTS,
  HOME,
  KEY_POSITION_ALIASES,
  KNOWN_BROWSER_NAMES,
  MAIN_SHORTCUTS,
  RUNTIME_NAMES,
  SETTINGS_BROWSER_SHORTCUTS,
  SETTINGS_MENU_SHORTCUTS,
};
