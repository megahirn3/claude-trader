import { alpaca, type AlpacaAccount, type AlpacaPosition, type AlpacaOrder } from "../alpaca.js";

/**
 * Broker abstraction (execution + account). The bot places and manages orders
 * through this interface, so the underlying broker is swappable. Today it's
 * Alpaca; an IBKR adapter can implement the same interface later without
 * touching the agent, tools, or scheduler.
 */

export type { AlpacaAccount as Account, AlpacaPosition as Position, AlpacaOrder as Order };

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  time_in_force: "day" | "gtc";
  qty?: number;
  notional?: number;
  limit_price?: number;
  stop_price?: number;
}

export interface PortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: number[];
  base_value: number;
}

export interface Broker {
  name: string;
  getAccount(): Promise<AlpacaAccount>;
  getPositions(): Promise<AlpacaPosition[]>;
  getOrders(params?: { status?: string; limit?: number; symbols?: string[] }): Promise<AlpacaOrder[]>;
  placeOrder(order: OrderRequest): Promise<AlpacaOrder>;
  cancelOrder(id: string): Promise<void>;
  /** Emergency: cancel every open order. Returns one entry per order. */
  cancelAllOrders(): Promise<Array<{ id: string; status: number }>>;
  /** Emergency: liquidate every position at market. Returns one entry per position. */
  closeAllPositions(): Promise<Array<{ symbol: string; status: number }>>;
  getClock(): Promise<{ is_open: boolean; next_open: string; next_close: string; timestamp: string }>;
  getCalendar(start: string, end: string): Promise<Array<{ date: string; open: string; close: string }>>;
  getPortfolioHistory(params?: { period?: string; timeframe?: string }): Promise<PortfolioHistory>;
}

export const broker: Broker = {
  name: "alpaca",
  getAccount: () => alpaca.getAccount(),
  getPositions: () => alpaca.getPositions(),
  getOrders: (params) => alpaca.getOrders(params ?? {}),
  placeOrder: (order) => alpaca.placeOrder(order),
  cancelOrder: (id) => alpaca.cancelOrder(id),
  cancelAllOrders: () => alpaca.cancelAllOrders(),
  closeAllPositions: () => alpaca.closeAllPositions(),
  getClock: () => alpaca.getClock(),
  getCalendar: (start, end) => alpaca.getCalendar(start, end),
  getPortfolioHistory: (params) => alpaca.getPortfolioHistory(params ?? {}),
};
