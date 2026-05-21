import * as http from "node:http";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import { localStatsRecorder } from "./recorder";

const LOCAL_STATS_TOKEN_KEY = "opencodegosniffer.localStatsToken";

export class LocalStatsServer {
    private server?: http.Server;
    private port?: number;
    private host?: string;
    private token?: string;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async start(): Promise<void> {
        const config = vscode.workspace.getConfiguration();
        const enabled = config.get<boolean>("opencodegosniffer.localStatsEnabled", true);
        const capturePayloads = config.get<boolean>("opencodegosniffer.localStatsCapturePayloads", false);
        const maxEntries = config.get<number>("opencodegosniffer.localStatsMaxEntries", 200);
        localStatsRecorder.configure({ enabled, capturePayloads, maxEntries });

        if (!enabled) {
            await this.stop();
            return;
        }

        const desiredPort = config.get<number>("opencodegosniffer.localStatsPort", 43177);
        const desiredHost = normalizeBindHost(config.get<string>("opencodegosniffer.localStatsHost", "127.0.0.1"));
        const maxPortAttempts = config.get<number>("opencodegosniffer.localStatsPortAutoIncrementMax", 20);

        this.token = await this.getOrCreateToken();

        // If a server is already running on the same host in the allowed dynamic range,
        // keep it. This makes Copy URL actions stable and avoids restarting unnecessarily.
        if (
            this.server &&
            this.host === desiredHost &&
            this.port !== undefined &&
            this.port >= desiredPort &&
            this.port <= desiredPort + Math.max(0, maxPortAttempts)
        ) {
            return;
        }

        await this.stop();

        const attempts = Math.max(0, Math.min(maxPortAttempts, 500));
        let lastError: unknown;

        for (let offset = 0; offset <= attempts; offset++) {
            const candidatePort = desiredPort + offset;

            try {
                const server = await this.listen(candidatePort, desiredHost);
                this.server = server;
                this.port = candidatePort;
                this.host = desiredHost;
                return;
            } catch (error) {
                lastError = error;

                if (!isPortUnavailableError(error)) {
                    throw error;
                }
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(`Could not start OpenCode GO Sniffer server from port ${desiredPort} to ${desiredPort + attempts}`);
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        const server = this.server;
        this.server = undefined;
        this.port = undefined;
        this.host = undefined;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    getBaseUrl(): string | undefined {
        if (!this.port) return undefined;
        const displayHost = !this.host || this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
        return `http://${hostForUrl(displayHost)}:${this.port}`;
    }

    getDashboardUrl(): string | undefined {
        const base = this.getBaseUrl();
        if (!base || !this.token) return undefined;
        return this.buildDashboardUrl(base);
    }

    getIntranetDashboardUrl(): string | undefined {
        if (!this.port || !this.token) return undefined;
        const intranetHost = this.getIntranetHost();
        if (!intranetHost) return undefined;
        return this.buildDashboardUrl(`http://${hostForUrl(intranetHost)}:${this.port}`);
    }

    private buildDashboardUrl(base: string): string {
        return `${base}/?token=${encodeURIComponent(this.token ?? "")}`;
    }

    private getIntranetHost(): string | undefined {
        if (this.host && this.host !== "0.0.0.0" && this.host !== "::" && this.host !== "127.0.0.1" && this.host !== "localhost" && this.host !== "::1") {
            return this.host;
        }
        return getFirstLanIpv4Address();
    }

    private async getOrCreateToken(): Promise<string> {
        const existing = await this.context.secrets.get(LOCAL_STATS_TOKEN_KEY);
        if (existing) return existing;
        const token = crypto.randomBytes(24).toString("hex");
        await this.context.secrets.store(LOCAL_STATS_TOKEN_KEY, token);
        return token;
    }

    private async listen(port: number, host: string): Promise<http.Server> {
        const server = http.createServer((req, res) => this.handle(req, res));

        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (err: Error) => {
                    server.off("listening", onListening);
                    reject(err);
                };

                const onListening = () => {
                    server.off("error", onError);
                    resolve();
                };

                server.once("error", onError);
                server.once("listening", onListening);
                server.listen(port, host);
            });

            return server;
        } catch (error) {
            server.close();
            throw error;
        }
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port ?? 0}`);
            if (req.method === "GET" && url.pathname === "/favicon.ico") {
                res.statusCode = 204;
                res.end();
                return;
            }

            if (!this.isRemoteAddressAllowed(req)) {
                this.json(res, 403, { error: "Forbidden", remoteAddress: normalizeRemoteAddress(req.socket.remoteAddress) ?? "unknown" });
                return;
            }

            if (!this.isAuthorized(req)) {
                this.json(res, 401, { error: "Unauthorized" });
                return;
            }

            if (req.method === "GET" && url.pathname === "/") {
                this.html(res, dashboardHtml(this.token ?? ""));
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/summary") {
                this.json(res, 200, localStatsRecorder.summary());
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/requests") {
                const limit = Number(url.searchParams.get("limit") ?? "50");
                this.json(res, 200, localStatsRecorder.list(limit));
                return;
            }
            if (req.method === "GET" && url.pathname.startsWith("/api/requests/")) {
                const id = decodeURIComponent(url.pathname.slice("/api/requests/".length));
                const item = localStatsRecorder.get(id);
                if (!item) {
                    this.json(res, 404, { error: "Not found" });
                    return;
                }
                this.json(res, 200, item);
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/opencode/usage") {
                void this.handleOpencodeUsage(req, res);
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/clear") {
                localStatsRecorder.clear();
                this.json(res, 200, { ok: true });
                return;
            }
            this.json(res, 404, { error: "Not found" });
        } catch (err) {
            this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    private isRemoteAddressAllowed(req: http.IncomingMessage): boolean {
        const config = vscode.workspace.getConfiguration();
        const rulesText = config.get<string>("opencodegosniffer.localStatsAllowedClients", "127.0.0.1,::1");
        const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
        if (!remoteAddress) return false;
        return isAddressAllowed(remoteAddress, rulesText);
    }

    private isAuthorized(req: http.IncomingMessage): boolean {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port ?? 0}`);
        const tokenFromQuery = url.searchParams.get("token");
        const auth = req.headers.authorization ?? "";
        const tokenFromHeader = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
        return !!this.token && (tokenFromQuery === this.token || tokenFromHeader === this.token);
    }

    private async handleOpencodeUsage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const input = await readJsonBody<OpencodeUsageRequestInput>(req);
            const result = await fetchOpencodeUsage(input);
            this.json(res, 200, result);
        } catch (err) {
            this.json(res, 500, {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private json(res: http.ServerResponse, status: number, body: unknown): void {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(body, null, 2));
    }

    private html(res: http.ServerResponse, body: string): void {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
    }
}

function isPortUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const code = (error as NodeJS.ErrnoException).code;
    return code === "EADDRINUSE" || code === "EACCES";
}

interface OpencodeUsageRequestInput {
    workspaceId?: string;
    usageUrl?: string;
    authCookie?: string;
    startPage?: number;
    maxPages?: number;
    serverId?: string;
}

interface OpencodeUsageRow {
    id: string;
    workspaceID: string;
    timeCreated: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWrite5mTokens: number;
    cacheWrite1hTokens: number;
    totalInputLikeTokens: number;
    costRaw: number;
    costUsd: number;
    sessionID: string;
    page: number;
}

interface OpencodeUsageFetchResult {
    ok: true;
    workspaceId: string;
    pagesFetched: number;
    rows: OpencodeUsageRow[];
    totals: {
        rows: number;
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        cacheReadTokens: number;
        cacheWrite5mTokens: number;
        cacheWrite1hTokens: number;
        totalInputLikeTokens: number;
        costUsd: number;
    };
    warnings: string[];
}

async function fetchOpencodeUsage(input: OpencodeUsageRequestInput): Promise<OpencodeUsageFetchResult> {
    const workspaceId = String(input.workspaceId ?? extractWorkspaceIdFromUsageUrl(input.usageUrl) ?? "").trim();
    const authCookie = String(input.authCookie ?? "").trim();
    const startPage = clampInteger(input.startPage, 2, 0, 10000);
    const maxPages = clampInteger(input.maxPages, 5, 1, 100);
    const serverId = String(input.serverId ?? "").trim();

    if (!workspaceId) {
        throw new Error("Usage URL must contain a workspace id like wrk_...");
    }
    if (!authCookie) {
        throw new Error("authCookie is required.");
    }
    if (!serverId) {
        throw new Error("x-server-id is required. Copy it from Chrome DevTools/curl header.");
    }

    const cookieHeader = normalizeOpencodeCookie(authCookie);
    const rowsById = new Map<string, OpencodeUsageRow>();
    const warnings: string[] = [];
    let pagesFetched = 0;

    for (let page = startPage; page < startPage + maxPages; page++) {
        const body = {
            t: {
                t: 9,
                i: 0,
                l: 2,
                a: [
                    { t: 1, s: workspaceId },
                    { t: 0, s: page },
                ],
                o: 0,
            },
            f: 31,
            m: [],
        };

        const headers: Record<string, string> = {
            "accept": "*/*",
            "accept-language": "es-ES,es;q=0.9",
            "content-type": "application/json",
            "cookie": cookieHeader,
            "origin": "https://opencode.ai",
            "referer": `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/usage`,
            "user-agent": "Mozilla/5.0 OpenCodeGoCopilotSniffer/1.0",
            "x-server-id": serverId,
            "x-server-instance": `server-fn:${page}`,
        };

        const response = await fetch("https://opencode.ai/_server", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });

        const text = await response.text();
        pagesFetched += 1;

        if (!response.ok) {
            throw new Error(`OpenCode usage request failed on page ${page}: HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
        }

        const pageRows = parseOpencodeUsageResponse(text, page);
        if (pageRows.length === 0) {
            warnings.push(`Page ${page} returned no usage rows.`);
            break;
        }

        for (const row of pageRows) {
            rowsById.set(row.id, row);
        }
    }

    const rows = Array.from(rowsById.values()).sort((a, b) => Date.parse(b.timeCreated) - Date.parse(a.timeCreated));
    const totals = rows.reduce((acc, row) => {
        acc.rows += 1;
        acc.inputTokens += row.inputTokens;
        acc.outputTokens += row.outputTokens;
        acc.reasoningTokens += row.reasoningTokens;
        acc.cacheReadTokens += row.cacheReadTokens;
        acc.cacheWrite5mTokens += row.cacheWrite5mTokens;
        acc.cacheWrite1hTokens += row.cacheWrite1hTokens;
        acc.totalInputLikeTokens += row.totalInputLikeTokens;
        acc.costUsd += row.costUsd;
        return acc;
    }, {
        rows: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        totalInputLikeTokens: 0,
        costUsd: 0,
    });

    totals.costUsd = Math.round(totals.costUsd * 1000000) / 1000000;

    return {
        ok: true,
        workspaceId,
        pagesFetched,
        rows,
        totals,
        warnings,
    };
}

function parseOpencodeUsageResponse(text: string, page: number): OpencodeUsageRow[] {
    const rows: OpencodeUsageRow[] = [];
    const regex = /id:\s*"(?<id>usg_[^"]+)"[\s\S]*?workspaceID:\s*"(?<workspaceID>[^"]+)"[\s\S]*?timeCreated:\s*(?:\$R\[\d+\]\s*=\s*)?new Date\("(?<timeCreated>[^"]+)"\)[\s\S]*?model:\s*"(?<model>[^"]*)"[\s\S]*?provider:\s*"(?<provider>[^"]*)"[\s\S]*?inputTokens:\s*(?<inputTokens>-?\d+|null)[\s\S]*?outputTokens:\s*(?<outputTokens>-?\d+|null)[\s\S]*?reasoningTokens:\s*(?<reasoningTokens>-?\d+|null)[\s\S]*?cacheReadTokens:\s*(?<cacheReadTokens>-?\d+|null)[\s\S]*?cacheWrite5mTokens:\s*(?<cacheWrite5mTokens>-?\d+|null)[\s\S]*?cacheWrite1hTokens:\s*(?<cacheWrite1hTokens>-?\d+|null)[\s\S]*?cost:\s*(?<cost>-?\d+|null)[\s\S]*?sessionID:\s*"(?<sessionID>[^"]*)"/g;

    for (const match of text.matchAll(regex)) {
        const groups = match.groups ?? {};
        const inputTokens = parseNullableNumber(groups.inputTokens);
        const outputTokens = parseNullableNumber(groups.outputTokens);
        const reasoningTokens = parseNullableNumber(groups.reasoningTokens);
        const cacheReadTokens = parseNullableNumber(groups.cacheReadTokens);
        const cacheWrite5mTokens = parseNullableNumber(groups.cacheWrite5mTokens);
        const cacheWrite1hTokens = parseNullableNumber(groups.cacheWrite1hTokens);
        const costRaw = parseNullableNumber(groups.cost);

        rows.push({
            id: groups.id ?? "",
            workspaceID: groups.workspaceID ?? "",
            timeCreated: groups.timeCreated ?? "",
            model: groups.model ?? "",
            provider: groups.provider ?? "",
            inputTokens,
            outputTokens,
            reasoningTokens,
            cacheReadTokens,
            cacheWrite5mTokens,
            cacheWrite1hTokens,
            totalInputLikeTokens: inputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens,
            costRaw,
            costUsd: costRaw / 100000000,
            sessionID: groups.sessionID ?? "",
            page,
        });
    }

    return rows;
}

function parseNullableNumber(value: string | undefined): number {
    if (!value || value === "null") return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeOpencodeCookie(value: string): string {
    const trimmed = value.trim();
    if (trimmed.includes("=")) {
        return trimmed.includes("oc_locale=") ? trimmed : `${trimmed}; oc_locale=es`;
    }
    return `auth=${trimmed}; oc_locale=es`;
}

function extractWorkspaceIdFromUsageUrl(value: unknown): string {
    const text = String(value ?? "").trim();
    if (!text) return "";

    const direct = text.match(/\b(wrk_[A-Za-z0-9]+)\b/);
    if (direct) return direct[1];

    try {
        const url = new URL(text);
        const match = url.pathname.match(/\/workspace\/(wrk_[A-Za-z0-9]+)(?:\/|$)/);
        return match ? match[1] : "";
    } catch {
        return "";
    }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function readJsonBody<T>(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
            if (Buffer.byteLength(body, "utf8") > maxBytes) {
                reject(new Error("Request body too large."));
                req.destroy();
            }
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(body || "{}") as T);
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

function dashboardHtml(token: string): string {
    const escapedToken = token.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCode GO Sniffer</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#111;color:#eee}
button,input{font:inherit}
button{background:#252525;color:#eee;border:1px solid #444;border-radius:8px;padding:6px 10px;cursor:pointer}
button:hover{background:#333}
button.tabButton.active{background:#315a8a;border-color:#6aa9ff;color:#fff}
button.tabButton.active:hover{background:#38669c}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.card{background:#1d1d1d;border:1px solid #333;border-radius:10px;padding:14px}
.muted{color:#aaa}
.usagePanel{background:#151515;border:1px solid #333;border-radius:12px;padding:14px;margin:18px 0}
.usageForm{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:12px 0}
.usageForm label{display:flex;flex-direction:column;gap:5px;color:#aaa}
.usageForm input{background:#080808;color:#eee;border:1px solid #444;border-radius:8px;padding:7px}
.usageTable{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
.usageTable th,.usageTable td{border-bottom:1px solid #333;padding:7px;text-align:left}
.usageTable th{color:#aaa;font-weight:600}
.row{padding:10px;border-bottom:1px solid #333;cursor:pointer}
.row:hover{background:#1a1a1a}
.row.selected{background:#202a38}
pre{white-space:pre-wrap;background:#050505;border:1px solid #333;border-radius:10px;padding:12px;overflow:auto}
code{font-family:ui-monospace,SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;font-size:13px;line-height:1.45}
.ok{color:#8ee99a}.error{color:#ff8c8c}.running{color:#ffd580}.aborted{color:#ffcc88}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.split{display:grid;grid-template-columns:minmax(260px,420px) 1fr;gap:16px;align-items:start}
@media(max-width:900px){.split{grid-template-columns:1fr}}
.badge{display:inline-block;border:1px solid #444;border-radius:999px;padding:2px 8px;margin-left:6px;color:#ccc;font-size:12px}
.warn{color:#ffd580}
.jsonTree{font-family:ui-monospace,SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;font-size:13px;line-height:1.45}
.jsonLine{padding:2px 0}
.jsonKey{color:#9cdcfe;cursor:pointer}
.jsonKey:hover{text-decoration:underline}
.jsonValue{color:#ce9178;cursor:pointer}
.jsonValue:hover{text-decoration:underline}
.jsonPrimitive{color:#b5cea8}
.jsonNull{color:#569cd6}
.modalBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;z-index:9999}
.modalBackdrop.open{display:flex}
.modal{width:min(1100px,92vw);height:min(760px,88vh);background:#161616;border:1px solid #444;border-radius:14px;box-shadow:0 20px 70px rgba(0,0,0,.7);display:flex;flex-direction:column}
.modalHeader{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;border-bottom:1px solid #333;padding:12px 14px}
.modalTitle{font-weight:700}
.modalHint{color:#888;font-size:12px;margin-top:4px}
.modalPath{color:#aaa;font-family:ui-monospace,SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace;font-size:12px;margin-top:4px;word-break:break-all}
.modalBody{padding:14px;overflow:auto;white-space:pre-wrap}
.modalBody code{display:block;white-space:pre-wrap}
.modalActions{display:flex;gap:8px}
</style>
</head>
<body>
<h1>OpenCode GO Sniffer</h1>
<p class="muted">Local Sniffer dashboard. Token auth is embedded in this URL.</p>
<div class="toolbar">
  <button id="refreshBtn">Refresh</button>
  <button id="clearBtn">Clear</button>
</div>
<div id="summary" class="cards"></div>

<section class="usagePanel">
  <h2>OpenCode Usage</h2>
  <p class="muted">
    Paste your OpenCode workspace ID and auth cookie. The cookie is stored only in this browser localStorage.
    The local Sniffer server calls opencode.ai server-side to avoid CORS/cookie header limitations.
  </p>
  <div class="usageForm">
    <label>
      Usage URL
      <input id="ocUsageUrl" placeholder="https://opencode.ai/workspace/wrk_.../usage" autocomplete="off" />
    </label>
    <label>
      Auth cookie
      <input id="ocAuthCookie" placeholder="auth=... or raw cookie value" autocomplete="off" type="password" />
    </label>
    <label>
      Start page
      <input id="ocStartPage" type="number" min="0" value="2" />
    </label>
    <label>
      Max pages
      <input id="ocMaxPages" type="number" min="1" max="100" value="5" />
    </label>
    <label>
      Server hash / x-server-id
      <input id="ocServerId" placeholder="bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c" autocomplete="off" />
    </label>
  </div>
  <div class="toolbar">
    <button id="loadOpenCodeUsageBtn">Load OpenCode usage</button>
    <button id="clearOpenCodeUsageConfigBtn">Clear usage config</button>
  </div>
  <div id="ocUsageStatus" class="muted">Not loaded.</div>
  <div id="ocUsageSummary" class="cards"></div>
  <div id="ocUsageWarnings" class="muted"></div>
  <div style="overflow:auto">
    <table id="ocUsageTable" class="usageTable"></table>
  </div>
</section>

<div class="split">
  <section>
    <h2>Requests</h2>
    <div id="requests"></div>
  </section>

  <section>
    <h2>Detail <span id="selectedId" class="badge"></span></h2>
    <div class="toolbar">
      <button id="showSummaryBtn" class="tabButton" data-view="summary">🧾 Summary</button>
      <button id="showRequestBtn" class="tabButton" data-view="request">📤 Request</button>
      <button id="showResponseBtn" class="tabButton" data-view="response">📥 Response</button>
      <button id="copyVisibleBtn">📋 Copy</button>
    </div>
    <label class="muted" style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <input id="showFullStringsToggle" type="checkbox" /> Show full strings in tree
    </label>
    <p id="hint" class="muted">Select a request</p>
    <pre><code id="detail">Select a request</code></pre>
  </section>
</div>
<div id="valueModal" class="modalBackdrop">
  <div class="modal">
    <div class="modalHeader">
      <div>
        <div class="modalTitle">Field value</div>
        <div id="modalPath" class="modalPath"></div>
        <div class="modalHint">Mouse wheel scroll is captured inside this window.</div>
      </div>
      <div class="modalActions">
        <button id="copyModalBtn">📋 Copy</button>
        <button id="closeModalBtn">✕ Close</button>
      </div>
    </div>
    <pre class="modalBody"><code id="modalValue"></code></pre>
  </div>
</div>
<script>
const token = "${escapedToken}";
let selectedRequest = null;
let currentView = 'summary';
let currentText = '';
const VALID_VIEWS = new Set(['summary', 'request', 'response']);
const SHOW_FULL_STRINGS_KEY = 'opencodegosniffer.showFullStringsInTree';
const OC_USAGE_URL_KEY = 'opencodegosniffer.openCodeUsage.usageUrl';
const OC_USAGE_COOKIE_KEY = 'opencodegosniffer.openCodeUsage.authCookie';
const OC_USAGE_START_PAGE_KEY = 'opencodegosniffer.openCodeUsage.startPage';
const OC_USAGE_MAX_PAGES_KEY = 'opencodegosniffer.openCodeUsage.maxPages';
const OC_USAGE_SERVER_ID_KEY = 'opencodegosniffer.openCodeUsage.serverId';
let showFullStringsInTree = localStorage.getItem(SHOW_FULL_STRINGS_KEY) === 'true';

async function api(path, init){
  const separator = path.includes('?') ? '&' : '?';
  const r = await fetch(path + separator + 'token=' + encodeURIComponent(token), init);
  if (!r.ok) {
    const text = await r.text();
    throw new Error('HTTP ' + r.status + ': ' + text);
  }
  return r.json();
}

function esc(value){
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

let modalCurrentText = '';

function normalizeEscapedText(value){
  if (typeof value !== 'string') return value;

  // Si viene como string JSON escapado, por ejemplo "\\n", intenta desescaparlo.
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function pretty(value){
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function pathJoin(base, key){
  if (base === '') return String(key);
  if (/^\d+$/.test(String(key))) return base + '[' + key + ']';
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))) return base + '.' + key;
  return base + '[' + encodeURIComponent(String(key)) + ']';
}

function openValueModal(path, value){
  const normalized = normalizeEscapedText(value);
  const text = typeof normalized === 'string' ? normalized : pretty(normalized);

  modalCurrentText = text;
  document.getElementById('modalPath').textContent = path;
  document.getElementById('modalValue').textContent = text;
  document.getElementById('valueModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeValueModal(){
  document.getElementById('valueModal').classList.remove('open');
  document.body.style.overflow = '';
}

function renderJsonTree(value, path = ''){
  if (value === undefined) {
    return '<span class="jsonPrimitive">undefined</span>';
  }

  if (value === null) {
    return '<span class="jsonNull" data-path="'+esc(path)+'">null</span>';
  }

  if (typeof value === 'string') {
    const preview = !showFullStringsInTree && value.length > 180 ? value.slice(0, 180) + '…' : value;
    return '<span class="jsonValue" data-path="'+esc(path)+'" data-kind="value">"'+esc(preview)+'"</span>';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return '<span class="jsonPrimitive" data-path="'+esc(path)+'" data-kind="value">'+esc(value)+'</span>';
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[<div style="padding-left:18px">' +
      value.map((item, index) => {
        const childPath = pathJoin(path, index);
        return '<div class="jsonLine"><span class="jsonKey" data-path="'+esc(childPath)+'">'+index+'</span>: '+renderJsonTree(item, childPath)+'</div>';
      }).join('') +
      '</div>]';
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';

  return '{<div style="padding-left:18px">' +
    entries.map(([key, child]) => {
      const childPath = pathJoin(path, key);
      return '<div class="jsonLine"><span class="jsonKey" data-path="'+esc(childPath)+'">'+esc(key)+'</span>: '+renderJsonTree(child, childPath)+'</div>';
    }).join('') +
    '</div>}';
}

function getByPath(root, path){
  if (!path) return root;

  const parts = [];
  let i = 0;

  while (i < path.length) {
    if (path[i] === '.') {
      i++;
      continue;
    }

    if (path[i] === '[') {
      const end = path.indexOf(']', i);
      if (end === -1) break;
      const raw = path.slice(i + 1, end);
      if (/^\\d+$/.test(raw)) {
        parts.push(Number(raw));
      } else {
        parts.push(decodeURIComponent(raw));
      }
      i = end + 1;
      continue;
    }

    let end = i;
    while (end < path.length && path[end] !== '.' && path[end] !== '[') {
      end++;
    }
    const part = path.slice(i, end);
    if (part) {
      parts.push(part);
    }
    i = end;
  }

  let current = root;
  // The rendered tree root is named "requestBody" or "summary"; it is only a display prefix.
  for (const part of parts[0] === 'requestBody' || parts[0] === 'summary' ? parts.slice(1) : parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function attachJsonTreeHandlers(rootValue){
  document.querySelectorAll('#detail .jsonKey,#detail .jsonValue,#detail .jsonPrimitive,#detail .jsonNull').forEach(el => {
    el.addEventListener('click', event => {
      event.stopPropagation();
      const path = el.getAttribute('data-path') ?? '';
      openValueModal(path, getByPath(rootValue, path));
    });
  });
}

function card(label,value){
  return '<div class="card"><div class="muted">'+esc(label)+'</div><div><strong>'+esc(value)+'</strong></div></div>';
}

function formatNumber(value){
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatUsd(value){
  return '$' + Number(value || 0).toFixed(6);
}

function formatDate(value){
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function extractWorkspaceIdFromUsageUrl(value){
  const text = String(value || '').trim();
  if (!text) return '';

  const direct = text.match(/\\b(wrk_[A-Za-z0-9]+)\\b/);
  if (direct) return direct[1];

  try {
    const url = new URL(text);
    const match = url.pathname.match(/\\/workspace\\/(wrk_[A-Za-z0-9]+)(?:\\/|$)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function syncWorkspaceFromUsageUrl(){
  // Kept as a small validation helper; the workspace is now sent from usageUrl.
  return extractWorkspaceIdFromUsageUrl(document.getElementById('ocUsageUrl').value.trim());
}

function initOpenCodeUsageForm(){
  document.getElementById('ocUsageUrl').value = localStorage.getItem(OC_USAGE_URL_KEY) || '';
  document.getElementById('ocAuthCookie').value = localStorage.getItem(OC_USAGE_COOKIE_KEY) || '';
  document.getElementById('ocStartPage').value = localStorage.getItem(OC_USAGE_START_PAGE_KEY) || '2';
  document.getElementById('ocMaxPages').value = localStorage.getItem(OC_USAGE_MAX_PAGES_KEY) || '5';
  document.getElementById('ocServerId').value = localStorage.getItem(OC_USAGE_SERVER_ID_KEY) || '';
}

function persistOpenCodeUsageForm(){
  localStorage.setItem(OC_USAGE_URL_KEY, document.getElementById('ocUsageUrl').value.trim());
  localStorage.setItem(OC_USAGE_COOKIE_KEY, document.getElementById('ocAuthCookie').value.trim());
  localStorage.setItem(OC_USAGE_START_PAGE_KEY, document.getElementById('ocStartPage').value.trim() || '2');
  localStorage.setItem(OC_USAGE_MAX_PAGES_KEY, document.getElementById('ocMaxPages').value.trim() || '5');
  localStorage.setItem(OC_USAGE_SERVER_ID_KEY, document.getElementById('ocServerId').value.trim());
}

function clearOpenCodeUsageConfig(){
  localStorage.removeItem(OC_USAGE_URL_KEY);
  localStorage.removeItem(OC_USAGE_COOKIE_KEY);
  localStorage.removeItem(OC_USAGE_START_PAGE_KEY);
  localStorage.removeItem(OC_USAGE_MAX_PAGES_KEY);
  localStorage.removeItem(OC_USAGE_SERVER_ID_KEY);
  initOpenCodeUsageForm();
  document.getElementById('ocUsageStatus').textContent = 'Usage config cleared.';
  document.getElementById('ocUsageSummary').innerHTML = '';
  document.getElementById('ocUsageWarnings').textContent = '';
  document.getElementById('ocUsageTable').innerHTML = '';
}

async function loadOpenCodeUsage(){
  persistOpenCodeUsageForm();

  const usageUrl = document.getElementById('ocUsageUrl').value.trim();
  const workspaceId = extractWorkspaceIdFromUsageUrl(usageUrl);
  const authCookie = document.getElementById('ocAuthCookie').value.trim();
  const startPage = Number(document.getElementById('ocStartPage').value || 0);
  const maxPages = Number(document.getElementById('ocMaxPages').value || 5);
  const serverId = document.getElementById('ocServerId').value.trim();

  if (!workspaceId) {
    throw new Error('Usage URL must contain a workspace id like wrk_...');
  }
  if (!serverId) {
    throw new Error('Server hash / x-server-id is required. Copy it from the curl header.');
  }

  document.getElementById('ocUsageStatus').textContent = 'Loading OpenCode usage...';
  document.getElementById('ocUsageWarnings').textContent = '';

  const result = await api('/api/opencode/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usageUrl, workspaceId, authCookie, startPage, maxPages, serverId }),
  });

  document.getElementById('ocUsageStatus').textContent =
    'Loaded ' + result.rows.length + ' rows from ' + result.pagesFetched + ' page(s).';

  document.getElementById('ocUsageSummary').innerHTML =
    card('Rows', formatNumber(result.totals.rows))+
    card('Input tokens', formatNumber(result.totals.inputTokens))+
    card('Output tokens', formatNumber(result.totals.outputTokens))+
    card('Reasoning tokens', formatNumber(result.totals.reasoningTokens))+
    card('Cache read tokens', formatNumber(result.totals.cacheReadTokens))+
    card('Input + cache tokens', formatNumber(result.totals.totalInputLikeTokens))+
    card('Cost', formatUsd(result.totals.costUsd));

  document.getElementById('ocUsageWarnings').textContent = (result.warnings || []).join(' ');

  const rows = result.rows || [];
  document.getElementById('ocUsageTable').innerHTML =
    '<thead><tr>'+
      '<th>Date</th><th>Model</th><th>Provider</th><th>Input</th><th>Output</th><th>Reasoning</th><th>Cache read</th><th>Cost</th><th>Session</th><th>Page</th>'+
    '</tr></thead>'+
    '<tbody>'+
    rows.map(row =>
      '<tr>'+
        '<td title="'+esc(row.timeCreated)+'">'+esc(formatDate(row.timeCreated))+'</td>'+
        '<td>'+esc(row.model)+'</td>'+
        '<td>'+esc(row.provider)+'</td>'+
        '<td>'+esc(formatNumber(row.inputTokens))+'</td>'+
        '<td>'+esc(formatNumber(row.outputTokens))+'</td>'+
        '<td>'+esc(formatNumber(row.reasoningTokens))+'</td>'+
        '<td>'+esc(formatNumber(row.cacheReadTokens))+'</td>'+
        '<td>'+esc(formatUsd(row.costUsd))+'</td>'+
        '<td>'+esc(row.sessionID || '')+'</td>'+
        '<td>'+esc(row.page)+'</td>'+
      '</tr>'
    ).join('')+
    '</tbody>';
}

function updateActiveTab(){
  document.querySelectorAll('.tabButton').forEach(button => {
    button.classList.toggle('active', button.getAttribute('data-view') === currentView);
  });
}

function setCurrentView(view){
  if (!VALID_VIEWS.has(view)) {
    view = 'summary';
  }

  currentView = view;
  localStorage.setItem('opencodegosniffer.currentDetailView', currentView);
  updateActiveTab();
  renderDetail();
}

function renderDetail(){
  const detail = document.getElementById('detail');
  const hint = document.getElementById('hint');
  const selectedId = document.getElementById('selectedId');

  if (!selectedRequest) {
    currentText = 'Select a request';
    updateActiveTab();
    detail.textContent = currentText;
    hint.textContent = 'Select a request';
    selectedId.textContent = '';
    return;
  }

  selectedId.textContent = selectedRequest.id;
  updateActiveTab();

  if (currentView === 'request') {
    if (selectedRequest.requestBody === undefined) {
      currentText = 'Request body was not captured. Enable "opencodegosniffer.localStatsCapturePayloads": true and make a new request.';
      detail.textContent = currentText;
      hint.innerHTML = '<span class="warn">Request payload not captured for this item.</span>';
    } else {
      currentText = pretty(selectedRequest.requestBody);
      detail.innerHTML = '<div class="jsonTree">'+renderJsonTree(selectedRequest.requestBody, 'requestBody')+'</div>';
      hint.textContent = 'Request body sent upstream. Click any property or value to inspect it.';
      attachJsonTreeHandlers(selectedRequest.requestBody);
    }
    return;
  }

  if (currentView === 'response') {
    const response = selectedRequest.responseText ?? selectedRequest.responsePreview;
    if (!response) {
      currentText = 'Response body was not captured yet, or this request produced no text.';
      detail.textContent = currentText;
      hint.innerHTML = '<span class="warn">Response body not available.</span>';
    } else {
      currentText = response;
      detail.textContent = response;
      hint.textContent = selectedRequest.responseText ? 'Full captured response.' : 'Response preview only. Enable payload capture for full response.';
    }
    return;
  }

  const summary = {
    id: selectedRequest.id,
    status: selectedRequest.status,
    modelId: selectedRequest.modelId,
    upstreamModelId: selectedRequest.upstreamModelId,
    apiMode: selectedRequest.apiMode,
    baseUrl: selectedRequest.baseUrl,
    url: selectedRequest.url,
    startedAt: selectedRequest.startedAt,
    endedAt: selectedRequest.endedAt,
    durationMs: selectedRequest.durationMs,
    firstTokenLatencyMs: selectedRequest.firstTokenLatencyMs,
    messageCount: selectedRequest.messageCount,
    estimatedInputTokens: selectedRequest.estimatedInputTokens,
    estimatedOutputTokens: selectedRequest.estimatedOutputTokens,
    usage: selectedRequest.usage,
    pruning: selectedRequest.pruning,
    chunkCount: selectedRequest.chunkCount,
    httpStatus: selectedRequest.httpStatus,
    error: selectedRequest.error,
    hasRequestBody: selectedRequest.requestBody !== undefined,
    hasFullResponseText: selectedRequest.responseText !== undefined,
    responsePreview: selectedRequest.responsePreview,
  };

  currentText = pretty(summary);
  detail.innerHTML = '<div class="jsonTree">'+renderJsonTree(summary, 'summary')+'</div>';
  hint.textContent = 'Request summary. Click any property or value to inspect it.';
  attachJsonTreeHandlers(summary);
}

async function refresh(){
  const s = await api('/api/summary');
  document.getElementById('summary').innerHTML =
    card('Total',s.totalRequests)+
    card('Running',s.runningRequests)+
    card('OK',s.okRequests)+
    card('Errors',s.errorRequests)+
    card('Avg ms',s.averageDurationMs ?? '-')+
    card('Prompt tokens',s.totalPromptTokens)+
    card('Completion tokens',s.totalCompletionTokens)+
    card('Payload capture',s.capturePayloads)+
    card('Pruning saved tokens',s.totalPruningSavedTokens ?? 0)+
    card('Pruning original tokens',s.totalPruningOriginalTokens ?? 0)+
    card('Avg pruning saved %',s.averagePruningSavedPercent ?? '-');

  const items = await api('/api/requests?limit=100');
  const requestsEl = document.getElementById('requests');

  requestsEl.innerHTML = items.map(r =>
    '<div class="row" data-id="'+esc(r.id)+'">'+
      '<b class="'+esc(r.status)+'">'+esc(r.status)+'</b> '+
      esc(r.modelId)+
      ' <span class="muted">'+esc(r.startedAt)+' '+esc(r.durationMs ?? '-')+'ms</span><br>'+
      '<span class="muted">'+esc(r.url ?? r.baseUrl)+'</span>'+
    '</div>'
  ).join('');

  requestsEl.querySelectorAll('.row').forEach(el => {
    el.addEventListener('click', async () => {
      requestsEl.querySelectorAll('.row').forEach(row => row.classList.remove('selected'));
      el.classList.add('selected');
      selectedRequest = await api('/api/requests/'+encodeURIComponent(el.getAttribute('data-id')));
      renderDetail();
    });
  });

  if (selectedRequest) {
    const updated = items.find(r => r.id === selectedRequest.id);
    if (updated) {
      selectedRequest = await api('/api/requests/'+encodeURIComponent(selectedRequest.id));
      renderDetail();
    }
  }
}

async function clearAll(){
  await api('/api/clear',{method:'POST'});
  selectedRequest = null;
  await refresh();
  renderDetail();
}

async function copyVisible(){
  await navigator.clipboard.writeText(currentText || '');
}

function initShowFullStringsToggle(){
  const toggle = document.getElementById('showFullStringsToggle');
  toggle.checked = showFullStringsInTree;
  toggle.addEventListener('change', () => {
    showFullStringsInTree = toggle.checked;
    localStorage.setItem(SHOW_FULL_STRINGS_KEY, String(showFullStringsInTree));
    renderDetail();
  });
}

function stopWheelPropagationInsideModal(){
  const modalBody = document.querySelector('.modalBody');
  modalBody.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
}

function initActiveTab(){
  const savedView = localStorage.getItem('opencodegosniffer.currentDetailView');
  if (savedView && VALID_VIEWS.has(savedView)) {
    currentView = savedView;
  }
  updateActiveTab();
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('clearBtn').addEventListener('click', clearAll);
document.getElementById('showSummaryBtn').addEventListener('click', () => setCurrentView('summary'));
document.getElementById('showRequestBtn').addEventListener('click', () => setCurrentView('request'));
document.getElementById('showResponseBtn').addEventListener('click', () => setCurrentView('response'));
document.getElementById('copyVisibleBtn').addEventListener('click', copyVisible);
document.getElementById('loadOpenCodeUsageBtn').addEventListener('click', () => {
  loadOpenCodeUsage().catch(err => document.getElementById('ocUsageStatus').textContent = String(err && err.stack ? err.stack : err));
});
document.getElementById('clearOpenCodeUsageConfigBtn').addEventListener('click', clearOpenCodeUsageConfig);
document.getElementById('closeModalBtn').addEventListener('click', closeValueModal);
document.getElementById('copyModalBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(modalCurrentText || '');
});
document.getElementById('valueModal').addEventListener('click', event => {
  if (event.target === document.getElementById('valueModal')) {
    closeValueModal();
  }
});
document.getElementById('valueModal').addEventListener('wheel', event => {
  const modal = document.querySelector('.modal');
  if (modal && modal.contains(event.target)) {
    event.stopPropagation();
  } else {
    event.preventDefault();
  }
}, { passive: false });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeValueModal();
  }
});

initActiveTab();
initOpenCodeUsageForm();
initShowFullStringsToggle();
stopWheelPropagationInsideModal();

refresh().catch(err => {
  document.getElementById('detail').textContent = String(err && err.stack ? err.stack : err);
});
setInterval(() => refresh().catch(console.error), 3000);
</script>
</body>
</html>`;
}

function normalizeBindHost(value: string | undefined): string {
    const host = (value ?? "127.0.0.1").trim();
    return host || "127.0.0.1";
}

function hostForUrl(host: string): string {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeRemoteAddress(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (value.startsWith("::ffff:")) return value.slice("::ffff:".length);
    return value;
}

function isAddressAllowed(remoteAddress: string, rulesText: string): boolean {
    const rules = rulesText.split(",").map((part) => part.trim()).filter(Boolean);
    if (rules.length === 0) return false;
    return rules.some((rule) => matchesAddressRule(remoteAddress, rule));
}

function matchesAddressRule(remoteAddress: string, rule: string): boolean {
    const normalizedRule = normalizeRemoteAddress(rule) ?? rule;
    if (normalizedRule === "*" || normalizedRule.toLowerCase() === "any") return true;
    if (normalizedRule.includes("*")) return matchesWildcardIpv4(remoteAddress, normalizedRule);
    if (normalizedRule.includes("/")) return matchesIpv4Network(remoteAddress, normalizedRule);
    return remoteAddress === normalizedRule;
}

function matchesWildcardIpv4(remoteAddress: string, rule: string): boolean {
    const ipParts = parseIpv4(remoteAddress);
    if (!ipParts) return false;
    const ruleParts = rule.split(".");
    if (ruleParts.length !== 4) return false;
    return ruleParts.every((part, index) => {
        if (part === "*") return true;
        const value = Number(part);
        return Number.isInteger(value) && value >= 0 && value <= 255 && value === ipParts[index];
    });
}

function matchesIpv4Network(remoteAddress: string, rule: string): boolean {
    const [networkText, maskText] = rule.split("/", 2);
    const ip = ipv4ToNumber(remoteAddress);
    const network = ipv4ToNumber(networkText);
    if (ip === undefined || network === undefined || maskText === undefined) return false;

    const mask = parseIpv4Mask(maskText);
    if (mask === undefined) return false;
    return (ip & mask) === (network & mask);
}

function parseIpv4Mask(maskText: string): number | undefined {
    if (/^\d{1,2}$/.test(maskText)) {
        const bits = Number(maskText);
        if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
        return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    }
    return ipv4ToNumber(maskText);
}

function ipv4ToNumber(value: string): number | undefined {
    const parts = parseIpv4(value);
    if (!parts) return undefined;
    return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseIpv4(value: string): [number, number, number, number] | undefined {
    const parts = value.split(".");
    if (parts.length !== 4) return undefined;
    const numbers = parts.map((part) => Number(part));
    if (!numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return undefined;
    return numbers as [number, number, number, number];
}


function getFirstLanIpv4Address(): string | undefined {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family === "IPv4" && !entry.internal) {
                return entry.address;
            }
        }
    }
    return undefined;
}
