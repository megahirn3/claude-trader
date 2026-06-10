import { broker } from "./providers/broker.js";
import { setScheduleEnabled } from "./scheduler.js";
import { setHalted } from "./controlState.js";
import { notifyKill } from "./notify.js";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface KillResult {
  halted: true;
  cancelledOrders: number;
  closedPositions: number;
  errors: string[];
}

/**
 * The panic button. In one shot:
 *  1. HALT trading (agent can no longer place orders).
 *  2. Pause the daily autopilot.
 *  3. Cancel every open order.
 *  4. Liquidate every position at market.
 *  5. Alert Discord.
 *
 * Steps 3 and 4 run independently — if one fails, the other still attempts, and
 * the failure is reported rather than swallowed.
 */
export async function killSwitch(): Promise<KillResult> {
  setHalted(true);
  setScheduleEnabled(false);

  const errors: string[] = [];
  let cancelledOrders = 0;
  let closedPositions = 0;

  try {
    const cancelled = await broker.cancelAllOrders();
    cancelledOrders = cancelled.length;
  } catch (e) {
    errors.push(`cancel orders: ${msg(e)}`);
  }

  try {
    const closed = await broker.closeAllPositions();
    closedPositions = closed.length;
  } catch (e) {
    errors.push(`close positions: ${msg(e)}`);
  }

  notifyKill(cancelledOrders, closedPositions, errors);
  return { halted: true, cancelledOrders, closedPositions, errors };
}

/** Lift the halt so the agent can trade again. The autopilot stays off until you re-enable it. */
export function resume(): { halted: false } {
  setHalted(false);
  return { halted: false };
}
