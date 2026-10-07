import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  PROTOCOL, WS_PATH, ProtocolError, parseClientMessage, toWireError,
  type Ack, type CommandEnvelope, type CommandResult, type ProjectionEvent, type ServerMessage,
} from "../protocol/index.js";
import type { Bridge } from "./bridge.js";

export interface HubOptions {
  host?: string;
  port?: number;
  webRoot: string;
  /** Tests can shorten leases and limits without modifying production defaults. */
  leaseMs?: number;
  receiptLimit?: number;
  maxClients?: number;
  maxBufferedBytes?: number;
  helloTimeoutMs?: number;
  onConnectionCount?: (count: number) => void;
}
interface Receipt { digest: string; ack: Ack; result?: CommandResult }
interface Lease {
  id: string;
  expiresAt: number;
  nextCommandNo: number;
  receipts: Map<number, Receipt>;
}
interface Peer {
  socket: WebSocket;
  lease?: Lease;
  alive: boolean;
  helloTimer: ReturnType<typeof setTimeout>;
  rateStart: number;
  rateCount: number;
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
  private rebindTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closePromise?: Promise<void>;
  private upgradeRate = { start: Date.now(), count: 0 };
  private commandRate = { start: Date.now(), count: 0 };

  constructor(options: HubOptions) {
    const host = options.host ?? "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new ProtocolError("loopback_only", "M0 accepts loopback addresses only.");
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new ProtocolError("invalid_port", "Port must be between 0 and 65535.");
    this.options = { ...options, host };
  }
  get token(): string { return this._token; }
  get epoch(): string { return this._epoch; }
  get seq(): number { return this._seq; }
  get port(): number { return this._port; }
  get host(): string { return this.options.host!; }
  get origin(): string {
    const host = this.options.host === "::1" ? "[::1]" : this.options.host;
    return `http://${host}:${this._port}`;
  }
  get url(): string { return `${this.origin}/#t=${this._token}`; }
  get connectionCount(): number { return [...this.peers].filter((peer) => peer.lease).length; }
  get running(): boolean { return !!this.server?.listening && !this.closePromise; }
  get switching(): boolean { return this._switching; }
  setConnectionListener(listener: (count: number) => void): void { this.options.onConnectionCount = listener; }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.closePromise) throw new ProtocolError("hub_closed", "Create a new Hub after stopping it.");
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => {
        if (!response.headersSent) { response.writeHead(500); response.end("Request failed"); }
        else response.destroy();
      });
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 5_000;
    this.server.keepAliveTimeout = 3_000;
    this.server.maxHeadersCount = 32;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.has(PROTOCOL) ? PROTOCOL : false });
    this.server.on("upgrade", (request, socket, head) => {
      try {
        if (!this.allowRate(this.upgradeRate, 40, 10_000)) return this.rejectUpgrade(socket, 429);
        if (request.url !== WS_PATH || !this.validHost(request.headers.host)) return this.rejectUpgrade(socket, 403);
        const origin = request.headers.origin;
        if (typeof origin !== "string" || origin !== `http://${request.headers.host}`) return this.rejectUpgrade(socket, 403);
        const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
        const bearer = protocols.filter((value) => value.startsWith("pi-pane.bearer."));
        if (!protocols.includes(PROTOCOL) || bearer.length !== 1 || !safeEqual(bearer[0]!.slice("pi-pane.bearer.".length), this._token))
          return this.rejectUpgrade(socket, 401);
        if (this.peers.size >= (this.options.maxClients ?? 8) * 2) return this.rejectUpgrade(socket, 429);
        this.wss!.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
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
      this.pruneLeases();
      for (const peer of this.peers) {
        if (!peer.alive) { peer.socket.terminate(); continue; }
        peer.alive = false;
        peer.socket.ping();
      }
    }, 15_000);
    this.heartbeat.unref?.();
  }
  private validHost(host: string | undefined): boolean {
    if (!host) return false;
    return [`127.0.0.1:${this._port}`, `localhost:${this._port}`, `[::1]:${this._port}`].includes(host);
  }
  private headers(response: ServerResponse): void {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:${this._port} ws://localhost:${this._port} ws://[::1]:${this._port}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  }
  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.headers(response);
    if (!this.validHost(request.headers.host)) { response.writeHead(403); response.end("Forbidden host"); return; }
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
      response.end("Web assets unavailable. Build the M0 package first.");
    }
  }
  private rejectUpgrade(socket: Duplex, code: number): void {
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  private allowRate(bucket: { start: number; count: number }, limit: number, windowMs = 1000): boolean {
    if (Date.now() - bucket.start >= windowMs) { bucket.start = Date.now(); bucket.count = 0; }
    return ++bucket.count <= limit;
  }
  private accept(socket: WebSocket): void {
    const peer: Peer = { socket, alive: true, rateStart: Date.now(), rateCount: 0,
      helloTimer: setTimeout(() => socket.close(1008, "hello_timeout"), this.options.helloTimeoutMs ?? 5000) };
    peer.helloTimer.unref?.();
    this.peers.add(peer);
    socket.on("error", () => { /* ws handles close; do not leak event errors into TUI. */ });
    socket.on("close", () => { clearTimeout(peer.helloTimer); this.peers.delete(peer); this.notifyCount(); });
    socket.on("pong", () => { peer.alive = true; if (peer.lease) peer.lease.expiresAt = Date.now() + (this.options.leaseMs ?? 30 * 60_000); });
    socket.on("message", (raw, binary) => {
      try { this.receive(peer, raw, binary); } catch (error) { this.sendError(peer, error); }
    });
  }
  private notifyCount(): void { try { this.options.onConnectionCount?.(this.connectionCount); } catch { /* stale UI */ } }
  private receive(peer: Peer, raw: RawData, binary: boolean): void {
    if (binary) throw new ProtocolError("invalid_frame", "Only JSON text frames are accepted.");
    if (Date.now() - peer.rateStart > 1000) { peer.rateStart = Date.now(); peer.rateCount = 0; }
    if (++peer.rateCount > 60 || !this.allowRate(this.commandRate, 240)) { peer.socket.close(1008, "rate_limited"); return; }
    let input: unknown;
    try { input = JSON.parse(raw.toString()); } catch { throw new ProtocolError("invalid_json", "Malformed JSON."); }
    const message = parseClientMessage(input);
    if (message.t !== "command" && Buffer.byteLength(raw.toString()) > 8192) throw new ProtocolError("invalid_frame", "Control frame exceeds 8 KiB.");
    if (message.t === "hello") {
      if (peer.lease) throw new ProtocolError("already_initialized", "This connection already completed hello.");
      this.pruneLeases();
      let lease = message.clientId ? this.leases.get(message.clientId) : undefined;
      if (message.clientId && !lease) throw new ProtocolError("client_expired", "Client lease is unknown or expired. Previous command results are unknown.");
      if (!lease) {
        if (this.leases.size >= (this.options.maxClients ?? 8)) throw new ProtocolError("client_limit", "Client lease capacity reached.");
        lease = { id: randomUUID(), expiresAt: Date.now() + (this.options.leaseMs ?? 30 * 60_000), nextCommandNo: 1, receipts: new Map() };
        this.leases.set(lease.id, lease);
      }
      for (const other of this.peers) if (other !== peer && other.lease === lease) other.socket.close(1000, "connection_replaced");
      peer.lease = lease;
      lease.expiresAt = Date.now() + (this.options.leaseMs ?? 30 * 60_000);
      clearTimeout(peer.helloTimer);
      this.send(peer, { t: "welcome", clientId: lease.id, leaseExpiresAt: lease.expiresAt, nextCommandNo: lease.nextCommandNo });
      this.sendSnapshot(peer);
      this.notifyCount();
      return;
    }
    const lease = this.validLease(peer);
    if (message.t === "resync") { this.sendSnapshot(peer); return; }
    if (message.clientId !== lease.id) throw new ProtocolError("client_mismatch", "Command does not belong to this connection.");
    if (message.t === "receipt_query") {
      const prefix = `${lease.id}:`;
      const number = message.id.startsWith(prefix) ? Number(message.id.slice(prefix.length)) : NaN;
      if (!Number.isSafeInteger(number) || number < 1) throw new ProtocolError("invalid_envelope", "Invalid receipt ID.");
      const receipt = lease.receipts.get(number);
      if (!receipt) throw new ProtocolError(number < lease.nextCommandNo ? "result_unavailable" : "not_seen", "No retained receipt; the host will not be called again.");
      if (receipt.ack.epoch !== this._epoch) throw new ProtocolError("result_unavailable", "The session changed; this operation's result is unknown.");
      this.send(peer, receipt.ack);
      if (receipt.result) this.send(peer, receipt.result);
      return;
    }
    try { this.command(peer, lease, message); }
    catch (error) {
      // A valid command envelope always receives an ID-correlated rejection.
      this.send(peer, { t: "ack", id: message.id, epoch: message.epoch,
        nextCommandNo: lease.nextCommandNo, status: "rejected", error: toWireError(error) });
    }
  }
  private validLease(peer: Peer): Lease {
    const lease = peer.lease;
    if (!lease) throw new ProtocolError("hello_required", "Send hello before commands.");
    if (lease.expiresAt <= Date.now() || this.leases.get(lease.id) !== lease) throw new ProtocolError("client_expired", "Client lease expired; operation results may be unknown.");
    lease.expiresAt = Date.now() + (this.options.leaseMs ?? 30 * 60_000);
    return lease;
  }
  private command(peer: Peer, lease: Lease, command: CommandEnvelope): void {
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
    const receipt: Receipt = { digest, ack: { t: "ack", id: command.id, epoch: command.epoch, nextCommandNo: lease.nextCommandNo, status: "rejected" } };
    lease.receipts.set(command.commandNo, receipt);
    while (lease.receipts.size > (this.options.receiptLimit ?? 128)) lease.receipts.delete(lease.receipts.keys().next().value!);
    let ackSent = false;
    const bridge = this.boundBridge;
    try {
      if (!bridge || this._switching || !bridge.isCurrent() || command.epoch !== this._epoch || command.sessionId !== bridge.sessionId || command.branchRevision !== bridge.branchRevision)
        throw new ProtocolError("stale_session", "Refresh the session snapshot before submitting.");
      bridge.dispatch(command.command, command.args, (result) => {
        if (this.boundBridge !== bridge || this._epoch !== command.epoch || !bridge.isCurrent()) return;
        receipt.result = { t: "command_result", id: command.id, epoch: command.epoch, ...result };
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
  private pruneLeases(): void {
    for (const [id, lease] of this.leases) if (lease.expiresAt <= Date.now()) {
      this.leases.delete(id);
      for (const peer of this.peers) if (peer.lease === lease) peer.socket.close(1008, "client_expired");
    }
  }
  private sendError(peer: Peer, error: unknown): void {
    this.send(peer, { t: "error", error: toWireError(error), ...(peer.lease ? { nextCommandNo: peer.lease.nextCommandNo } : {}) });
  }
  private send(peer: Peer, message: ServerMessage): void {
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(message);
    const size = Buffer.byteLength(data);
    if (size > 1024 * 1024) { peer.socket.close(1009, "spike_snapshot_limit"); return; }
    if (peer.socket.bufferedAmount + size > (this.options.maxBufferedBytes ?? 2 * 1024 * 1024)) {
      peer.socket.close(1013, "slow_client");
      // Do not retain a nonreading socket through an unbounded close handshake.
      const timer = setTimeout(() => peer.socket.terminate(), 1000);
      timer.unref?.();
      return;
    }
    peer.socket.send(data, (error) => { if (error) peer.socket.terminate(); });
  }
  private broadcast(message: ServerMessage): void {
    for (const peer of this.peers) if (peer.lease) this.send(peer, message);
  }
  private sendSnapshot(peer: Peer): void {
    const bridge = this.boundBridge;
    if (!bridge || this._switching) { this.send(peer, { t: "switching", reason: "waiting_for_session" }); return; }
    // snapshot() and watermark capture contain no await, so incrementing events cannot interleave.
    const body = bridge.snapshot();
    this.send(peer, { t: "snapshot", epoch: this._epoch, seq: this._seq, ...body });
  }
  bindBridge(bridge: Bridge, reason = "session_start"): void {
    if (this.rebindTimer) { clearTimeout(this.rebindTimer); this.rebindTimer = undefined; }
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
  private reset(reason: string): void {
    if (!this.boundBridge) return;
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
  suspend(reason: string, onExpire: () => void, timeoutMs = 10_000): void {
    this.boundBridge?.setObserver(undefined);
    this.boundBridge = undefined;
    this._switching = true;
    this.broadcast({ t: "switching", reason });
    if (this.rebindTimer) clearTimeout(this.rebindTimer);
    this.rebindTimer = setTimeout(() => {
      this.rebindTimer = undefined;
      try { onExpire(); } catch { /* Cleanup must still release a Hub with no owner. */ }
      void this.close();
    }, timeoutMs);
    this.rebindTimer.unref?.();
  }
  rotateToken(): void {
    this._token = randomBytes(32).toString("base64url");
    this.leases.clear();
    for (const peer of this.peers) { peer.socket.close(1008, "token_rotated"); peer.socket.terminate(); }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.boundBridge?.setObserver(undefined);
    this.boundBridge = undefined;
    if (this.rebindTimer) clearTimeout(this.rebindTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this._token = "";
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
