export const FOREIGN_LIBRARY_API = "speedreader.foreign-library/v2" as const;

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type ForeignCapability =
  | "catalog.search"
  | "catalog.browse"
  | "item.resolve"
  | "item.acquire";

export type ForeignOutputType =
  | "epub"
  | "html"
  | "pdf"
  | "json"
  | "sugarcube"
  | `x-${string}`;

export interface ForeignLibraryOutput {
  /** Stable machine-readable type used by the library browser's filters. */
  type: ForeignOutputType;
  /** Short user-facing name, such as “JSON response”. */
  label: string;
  delivery: Array<"download" | "interactive">;
  mediaTypes?: string[];
  extensions?: string[];
}

export interface ForeignCredentialSlot {
  id: string;
  label: string;
  kind: "api-key" | "bearer-token" | "oauth2";
  required: boolean;
  allowEncryptedStorage: boolean;
}

export interface ForeignLibraryManifest {
  apiVersion: typeof FOREIGN_LIBRARY_API;
  id: string;
  version: string;
  name: string;
  description: string;
  homepage?: string;
  capabilities: ForeignCapability[];
  outputs: ForeignLibraryOutput[];
  permissions: {
    networkOrigins: string[];
    /** Origins opened by the browser for user-directed downloads; the host never fetches them. */
    manualDownloadOrigins?: string[];
    credentials?: ForeignCredentialSlot[];
    rateLimit?: {
      maxConcurrent: number;
      minIntervalMs: number;
    };
    maxResponseBytes?: number;
  };
}

export interface ForeignItemRef {
  libraryId: string;
  itemId: string;
  revision?: string;
}

export type ForeignItemKind = "book" | "paper" | "model" | "feed" | "application";

export interface ForeignLicense {
  name?: string;
  url?: string;
  notice?: string;
}

export interface ForeignOffer {
  id: string;
  label: string;
  outputType: ForeignOutputType;
  importKind: "download" | "interactive";
  mediaType?: string;
  extension?: string;
  byteLength?: number;
  priority?: number;
  risk?: "ordinary-content" | "remote-service" | "executable-content";
}

export interface ForeignItem {
  ref: ForeignItemRef;
  kind: ForeignItemKind;
  title: string;
  authors?: string[];
  summary?: string;
  language?: string;
  publishedAt?: string;
  updatedAt?: string;
  canonicalUrl?: string;
  coverUrl?: string;
  license?: ForeignLicense;
  subjects?: string[];
  offers: ForeignOffer[];
  metadata?: Json;
}

export interface ForeignPage<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export interface ForeignSearchRequest {
  query: string;
  cursor?: string;
  pageSize?: number;
  filters?: Record<string, string | string[]>;
  signal?: AbortSignal;
}

export interface ForeignBrowseRequest {
  collection?: string;
  cursor?: string;
  pageSize?: number;
  filters?: Record<string, string | string[]>;
  signal?: AbortSignal;
}

export interface ForeignRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  /** Ask the host to use a specific route on its configured CORS gateway. */
  gateway?: { route: "gutenberg" | "catalog" };
  credential?: {
    slotId: string;
    placement:
      | { kind: "bearer" }
      | { kind: "header"; headerName: string };
  };
}

export interface ForeignResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export interface ForeignLibraryHost {
  request(request: ForeignRequest): Promise<ForeignResponse>;
}

export interface ForeignProvenance {
  libraryId: string;
  itemId: string;
  revision?: string;
  canonicalUrl?: string;
  acquiredAt?: string;
  license?: ForeignLicense;
}

export interface ForeignDownloadPlan {
  kind: "download";
  /** `manual` opens the source in the browser and imports the file the user selects. */
  acquisition?: "host" | "manual";
  request: ForeignRequest;
  file: {
    name: string;
    extension: string;
    mimeType?: string;
    expectedSha256?: string;
  };
  provenance: ForeignProvenance;
}

export interface ForeignInteractivePlan {
  kind: "interactive";
  format: string;
  publicConfig: Json;
  credentialBindings?: Record<string, string>;
  suggestedTitle: string;
  suggestedAuthor?: string;
  provenance: ForeignProvenance;
}

export type ForeignImportPlan = ForeignDownloadPlan | ForeignInteractivePlan;

export interface ForeignLibrarySession {
  search?(request: ForeignSearchRequest): Promise<ForeignPage<ForeignItem>>;
  browse?(request: ForeignBrowseRequest): Promise<ForeignPage<ForeignItem>>;
  resolve(ref: ForeignItemRef): Promise<ForeignItem>;
  planImport(ref: ForeignItemRef, offerId: string): Promise<ForeignImportPlan>;
  dispose(): void | Promise<void>;
}

export interface ForeignLibraryPlugin {
  readonly manifest: ForeignLibraryManifest;
  open(host: ForeignLibraryHost): Promise<ForeignLibrarySession>;
}

export type ForeignErrorCode =
  | "unsupported"
  | "invalid-request"
  | "permission-denied"
  | "credential-required"
  | "authentication-failed"
  | "rate-limited"
  | "network-unavailable"
  | "cors-blocked"
  | "not-found"
  | "response-too-large"
  | "invalid-response"
  | "acquisition-failed"
  | "cancelled";

export class ForeignLibraryError extends Error {
  constructor(
    public readonly code: ForeignErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ForeignLibraryError";
  }
}
