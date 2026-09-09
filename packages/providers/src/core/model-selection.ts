// PR22.3: packages/providers — ModelSelection Canonical Contract
//
// Invariants (Step 42 / PR22.3):
//   1. ModelSelection is a small domain abstraction decoupled from UI.
//   2. The provider must exist, the model must exist, and the model's owning
//      providerId must equal the selection's providerId.
//   3. Canonical IDs (e.g. "gemini:gemini-2.5-flash") are used — never native vendor IDs.

import type { ModelId, ProviderId } from "@ai-desktop/ai-core";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import { ModelSelectionError } from "./provider-errors.js";

export interface ModelSelection {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

/**
 * Validates a ModelSelection against the ProviderRegistry:
 *   provider exists -> model exists -> model.providerId === providerId.
 * Throws ModelSelectionError on any invariant violation.
 */
export function validateModelSelection(
  selection: ModelSelection,
  registry: ProviderRegistry,
): ModelSelection {
  const provider = registry.getProvider(selection.providerId);
  if (!provider) {
    throw new ModelSelectionError(
      `Provider "${selection.providerId}" is not registered`,
      selection.providerId,
      selection.modelId,
    );
  }

  const model = registry.getModel(selection.modelId);
  if (!model) {
    throw new ModelSelectionError(
      `Model "${selection.modelId}" is not registered`,
      selection.providerId,
      selection.modelId,
    );
  }

  if (model.providerId !== selection.providerId) {
    throw new ModelSelectionError(
      `Model "${selection.modelId}" belongs to provider "${model.providerId}" but selection specified provider "${selection.providerId}"`,
      selection.providerId,
      selection.modelId,
    );
  }

  return selection;
}
