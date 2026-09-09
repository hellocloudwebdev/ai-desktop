// PR22.6: packages/storage — ConversationModelRepository Interface
//
// Architectural invariants:
//   - Records which provider/model pairing a conversation uses.
//   - Canonical IDs only (e.g. "gemini:gemini-2.5-flash"), never native vendor IDs.
//   - Decoupled from global defaults: historical conversations keep their original model
//     even when the user changes defaults.

export interface StoredConversationModel {
  readonly conversationId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileId: string | null;
  readonly updatedAt: number;
}

export interface SetConversationModelData {
  readonly conversationId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileId?: string | null;
  readonly updatedAt: number;
}

export interface ConversationModelRepository {
  set(data: SetConversationModelData): Promise<StoredConversationModel>;
  getByConversationId(conversationId: string): Promise<StoredConversationModel | null>;
  deleteByConversationId(conversationId: string): Promise<void>;
  listAll(): Promise<StoredConversationModel[]>;
}
