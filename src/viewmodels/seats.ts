/**
 * Seats view-model — the roster: seat, tier, headroom, live/capped state. Pure.
 * Each seat gets a chip/icon reflecting its live state.
 */
import type { SeatVM } from "./model.js";
import type { ConclaveTreeNode } from "./tree.js";
import { placeholder } from "./tree.js";

/** Pick a ThemeIcon id + short chip label for a seat's live state. */
export function seatChip(seat: SeatVM): { icon: string; chip: string } {
  if (seat.capped) return { icon: "circle-slash", chip: "capped" };
  if (seat.paused) return { icon: "debug-pause", chip: "paused" };
  if (seat.status === "left") return { icon: "sign-out", chip: "left" };
  if (seat.status === "working") return { icon: "loading~spin", chip: "live" };
  return { icon: "circle-outline", chip: "idle" };
}

function money(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

export function seatsTree(seats: SeatVM[]): ConclaveTreeNode[] {
  if (seats.length === 0) {
    return [placeholder("seats.empty", "No seats — start or attach a run")];
  }
  return [...seats]
    .sort((a, b) => a.seat.localeCompare(b.seat))
    .map((s) => {
      const { icon, chip } = seatChip(s);
      const bits = [chip, `headroom ${s.headroom}`];
      if (s.tier) bits.unshift(s.tier);
      const detail: string[] = [];
      if (s.turns > 0) detail.push(`${s.turns} turns · ${money(s.cost)} (${s.costMode})`);
      if (s.currentItem) detail.push(`on: ${s.currentItem}`);
      if (s.resetsAt) detail.push(`resets ${new Date(s.resetsAt).toLocaleTimeString()}`);
      return {
        key: `seat.${s.seat}`,
        label: s.seat,
        description: bits.join(" · "),
        tooltip: [`${s.seat} — ${chip}`, ...detail].join("\n") || undefined,
        icon,
        contextValue: s.capped ? "conclaveSeatCapped" : "conclaveSeat",
        collapse: "none"
      };
    });
}
