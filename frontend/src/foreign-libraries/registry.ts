import {
  ForeignLibraryError,
  type ForeignImportPlan,
  type ForeignLibraryHost,
  type ForeignLibraryManifest,
  type ForeignLibraryPlugin,
  type ForeignLibrarySession,
  type ForeignRequest,
  type ForeignResponse,
} from "./types";
import { validateForeignImportPlan, validateForeignItem, validateForeignManifest } from "./validation";

export type ForeignHostFactory = (manifest: ForeignLibraryManifest) => ForeignLibraryHost;

export class ForeignLibraryRegistry {
  private readonly plugins = new Map<string, ForeignLibraryPlugin>();
  private readonly hosts = new Map<string, ForeignLibraryHost>();

  constructor(private readonly createHost: ForeignHostFactory) {}

  register(plugin: ForeignLibraryPlugin): void {
    const manifest = validateForeignManifest(plugin.manifest);
    if (this.plugins.has(manifest.id)) throw new ForeignLibraryError("invalid-request", `Foreign Library ${manifest.id} is already registered.`);
    this.plugins.set(manifest.id, plugin);
  }

  get manifests(): ForeignLibraryManifest[] {
    return [...this.plugins.values()].map((plugin) => plugin.manifest);
  }

  manifest(libraryId: string): ForeignLibraryManifest {
    const manifest = this.plugins.get(libraryId)?.manifest;
    if (!manifest) throw new ForeignLibraryError("not-found", `Foreign Library ${libraryId} is not registered.`);
    return manifest;
  }

  private host(libraryId: string): ForeignLibraryHost {
    let host = this.hosts.get(libraryId);
    if (!host) {
      host = this.createHost(this.manifest(libraryId));
      this.hosts.set(libraryId, host);
    }
    return host;
  }

  async open(libraryId: string): Promise<ForeignLibrarySession> {
    const plugin = this.plugins.get(libraryId);
    if (!plugin) throw new ForeignLibraryError("not-found", `Foreign Library ${libraryId} is not registered.`);
    const session = await plugin.open(this.host(libraryId));
    const capabilities = new Set(plugin.manifest.capabilities);
    if (capabilities.has("catalog.search") !== (typeof session.search === "function")
      || capabilities.has("catalog.browse") !== (typeof session.browse === "function")
      || typeof session.resolve !== "function"
      || typeof session.planImport !== "function"
      || typeof session.dispose !== "function") {
      await session.dispose?.();
      throw new ForeignLibraryError("invalid-response", `${plugin.manifest.name} does not implement its declared capabilities.`);
    }
    return {
      search: session.search ? async (request) => {
        const page = await session.search!(request);
        if (!page || !Array.isArray(page.items)) throw new ForeignLibraryError("invalid-response", "Plugin returned an invalid search page.");
        return { ...page, items: page.items.map((item) => validateForeignItem(item, plugin.manifest)) };
      } : undefined,
      browse: session.browse ? async (request) => {
        const page = await session.browse!(request);
        if (!page || !Array.isArray(page.items)) throw new ForeignLibraryError("invalid-response", "Plugin returned an invalid browse page.");
        return { ...page, items: page.items.map((item) => validateForeignItem(item, plugin.manifest)) };
      } : undefined,
      resolve: async (ref) => validateForeignItem(await session.resolve(ref), plugin.manifest),
      planImport: async (ref, offerId) => validateForeignImportPlan(await session.planImport(ref, offerId), libraryId),
      dispose: () => session.dispose(),
    };
  }

  request(libraryId: string, request: ForeignRequest): Promise<ForeignResponse> {
    return this.host(libraryId).request(request);
  }

  validatePlan(plan: ForeignImportPlan): ForeignImportPlan {
    const manifest = this.manifest(plan.provenance.libraryId);
    const validated = validateForeignImportPlan(plan, plan.provenance.libraryId);
    const declaredSlots = new Set(manifest.permissions.credentials?.map((slot) => slot.id) ?? []);
    if (validated.kind === "interactive" && Object.values(validated.credentialBindings ?? {}).some((slot) => !declaredSlots.has(slot))) {
      throw new ForeignLibraryError("permission-denied", "The import plan references an undeclared credential slot.");
    }
    return validated;
  }
}
