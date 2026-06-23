import { ValidationError } from "./errors.js";
import { logInfo } from "./logger.js";
import { makeId, paginate } from "./pagination.js";
import { MemoryStore } from "./store.js";
import { validatePageRequest } from "./validate.js";
import type { Page, PageRequest, Project } from "./types.js";

export class ProjectService {
  private readonly store = new MemoryStore<Project>();

  async createProject(ownerId: string, name: string): Promise<Project> {
    try {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new ValidationError("name", "project name is required");
      }
      const project: Project = {
        id: makeId("prj"),
        ownerId,
        name: trimmed,
        archived: false,
      };
      const saved = await this.store.insert(project);
      logInfo("created project", { id: saved.id });
      return saved;
    } catch (error) {
      logInfo("createProject failed", { ownerId });
      throw error;
    }
  }

  async getProject(id: string): Promise<Project> {
    try {
      return await this.store.findById(id);
    } catch (error) {
      logInfo("getProject failed", { id });
      throw error;
    }
  }

  async listProjects(request: PageRequest): Promise<Page<Project>> {
    try {
      validatePageRequest(request);
      const all = await this.store.list();
      return paginate(all, request);
    } catch (error) {
      logInfo("listProjects failed", { limit: request.limit });
      throw error;
    }
  }

  async archiveProject(id: string): Promise<Project> {
    try {
      const existing = await this.store.findById(id);
      const updated: Project = { ...existing, archived: true };
      await this.store.insert(updated);
      logInfo("archived project", { id });
      return updated;
    } catch (error) {
      logInfo("archiveProject failed", { id });
      throw error;
    }
  }
}
