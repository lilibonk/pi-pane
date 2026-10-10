import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  LIMITS, PROTOCOL, WS_PATH, ProtocolError, isRecord, parseClientMessage, toWireError,
  commandArgs, type Ack, type ClientMessage, type CommandEnvelope, type CommandResult, type HostCommandEnvelope, type HostCommandName, type HostState, type ProjectionEvent, type ServerMessage,
  type ExtensionUiState, type WorkbenchAction, type WorkbenchValues,
} from "../protocol/index.js";
import type { Bridge } from "./bridge.js";

/**
 * External access (§9.1). Requires a public HTTPS origin, a password, and either direct TLS or a
 * same-machine TLS proxy in front of a loopback listener. Without it the Hub is loopback-only.
 */
export interface ExternalAccess {
  publicOrigin: string;
  password: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  proxy?: boolean;
  /** Absolute lifetime of a login session. */
  authTtlMs?: number;
}
/** The foreground host serializes every RPC write and owns workbench metadata. */
export interface HostHandler {
  read(action: WorkbenchAction, args: Record<string, unknown>, revision?: number): Promise<WorkbenchValues[WorkbenchAction]>;
  command(name: string, args: unknown, expected?: { sessionId: string; branchRevision: number; generation: number }): Promise<unknown>;
  answer(id: string, response: Record<string, unknown>): void;
  pendingDialogs(): unknown[];
  uiState(): ExtensionUiState;
  /** Host state and its commands do not depend on a live session. */
  hostState?(): HostState;
  hostCommand?(name: HostCommandName): Promise<unknown>;
}
export interface HubOptions {
  host?: string;
  port?: number;
  webRoot: string;
  external?: ExternalAccess;
  /** Tests can shorten leases and limits without modifying production defaults. */
  leaseMs?: number;
  receiptLimit?: number;
  maxClients?: number;
  maxBufferedBytes?: number;
  helloTimeoutMs?: number;
  maxLoginSessions?: number;
  onConnectionCount?: (count: number) => void;
  onCredentialRotation?: (url: string) => void;
}
/** A password login. Only the token digest is retained. */
interface AuthSession { digest: string; expiresAt: number; timer?: ReturnType<typeof setTimeout> }
interface Receipt { digest: string; ack: Ack; result?: CommandResult }
interface Lease {
  id: string;
  auth?: AuthSession;
  expiresAt: number;
  nextCommandNo: number;
  receipts: Map<number, Receipt>;
}
interface Peer {
  socket: WebSocket;
  auth?: AuthSession;
  lease?: Lease;
  alive: boolean;
  helloTimer: ReturnType<typeof setTimeout>;
  rateStart: number;
  rateCount: number;
  workbenchReads?: number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
const AUTH_TTL_MS = 8 * 60 * 60_000;
/** Close code for an expired or revoked login; the page asks for the password again. */
export const AUTH_EXPIRED = 4401;
function digestOf(token: string): string { return createHash("sha256").update(token).digest("hex"); }
/** Validates the public origin of external access: https, no path, query, fragment or credentials. */
export function parsePublicOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProtocolError("invalid_origin", "The public origin must be an https:// URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") || value.endsWith("/"))
    throw new ProtocolError("invalid_origin", "The public origin must be https://host[:port] without a path.");
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") throw new ProtocolError("invalid_origin", "A wildcard address cannot be a public origin.");
  return url;
}
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json",
};

/** Process-scoped HTTP/WS service. No sockets are opened before start(). */
export class Hub {
  private readonly options: HubOptions;
  private server?: Server;
  private wss?: WebSocketServer;
  private boundBridge?: Bridge;
  private peers = new Set<Peer>();
  private leases = new Map<string, Lease>();
  private _token = randomBytes(32).toString("base64url");
  private _epoch = randomUUID();
  private _seq = 0;
  private _port = 0;
  private _switching = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closePromise?: Promise<void>;
  private upgradeRate = { start: Date.now(), count: 0 };
  private commandRate = { start: Date.now(), count: 0 };
  private workbenchReads = 0;
  private loginRate = { start: Date.now(), count: 0 };
  private loginFailures = new Map<string, { start: number; count: number }>();
  private authSessions = new Map<string, AuthSession>();
  private readonly publicUrl?: URL;
  private readonly password?: Buffer;

  constructor(options: HubOptions) {
    const host = options.host ?? "127.0.0.1";
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new ProtocolError("invalid_port", "Port must be between 0 and 65535.");
    const external = options.external;
    if (!external) {
      if (!LOOPBACK.includes(host))
        throw new ProtocolError("loopback_only", "Non-loopback access needs a public HTTPS origin, PI_PANE_PASSWORD, and TLS or a TLS proxy.");
    } else {
      this.publicUrl = parsePublicOrigin(external.publicOrigin);
      if (typeof external.password !== "string" || external.password.length < 12)
        throw new ProtocolError("password_required", "External access needs PI_PANE_PASSWORD with at least 12 characters.");
      if (!!external.tls === !!external.proxy)
        throw new ProtocolError("transport_required", "External access needs exactly one of TLS certificate/key or proxy mode; plain HTTP is refused.");
      if (external.proxy && !LOOPBACK.includes(host))
        throw new ProtocolError("loopback_only", "In proxy mode the service listens on loopback only; the proxy provides HTTPS.");
      this.password = createHash("sha256").update(external.password).digest();
    }
    this.options = { ...options, host };
  }
  get token(): string { return this._token; }
  get epoch(): string { return this._epoch; }
  get seq(): number { return this._seq; }
  get port(): number { return this._port; }
  get host(): string { return this.options.host!; }
  /** "local": loopback with the link token; "password": external access with login sessions. */
  get mode(): "local" | "password" { return this.publicUrl ? "password" : "local"; }
  get listenAddress(): string {
    const host = this.options.host!.includes(":") ? `[${this.options.host}]` : this.options.host;
    return `${this.options.external?.tls ? "https" : "http"}://${host}:${this._port}`;
  }
  get origin(): string {
    if (this.publicUrl) return this.publicUrl.origin;
    const host = this.options.host === "::1" ? "[::1]" : this.options.host;
    return `http://${host}:${this._port}`;
  }
  get loginCount(): number { this.pruneAuth(); return this.authSessions.size; }
  get url(): string { return `${this.origin}/#t=${this._token}`; }
  get connectionCount(): number { return [...this.peers].filter((peer) => peer.lease).length; }
  get running(): boolean { return !!this.server?.listening && !this.closePromise; }
  get switching(): boolean { return this._switching; }
  setConnectionListener(listener: (count: number) => void): void { this.options.onConnectionCount = listener; }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.closePromise) throw new ProtocolError("hub_closed", "Create a new Hub after stopping it.");
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      void this.handleHttp(request, response).catch(() => {
        if (!response.headersSent) { response.writeHead(500); response.end("Request failed"); }
        else response.destroy();
      });
    };
    const tls = this.options.external?.tls;
    this.server = tls ? createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, handler) : createServer(handler);
    this.server.maxConnections = 64;
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 5_000;
    this.server.keepAliveTimeout = 3_000;
    this.server.maxHeadersCount = 32;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.commandFrameBytes, perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.has(PROTOCOL) ? PROTOCOL : false });
    this.server.on("upgrade", (request, socket, head) => {
      try {
        if (!this.allowRate(this.upgradeRate, 40, 10_000)) return this.rejectUpgrade(socket, 429);
        if (request.url !== WS_PATH || !this.validHost(request.headers.host)) return this.rejectUpgrade(socket, 403);
        if (!this.validOrigin(request.headers.origin, request.headers.host)) return this.rejectUpgrade(socket, 403);
        const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
        const bearer = protocols.filter((value) => value.startsWith("pi-pane.bearer."));
        if (!protocols.includes(PROTOCOL) || bearer.length !== 1) return this.rejectUpgrade(socket, 401);
        const token = bearer[0]!.slice("pi-pane.bearer.".length);
        // External access accepts only login sessions; the bootstrap link token cannot upgrade.
        const auth = this.publicUrl ? this.authSession(token) : undefined;
        if (this.publicUrl ? !auth : !this._token || !safeEqual(token, this._token)) return this.rejectUpgrade(socket, 401);
        if (this.peers.size >= (this.options.maxClients ?? 8) * 2) return this.rejectUpgrade(socket, 429);
        this.wss!.handleUpgrade(request, socket, head, (ws) => this.accept(ws, auth));
      } catch { this.rejectUpgrade(socket, 400); }
    });
    await new Promise<void>((accept, reject) => {
      const onError = (error: Error) => { this.server?.off("listening", onListen); reject(error); };
      const onListen = () => { this.server?.off("error", onError); accept(); };
      this.server!.once("error", onError);
      this.server!.once("listening", onListen);
      this.server!.listen(this.options.port ?? 7878, this.options.host);
    });
    this.server.on("error", () => { /* Errors stay inside the extension boundary. */ });
    this._port = (this.server.address() as AddressInfo).port;
    this.heartbeat = setInterval(() => {
      this.pruneAuth();
      this.pruneLeases();
      for (const peer of this.peers) {
        if (!peer.alive) { peer.socket.terminate(); continue; }
        peer.alive = false;
        peer.socket.ping();
      }
    }, 15_000);
    this.heartbeat.unref?.();
  }
  private loopbackHosts(): string[] { return [`127.0.0.1:${this._port}`, `localhost:${this._port}`, `[::1]:${this._port}`]; }
  /** Exact Host values. A proxy may also forward to the actual loopback upstream address. */
  private validHost(host: string | undefined): boolean {
    if (!host) return false;
    if (!this.publicUrl) return this.loopbackHosts().includes(host);
    return host === this.publicUrl.host || (!!this.options.external?.proxy && this.loopbackHosts().includes(host));
  }
  /** Exact Origin: the public origin in external mode, never a forwarded or wildcard value. */
  private validOrigin(origin: string | undefined, host: string | undefined): boolean {
    if (typeof origin !== "string") return false;
    return this.publicUrl ? origin === this.publicUrl.origin : origin === `http://${host}`;
  }
  private headers(response: ServerResponse): void {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    const sockets = this.publicUrl ? `wss://${this.publicUrl.host}` : this.loopbackHosts().map((host) => `ws://${host}`).join(" ");
    response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${sockets}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  }
  private json(response: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
    response.end(data);
  }
  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.headers(response);
    if (!this.validHost(request.headers.host)) { response.writeHead(403); response.end("Forbidden host"); return; }
    const route = (request.url ?? "/").split("?")[0];
    if (route === "/auth/info" && request.method === "GET") { this.json(response, 200, { mode: this.mode }); return; }
    if (route === "/auth/session") { await this.handleAuth(request, response); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
    if (request.url === "/healthz") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(request.method === "HEAD" ? undefined : '{"ok":true}'); return; }
    let path: string;
    try { path = decodeURIComponent((request.url ?? "/").split("?")[0]!); } catch { response.writeHead(400); response.end(); return; }
    if (!path.startsWith("/") || path.includes("\0") || path.includes("\\") || path.split("/").includes("..")) {
      response.writeHead(403); response.end(); return;
    }
    try {
      const root = await realpath(this.options.webRoot);
      const candidate = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      if (!candidate.startsWith(`${root}${sep}`)) { response.writeHead(403); response.end(); return; }
      const file = await realpath(candidate);
      if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403); response.end(); return; }
      const info = await stat(file);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Content-Length": info.size });
      response.end(request.method === "HEAD" ? undefined : await readFile(file));
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Web assets unavailable. Build the package first.");
    }
  }
  private rejectUpgrade(socket: Duplex, code: number): void {
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  private allowRate(bucket: { start: number; count: number }, limit: number, windowMs = 1000): boolean {
    if (Date.now() - bucket.start >= windowMs) { bucket.start = Date.now(); bucket.count = 0; }
    return ++bucket.count <= limit;
  }
  // -------------------------------------------------------------------------
  // External-access login (§9.2). Only digests of session tokens are kept.
  // -------------------------------------------------------------------------
  private authSession(token: string): AuthSession | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const session = this.authSessions.get(digestOf(token));
    return session && session.expiresAt > Date.now() ? session : undefined;
  }
  private bearerOf(request: IncomingMessage): string {
    const header = request.headers.authorization;
    return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  }
  private async readJson(request: IncomingMessage, limit: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new ProtocolError("body_too_large", "Request body is too large.");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private async handleAuth(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.publicUrl || !this.password) { response.writeHead(404); response.end(); return; }
    if (!this.validOrigin(request.headers.origin, request.headers.host)) { this.json(response, 403, { error: "forbidden_origin" }); return; }
    if (request.method === "GET" || request.method === "DELETE") {
      const session = this.authSession(this.bearerOf(request));
      if (!session) { this.json(response, 401, { error: "login_required" }); return; }
      if (request.method === "DELETE") this.revoke(session, "logged_out");
      this.json(response, 200, request.method === "GET" ? { expiresAt: session.expiresAt } : { ok: true });
      return;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { this.json(response, 415, { error: "json_required" }); return; }
    // A proxy makes every request come from loopback; the global limit always applies.
    const source = this.options.external?.proxy ? "proxy" : request.socket.remoteAddress ?? "unknown";
    const failures = this.loginFailures.get(source);
    if (failures && Date.now() - failures.start > 5 * 60_000) this.loginFailures.delete(source);
    if (!this.allowRate(this.loginRate, 20, 60_000) || (this.loginFailures.get(source)?.count ?? 0) >= 10) {
      this.json(response, 429, { error: "rate_limited", message: "登录尝试过多，请稍后再试。" }); return;
    }
    let body: unknown;
    try { body = await this.readJson(request, 8192); } catch { this.json(response, 400, { error: "invalid_request" }); return; }
    const value = body as Record<string, unknown> | null;
    const valid = !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "bootstrapToken,password" &&
      typeof value.bootstrapToken === "string" && typeof value.password === "string" && value.password.length <= 1024 &&
      !!this._token && safeEqual(value.bootstrapToken, this._token) &&
      timingSafeEqual(createHash("sha256").update(value.password).digest(), this.password);
    if (!valid) {
      const record = this.loginFailures.get(source) ?? { start: Date.now(), count: 0 };
      record.count++;
      this.loginFailures.set(source, record);
      // One message for every failure: never reveal which credential was wrong.
      this.json(response, 401, { error: "login_failed", message: "链接或密码不正确，或链接已失效。" });
      return;
    }
    this.loginFailures.delete(source);
    this.pruneAuth();
    while (this.authSessions.size >= (this.options.maxLoginSessions ?? 16)) this.revoke(this.authSessions.values().next().value!, "login_evicted");
    const token = randomBytes(32).toString("base64url");
    const session: AuthSession = { digest: digestOf(token), expiresAt: Date.now() + (this.options.external?.authTtlMs ?? AUTH_TTL_MS) };
    this.authSessions.set(session.digest, session);
    // Expiry closes the session's connections on time, not at the next heartbeat.
    session.timer = setTimeout(() => this.revoke(session, "auth_expired"), session.expiresAt - Date.now());
    session.timer.unref?.();
    this.json(response, 200, { sessionToken: token, expiresAt: session.expiresAt });
  }
  private revoke(session: AuthSession, reason: string): void {
    clearTimeout(session.timer);
    this.authSessions.delete(session.digest);
    for (const [id, lease] of this.leases) if (lease.auth === session) this.leases.delete(id);
    for (const peer of this.peers) if (peer.auth === session) { peer.socket.close(AUTH_EXPIRED, reason); this.terminateLater(peer); }
  }
  private pruneAuth(): void {
    for (const session of [...this.authSessions.values()]) if (session.expiresAt <= Date.now()) this.revoke(session, "auth_expired");
  }
  private terminateLater(peer: Peer): void {
    const timer = setTimeout(() => peer.socket.terminate(), 1000);
    timer.unref?.();
  }
  private accept(socket: WebSocket, auth?: AuthSession): void {
    const peer: Peer = { socket, auth, alive: true, rateStart: Date.now(), rateCount: 0,
      helloTimer: setTimeout(() => socket.close(1008, "hello_timeout"), this.options.helloTimeoutMs ?? 5000) };
    peer.helloTimer.unref?.();
    this.peers.add(peer);
    socket.on("error", () => { /* ws handles close; do not leak event errors into TUI. */ });
    socket.on("close", () => { clearTimeout(peer.helloTimer); this.peers.delete(peer); this.notifyCount(); });
    socket.on("pong", () => { peer.alive = true; if (peer.lease) peer.lease.expiresAt = this.leaseUntil(peer); });
    socket.on("message", (raw, binary) => {
      try { this.receive(peer, raw, binary); } catch (error) { this.sendError(peer, error); }
    });
  }
  private notifyCount(): void { try { this.options.onConnectionCount?.(this.connectionCount); } catch { /* stale UI */ } }
  /** A lease never outlives the login that created it. */
  private leaseUntil(peer: Peer): number {
    const until = Date.now() + (this.options.leaseMs ?? 30 * 60_000);
    return peer.auth ? Math.min(until, peer.auth.expiresAt) : until;
  }
  private receive(peer: Peer, raw: RawData, binary: boolean): void {
    if (peer.auth && (peer.auth.expiresAt <= Date.now() || !this.authSessions.has(peer.auth.digest))) {
      peer.socket.close(AUTH_EXPIRED, "auth_expired"); this.terminateLater(peer); return;
    }
    if (binary) throw new ProtocolError("invalid_frame", "Only JSON text frames are accepted.");
    if (Date.now() - peer.rateStart > 1000) { peer.rateStart = Date.now(); peer.rateCount = 0; }
    if (++peer.rateCount > 60 || !this.allowRate(this.commandRate, 240)) { peer.socket.close(1008, "rate_limited"); return; }
    let input: unknown;
    try { input = JSON.parse(raw.toString()); } catch { throw new ProtocolError("invalid_json", "Malformed JSON."); }
    const message = parseClientMessage(input);
    if (message.t !== "command" && Buffer.byteLength(raw.toString()) > (message.t === "ui_response" ? 160 * 1024 : 8192)) throw new ProtocolError("invalid_frame", "Control frame exceeds 8 KiB.");
    if (message.t === "hello") {
      if (peer.lease) throw new ProtocolError("already_initialized", "This connection already completed hello.");
      this.pruneLeases();
      let lease = message.clientId ? this.leases.get(message.clientId) : undefined;
      if (lease && lease.auth !== peer.auth) lease = undefined;
      if (message.clientId && !lease) throw new ProtocolError("client_expired", "Client lease is unknown or expired. Previous command results are unknown.");
      if (!lease) {
        if (this.leases.size >= (this.options.maxClients ?? 8)) throw new ProtocolError("client_limit", "Client lease capacity reached.");
        lease = { id: randomUUID(), auth: peer.auth, expiresAt: this.leaseUntil(peer), nextCommandNo: 1, receipts: new Map() };
        this.leases.set(lease.id, lease);
      }
      for (const other of this.peers) if (other !== peer && other.lease === lease) other.socket.close(1000, "connection_replaced");
      peer.lease = lease;
      lease.expiresAt = this.leaseUntil(peer);
      clearTimeout(peer.helloTimer);
      this.send(peer, { t: "welcome", clientId: lease.id, leaseExpiresAt: lease.expiresAt, nextCommandNo: lease.nextCommandNo });
      // Before the snapshot: a page that (re)connects during a failed switch must see the recovery state.
      const hostState = this.hostHandler?.hostState?.();
      if (hostState) this.send(peer, hostState);
      this.sendSnapshot(peer);
      this.notifyCount();
      return;
    }
    const lease = this.validLease(peer);
    if (message.t === "resync") { this.sendSnapshot(peer); return; }
    if (message.t === "ui_response") {
      if (!this.hostHandler) throw new ProtocolError("unsupported", "No dialog is open.");
      const { t: _t, id, ...response } = message;
      this.hostHandler.answer(id, response);
      return;
    }
    if (message.t === "history_page" || message.t === "content_page" || message.t === "image_page") { this.page(peer, message); return; }
    if (message.t === "workbench_query") { void this.workbench(peer, message); return; }
    if (message.clientId !== lease.id) throw new ProtocolError("client_mismatch", "Command does not belong to this connection.");
    if (message.t === "receipt_query") {
      const prefix = `${lease.id}:`;
      const number = message.id.startsWith(prefix) ? Number(message.id.slice(prefix.length)) : NaN;
      if (!Number.isSafeInteger(number) || number < 1) throw new ProtocolError("invalid_envelope", "Invalid receipt ID.");
      const receipt = lease.receipts.get(number);
      if (!receipt) throw new ProtocolError(number < lease.nextCommandNo ? "result_unavailable" : "not_seen", "No retained receipt; the host will not be called again.");
      this.send(peer, receipt.ack);
      if (receipt.result) this.send(peer, receipt.result);
      return;
    }
    try { if (message.t === "host_command") this.hostCommand(peer, lease, message); else this.command(peer, lease, message); }
    catch (error) {
      // A valid command envelope always receives an ID-correlated rejection.
      this.send(peer, { t: "ack", id: message.id, epoch: message.t === "host_command" ? this._epoch : message.epoch,
        nextCommandNo: lease.nextCommandNo, status: "rejected", error: toWireError(error) });
    }
  }
  private validLease(peer: Peer): Lease {
    const lease = peer.lease;
    if (!lease) throw new ProtocolError("hello_required", "Send hello before commands.");
    if (lease.expiresAt <= Date.now() || this.leases.get(lease.id) !== lease) throw new ProtocolError("client_expired", "Client lease expired; operation results may be unknown.");
    lease.expiresAt = this.leaseUntil(peer);
    return lease;
  }
  /** A command about the host: valid without a session, but only against the host state the viewer has seen. */
  private hostCommand(peer: Peer, lease: Lease, command: HostCommandEnvelope): void {
    this.dispatch(peer, lease, command, this._epoch, () => {
      const handler = this.hostHandler;
      if (!handler?.hostState || !handler.hostCommand) throw new ProtocolError("host_unavailable", "The RPC session host is not ready.");
      if (command.hostRevision !== handler.hostState().revision) throw new ProtocolError("stale_host", "The host state changed; check the page before trying again.");
      return handler.hostCommand(command.command);
    });
  }
  private command(peer: Peer, lease: Lease, command: CommandEnvelope): void {
    this.dispatch(peer, lease, command, command.epoch, () => {
      const bridge = this.boundBridge;
      if (!bridge || this._switching || !bridge.isCurrent() || command.epoch !== this._epoch || command.sessionId !== bridge.sessionId || command.branchRevision !== bridge.branchRevision)
        throw new ProtocolError("stale_session", "Refresh the session snapshot before submitting.");
      const args = commandArgs(command.command, command.args);
      if (!this.hostHandler) throw new ProtocolError("host_unavailable", "The RPC session host is not ready.");
      // Every RPC response belongs to its originating receipt. Epoch replacement changes
      // reads and new submissions, never the identity of an already accepted operation.
      return command.command === "access_rotate" ? Promise.resolve(this.prepareRotation())
        : this.hostHandler.command(command.command, args, {
          sessionId: bridge.sessionId, branchRevision: bridge.branchRevision, generation: bridge.generation,
        });
    });
  }
  /** One numbered command per lease: deduplicated by number and content, acknowledged, then resolved once. */
  private dispatch(peer: Peer, lease: Lease, command: { commandNo: number; id: string }, epoch: string, start: () => Promise<unknown>): void {
    const digest = createHash("sha256").update(canonical(command)).digest("hex");
    const previous = lease.receipts.get(command.commandNo);
    if (previous) {
      if (previous.digest !== digest) throw new ProtocolError("command_conflict", "A command ID cannot be reused for different content.");
      this.send(peer, { ...previous.ack, nextCommandNo: lease.nextCommandNo });
      if (previous.result) this.send(peer, previous.result);
      return;
    }
    if (command.commandNo < lease.nextCommandNo) throw new ProtocolError("result_unavailable", "Receipt was evicted; this command will not be executed again.");
    if (command.commandNo !== lease.nextCommandNo) throw new ProtocolError("out_of_order", "Use the next expected command number.");
    if (lease.nextCommandNo >= Number.MAX_SAFE_INTEGER) throw new ProtocolError("client_expired", "Command sequence exhausted; create a new client lease.");
    lease.nextCommandNo++;
    const receipt: Receipt = { digest, ack: { t: "ack", id: command.id, epoch, nextCommandNo: lease.nextCommandNo, status: "rejected" } };
    lease.receipts.set(command.commandNo, receipt);
    while (lease.receipts.size > (this.options.receiptLimit ?? 128)) lease.receipts.delete(lease.receipts.keys().next().value!);
    let ackSent = false;
    try {
      const pending = start();
      void pending.then(
        (value) => ({ status: "completed" as const, value }),
        (error: unknown) => ({ status: "failed" as const, error: toWireError(error) }),
      ).then((result) => {
        receipt.result = { t: "command_result", id: command.id, epoch, ...result };
        if (ackSent) this.send(peer, receipt.result);
      });
      receipt.ack.status = "dispatched";
    } catch (error) {
      receipt.ack.error = toWireError(error);
    }
    this.send(peer, receipt.ack);
    ackSent = true;
    if (receipt.result) this.send(peer, receipt.result);
  }
  private async workbench(peer: Peer, message: Extract<ClientMessage, { t: "workbench_query" }>): Promise<void> {
    const bridge = this.boundBridge;
    let counted = false;
    try {
      if ((peer.workbenchReads ?? 0) >= 8 || this.workbenchReads >= 16) throw new ProtocolError("busy", "Too many workbench reads are in progress.");
      peer.workbenchReads = (peer.workbenchReads ?? 0) + 1;
      this.workbenchReads++;
      counted = true;
      if (!bridge || this._switching || !bridge.isCurrent() || message.epoch !== this._epoch ||
          message.sessionId !== bridge.sessionId || message.branchRevision !== bridge.branchRevision)
        throw new ProtocolError("stale_session", "Refresh the session snapshot before reading the workbench.");
      if (!this.hostHandler) throw new ProtocolError("host_unavailable", "The RPC session host is not ready.");
      const value = await this.hostHandler.read(message.action, message.args, message.branchRevision);
      if (this.boundBridge !== bridge || this._switching || !bridge.isCurrent() || message.epoch !== this._epoch ||
          message.branchRevision !== bridge.branchRevision) throw new ProtocolError("stale_session", "The session changed while reading the workbench.");
      this.send(peer, { t: "workbench_result", reqId: message.reqId, epoch: message.epoch, action: message.action, value });
    } catch (error) {
      this.send(peer, { t: "workbench_result", reqId: message.reqId, epoch: message.epoch, action: message.action, error: toWireError(error) });
    } finally {
      if (counted) { peer.workbenchReads!--; this.workbenchReads--; }
    }
  }
  /** Directed read-only responses. They never consume seq and never call the host's write APIs. */
  private page(peer: Peer, message: Extract<ClientMessage, { t: "history_page" | "content_page" | "image_page" }>): void {
    const bridge = this.boundBridge;
    try {
      if (!bridge || this._switching || !bridge.isCurrent() || message.epoch !== this._epoch)
        throw new ProtocolError("stale_session", "Refresh the session snapshot before reading history.");
      if (message.t === "history_page") {
        if (message.sessionId !== bridge.sessionId) throw new ProtocolError("stale_session", "Refresh the session snapshot before reading history.");
        this.send(peer, { t: "history_page", reqId: message.reqId, epoch: this._epoch, ...bridge.historyPage(message.before, message.branchRevision) });
      } else if (message.t === "content_page") {
        this.send(peer, { t: "content_page", reqId: message.reqId, epoch: this._epoch, ...bridge.contentPage(message.messageId, message.index, message.offset) });
      } else {
        this.send(peer, { t: "image_page", reqId: message.reqId, epoch: this._epoch, ...bridge.imagePage(message.messageId, message.index) });
      }
    } catch (error) {
      this.send(peer, { t: "error", error: toWireError(error), reqId: message.reqId });
    }
  }
  private pruneLeases(): void {
    for (const [id, lease] of this.leases) if (lease.expiresAt <= Date.now()) {
      this.leases.delete(id);
      for (const peer of this.peers) if (peer.lease === lease) peer.socket.close(1008, "client_expired");
    }
  }
  private sendError(peer: Peer, error: unknown): void {
    this.send(peer, { t: "error", error: toWireError(error), ...(peer.lease ? { nextCommandNo: peer.lease.nextCommandNo } : {}) });
  }
  /** Splits one logical frame; the parts are queued synchronously so nothing interleaves. */
  private chunks(data: string): string[] {
    const id = randomUUID();
    const parts = Math.ceil(data.length / LIMITS.chunkChars);
    const frames = [JSON.stringify({ t: "frame_begin", id, parts })];
    for (let index = 0; index < parts; index++)
      frames.push(JSON.stringify({ t: "frame_chunk", id, index, data: data.slice(index * LIMITS.chunkChars, (index + 1) * LIMITS.chunkChars) }));
    frames.push(JSON.stringify({ t: "frame_end", id }));
    return frames;
  }
  private send(peer: Peer, message: ServerMessage): void {
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(message);
    const size = Buffer.byteLength(data);
    if (size > LIMITS.logicalFrameBytes) { peer.socket.close(1009, "frame_limit"); return; }
    const frames = size <= LIMITS.frameBytes ? [data] : this.chunks(data);
    const total = frames.length === 1 ? size : frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0);
    if (peer.socket.bufferedAmount + total > (this.options.maxBufferedBytes ?? LIMITS.sendBufferBytes)) {
      peer.socket.close(1013, "slow_client");
      // Do not retain a nonreading socket through an unbounded close handshake.
      this.terminateLater(peer);
      return;
    }
    for (const frame of frames) peer.socket.send(frame, (error) => { if (error) peer.socket.terminate(); });
  }
  private broadcast(message: ServerMessage): void {
    for (const peer of this.peers) if (peer.lease) this.send(peer, message);
  }
  private hostHandler?: HostHandler;
  setHostHandler(handler: HostHandler | undefined): void { this.hostHandler = handler; }
  get hosted(): boolean { return !!this.hostHandler; }
  /** The host's own state changed: every viewer learns it, with or without a session. */
  publishHostState(): void { const state = this.hostHandler?.hostState?.(); if (state) this.broadcast(state); }
  /** Unsequenced notices from the session host (dialogs), delivered to every authenticated viewer. */
  notifyAll(message: ServerMessage): void { this.broadcast(message); }
  private sendSnapshot(peer: Peer): void {
    const bridge = this.boundBridge;
    if (!bridge || this._switching) { this.send(peer, { t: "switching", reason: "waiting_for_session" }); return; }
    // snapshot() and watermark capture contain no await, so incrementing events cannot interleave.
    const body = bridge.snapshot();
    this.send(peer, { t: "snapshot", epoch: this._epoch, seq: this._seq, ...body, ...(this.hostHandler ? { ui: this.hostHandler.uiState() } : {}) });
    // Open dialogs follow the snapshot so a viewer that (re)connects can answer them.
    for (const dialog of this.hostHandler?.pendingDialogs() ?? []) this.send(peer, dialog as ServerMessage);
  }
  bindBridge(bridge: Bridge, reason = "session_start"): void {
    this.boundBridge?.setObserver(undefined);
    this.boundBridge = bridge;
    this._switching = false;
    bridge.setObserver({
      publish: (event) => { if (this.boundBridge === bridge && !this._switching) this.publish(event); },
      reset: (resetReason) => { if (this.boundBridge === bridge) this.reset(resetReason); },
      switching: (switchReason) => {
        if (this.boundBridge === bridge) { this._switching = true; this.broadcast({ t: "switching", reason: switchReason }); }
      },
    });
    this.reset(reason);
  }
  /** The runtime behind the bridge is being replaced: no session exists until the next bindBridge. */
  suspendBridge(reason: string): void {
    this.boundBridge?.setObserver(undefined);
    this.boundBridge = undefined;
    this._switching = true;
    this.broadcast({ t: "switching", reason });
  }
  private reset(reason: string): void {
    if (!this.boundBridge) return;
    // Coalesced updates belong to the outgoing epoch.
    try { this.boundBridge.flush(); } catch { /* stale */ }
    this._switching = false;
    this._epoch = randomUUID();
    this._seq = 0;
    this.broadcast({ t: "session_reset", epoch: this._epoch, sessionId: this.boundBridge.sessionId, branchRevision: this.boundBridge.branchRevision, reason });
    for (const peer of this.peers) if (peer.lease) this.sendSnapshot(peer);
  }
  publish(event: ProjectionEvent): void {
    if (!this.boundBridge || this._switching) return;
    this.broadcast({ t: "event", epoch: this._epoch, seq: ++this._seq, ev: event });
  }
  /** Revokes the link token, every login session and every connection. */
  private prepareRotation(): { url: string } {
    const token = randomBytes(32).toString("base64url");
    // Deliver the replacement link before revoking the initiating connection.
    setTimeout(() => { if (this.running) this.rotateToken(token); }, 100).unref();
    return { url: `${this.origin}/#t=${token}` };
  }
  rotateToken(token = randomBytes(32).toString("base64url")): void {
    this._token = token;
    for (const session of this.authSessions.values()) clearTimeout(session.timer);
    this.authSessions.clear();
    this.leases.clear();
    for (const peer of this.peers) { peer.socket.close(1008, "token_rotated"); this.terminateLater(peer); }
    try { this.options.onCredentialRotation?.(this.url); } catch { /* Rotation still revokes access. */ }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.boundBridge?.setObserver(undefined);
    this.boundBridge = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this._token = "";
    for (const session of this.authSessions.values()) clearTimeout(session.timer);
    this.authSessions.clear();
    this.leases.clear();
    for (const peer of this.peers) { clearTimeout(peer.helloTimer); peer.socket.terminate(); }
    this.closePromise = new Promise<void>((done) => {
      this.wss?.close();
      if (!this.server?.listening) { done(); return; }
      this.server.close(() => done());
      this.server.closeAllConnections();
    });
    return this.closePromise;
  }
}
