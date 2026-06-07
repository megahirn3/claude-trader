import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { config } from "./config.js";
import { alpaca, AlpacaError } from "./alpaca.js";
import { runStore } from "./store.js";
import { runCycle } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const api = express.Router();

function handleAlpacaError(res: express.Response, e: unknown) {
  if (e instanceof AlpacaError) return res.status(e.status).json({ error: e.message });
  return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

// ── Status / config ───────────────────────────────────────────────────────────
api.get("/health", (_req, res) => res.json({ ok: true }));

api.get("/config", (_req, res) => {
  res.json({
    model: config.claude.model,
    trading: {
      mode: config.trading.mode,
      liveEnabled: config.trading.liveEnabled,
      maxOrderNotionalUsd: config.trading.maxOrderNotionalUsd,
    },
    ready: {
      // The agent can run if it has a way to reach Claude via the subscription.
      claude: config.claude.hasOAuthToken || config.claude.hasApiKey,
      usingSubscription: config.claude.hasOAuthToken && !config.claude.hasApiKey,
      usingApiKey: config.claude.hasApiKey,
      alpaca: config.alpaca.configured,
    },
  });
});

// ── Portfolio (read-only passthroughs to Alpaca) ──────────────────────────────
api.get("/account", async (_req, res) => {
  try {
    res.json(await alpaca.getAccount());
  } catch (e) {
    handleAlpacaError(res, e);
  }
});

api.get("/positions", async (_req, res) => {
  try {
    res.json(await alpaca.getPositions());
  } catch (e) {
    handleAlpacaError(res, e);
  }
});

api.get("/orders", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "all";
    res.json(await alpaca.getOrders({ status, limit: 50 }));
  } catch (e) {
    handleAlpacaError(res, e);
  }
});

api.get("/clock", async (_req, res) => {
  try {
    res.json(await alpaca.getClock());
  } catch (e) {
    handleAlpacaError(res, e);
  }
});

api.get("/portfolio-history", async (req, res) => {
  try {
    const period = typeof req.query.period === "string" ? req.query.period : "1M";
    res.json(await alpaca.getPortfolioHistory({ period }));
  } catch (e) {
    handleAlpacaError(res, e);
  }
});

api.delete("/orders/:id", async (req, res) => {
  try {
    await alpaca.cancelOrder(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    handleAlpacaError(res, e);
  }
});

// ── Agent runs ────────────────────────────────────────────────────────────────
const DEFAULT_PROMPT =
  "Run a full portfolio review cycle: assess my current holdings and cash, research the market and my positions, decide on any changes, and execute prudent trades within the safety limits. Then summarize what you did.";

api.post("/runs", (req, res) => {
  if (!config.claude.hasOAuthToken && !config.claude.hasApiKey) {
    return res.status(400).json({
      error:
        "No Claude credentials. Run `npm run setup-token` to mint a subscription token and set CLAUDE_CODE_OAUTH_TOKEN.",
    });
  }
  if (!config.alpaca.configured) {
    return res.status(400).json({ error: "Alpaca API keys are not configured." });
  }
  const prompt = typeof req.body?.prompt === "string" && req.body.prompt.trim() ? req.body.prompt.trim() : DEFAULT_PROMPT;
  const run = runStore.create(prompt, config.trading.mode);
  // Fire-and-forget; the client follows progress over SSE.
  void runCycle(run, prompt);
  res.status(201).json({ id: run.id });
});

api.get("/runs", (_req, res) => {
  // Return lightweight summaries (omit the full event arrays).
  res.json(
    runStore.list().map((r) => ({
      id: r.id,
      prompt: r.prompt,
      mode: r.mode,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      costUsd: r.costUsd,
      eventCount: r.events.length,
    })),
  );
});

api.get("/runs/:id", (req, res) => {
  const run = runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

// Server-Sent Events stream of a run's live events.
api.get("/runs/:id/stream", (req, res) => {
  const run = runStore.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`retry: 3000\n\n`);

  // Replay events already buffered, then subscribe for new ones.
  for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (run.status !== "running") {
    res.write(`event: done\ndata: {}\n\n`);
    return res.end();
  }

  const unsubscribe = runStore.subscribe(
    run.id,
    (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    () => {
      res.write(`event: done\ndata: {}\n\n`);
      res.end();
    },
  );

  const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

app.use("/api", api);

// ── Serve the built frontend in production ────────────────────────────────────
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.listen(config.port, () => {
  const mode = config.trading.liveEnabled ? "LIVE (real money)" : "paper";
  console.log(`\n  Claude Trader server → http://localhost:${config.port}`);
  console.log(`  Trading mode: ${mode}`);
  console.log(`  Model: ${config.claude.model}`);
  if (!config.claude.hasOAuthToken && !config.claude.hasApiKey) {
    console.log(`  ⚠ No Claude credentials — run \`npm run setup-token\` to use your Max subscription.`);
  } else if (config.claude.hasApiKey) {
    console.log(`  ⚠ ANTHROPIC_API_KEY is set — the SDK will bill the API instead of your subscription.`);
  } else {
    console.log(`  ✓ Using Claude subscription (CLAUDE_CODE_OAUTH_TOKEN).`);
  }
  if (!config.alpaca.configured) console.log(`  ⚠ Alpaca keys missing — set ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY.`);
  console.log("");
});
