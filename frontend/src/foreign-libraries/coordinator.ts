import type { FileInfo } from "../ingestion/types";
import { sha256 } from "../library/hash";
import { ForeignLibraryError, type ForeignDownloadPlan, type ForeignProvenance } from "./types";
import { ForeignLibraryRegistry } from "./registry";

export interface AcquiredForeignFile {
  file: FileInfo;
  provenance: ForeignProvenance;
}

export class ForeignImportCoordinator {
  constructor(private readonly registry: ForeignLibraryRegistry) {}

  async acquire(plan: ForeignDownloadPlan): Promise<AcquiredForeignFile> {
    this.registry.validatePlan(plan);
    if (plan.acquisition === "manual") {
      throw new ForeignLibraryError("invalid-request", "Manual downloads must be selected through the browser file picker.");
    }
    const response = await this.registry.request(plan.provenance.libraryId, plan.request);
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401 || response.status === 403) {
        throw new ForeignLibraryError("authentication-failed", `The remote library rejected the request (${response.status}).`);
      }
      if (response.status === 404) throw new ForeignLibraryError("not-found", "The selected remote file no longer exists.");
      if (response.status === 429) throw new ForeignLibraryError("rate-limited", "The remote library is rate limiting requests.", true);
      throw new ForeignLibraryError("acquisition-failed", `Download failed: ${response.status} ${response.statusText}`.trim(), response.status >= 500);
    }
    if (plan.file.expectedSha256) {
      const actualSha256 = await sha256(response.body);
      if (actualSha256.toLowerCase() !== plan.file.expectedSha256.toLowerCase()) {
        throw new ForeignLibraryError("invalid-response", "The downloaded file did not match the checksum supplied by the library.");
      }
    }
    return {
      file: {
        name: plan.file.name,
        extension: plan.file.extension.toLowerCase(),
        mimeType: plan.file.mimeType ?? response.headers["content-type"]?.split(";", 1)[0],
        data: response.body,
      },
      provenance: { ...plan.provenance, acquiredAt: new Date().toISOString() },
    };
  }
}
