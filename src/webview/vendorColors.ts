/**
 * Vendor colour mapping — the ONE accent in an otherwise theme-driven UI. Each
 * seat gets a stable colour chip keyed to its vendor (claude / glm / codex are
 * distinct, recognisable hues); unknown seats fall to a deterministic palette so
 * two seats never collide. Pure — unit-tested, no DOM.
 */
export interface VendorColor {
  /** Canonical vendor id ("claude" | "glm" | "codex" | "gemini" | "seat-N"). */
  vendor: string;
  /** The chip background colour. */
  color: string;
  /** A readable foreground colour to place on top of `color`. */
  fg: string;
}

const NAMED: Record<string, { color: string; fg: string }> = {
  // Anthropic Claude — warm clay/orange.
  claude: { color: "#d97757", fg: "#1b1205" },
  // Zhipu GLM — indigo/periwinkle.
  glm: { color: "#6d7bf4", fg: "#0b0d24" },
  // OpenAI Codex/GPT — teal green.
  codex: { color: "#10a37f", fg: "#04140f" },
  // Google Gemini — blue.
  gemini: { color: "#4285f4", fg: "#03102b" }
};

/** Deterministic fallback palette (colour-blind-safe-ish, distinct hues). */
const FALLBACK: Array<{ color: string; fg: string }> = [
  { color: "#c74b8f", fg: "#210411" }, // magenta
  { color: "#e0a100", fg: "#1c1500" }, // amber
  { color: "#3aa6b9", fg: "#04171b" }, // cyan
  { color: "#8e6bd6", fg: "#0f0620" }, // violet
  { color: "#5b9d4a", fg: "#0a1706" }, // green
  { color: "#d0623a", fg: "#1e0a03" } // rust
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Resolve a seat's vendor colour. `model` (when known) sharpens detection — a
 * seat named "a" running a `claude-*` model still chips as claude.
 */
export function vendorFor(seat: string, model?: string | null): VendorColor {
  const hay = `${seat} ${model ?? ""}`.toLowerCase();
  if (hay.includes("claude") || hay.includes("anthropic") || hay.includes("sonnet") || hay.includes("opus")) {
    return { vendor: "claude", ...NAMED.claude };
  }
  if (hay.includes("glm") || hay.includes("zhipu")) {
    return { vendor: "glm", ...NAMED.glm };
  }
  if (hay.includes("codex") || hay.includes("gpt") || hay.includes("openai") || hay.includes("o1") || hay.includes("o3")) {
    return { vendor: "codex", ...NAMED.codex };
  }
  if (hay.includes("gemini") || hay.includes("google")) {
    return { vendor: "gemini", ...NAMED.gemini };
  }
  const slot = FALLBACK[hash(seat) % FALLBACK.length];
  return { vendor: `seat-${seat}`, ...slot };
}
