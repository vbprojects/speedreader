import { decodeJetstreamEvent } from "./decode";
import { JETSTREAM_ENDPOINTS, type JetstreamEvent } from "./types";

export interface JetstreamSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export type JetstreamSocketFactory = (url: string) => JetstreamSocket;

export interface JetstreamClientOptions {
  endpoints?: readonly string[];
  cursor?: number;
  socketFactory?: JetstreamSocketFactory;
  onEvent: (event: JetstreamEvent) => void;
  onError: (error: Error) => void;
  minReconnectMs?: number;
  maxReconnectMs?: number;
}

export class JetstreamClient {
  private readonly endpoints: readonly string[];
  private readonly socketFactory: JetstreamSocketFactory;
  private readonly onEvent: (event: JetstreamEvent) => void;
  private readonly onError: (error: Error) => void;
  private readonly minReconnectMs: number;
  private readonly maxReconnectMs: number;
  private socket: JetstreamSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private endpointIndex = 0;
  private reconnectMs: number;
  private cursor?: number;
  private disposed = false;

  constructor(options: JetstreamClientOptions) {
    this.endpoints = options.endpoints?.length ? options.endpoints : JETSTREAM_ENDPOINTS;
    this.cursor = options.cursor;
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.minReconnectMs = options.minReconnectMs ?? 1_000;
    this.maxReconnectMs = options.maxReconnectMs ?? 30_000;
    this.reconnectMs = this.minReconnectMs;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as JetstreamSocket);
  }

  start(): void {
    if (!this.disposed && !this.socket) this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  private connect(): void {
    if (this.disposed || this.socket) return;
    const endpoint = this.endpoints[this.endpointIndex % this.endpoints.length];
    const url = new URL(endpoint);
    url.searchParams.append("wantedCollections", "app.bsky.feed.post");
    url.searchParams.set("maxMessageSizeBytes", "65536");
    if (this.cursor !== undefined) url.searchParams.set("cursor", String(this.cursor));
    let socket: JetstreamSocket;
    try {
      socket = this.socketFactory(url.toString());
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectMs = this.minReconnectMs;
    };
    socket.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      const event = decodeJetstreamEvent(data);
      if (!event) return;
      this.cursor = event.cursor ?? event.time_us;
      this.onEvent(event);
    };
    socket.onerror = () => {
      this.onError(new Error("Bluesky Jetstream connection error"));
      socket.close();
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(this.reconnectMs * jitter);
    this.reconnectMs = Math.min(this.maxReconnectMs, this.reconnectMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
