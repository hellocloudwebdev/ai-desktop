// PR26.6: packages/storage — SkillRepository Interface
//
// Architectural Scope:
//   - Storage abstraction for installed skill metadata and enabled state.
//   - Zero Prisma imports outside packages/storage.
//   - Stores metadata and install path references; full packages reside on disk.

export interface StoredSkill {
  readonly id: string; // SkillId
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: string;
  readonly installPath: string;
  readonly checksum: string;
  readonly installedAt: number; // epoch ms
  readonly updatedAt: number; // epoch ms
  readonly enabled: boolean;
  readonly projectId: string | null;
}

export interface CreateSkillData {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: string;
  readonly installPath: string;
  readonly checksum: string;
  readonly installedAt: number;
  readonly updatedAt: number;
  readonly enabled?: boolean;
  readonly projectId?: string | null;
}

export interface SkillRepository {
  saveSkill(data: CreateSkillData): Promise<StoredSkill>;
  getSkillById(id: string): Promise<StoredSkill | null>;
  listSkills(projectId?: string): Promise<StoredSkill[]>;
  setSkillEnabled(id: string, enabled: boolean, projectId?: string): Promise<StoredSkill>;
  deleteSkill(id: string): Promise<void>;
}
