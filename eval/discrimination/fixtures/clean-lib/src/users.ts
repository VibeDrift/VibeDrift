import { logInfo } from "./logger.js";
import { makeId, paginate } from "./pagination.js";
import { MemoryStore } from "./store.js";
import { validateDisplayName, validateEmail, validatePageRequest } from "./validate.js";
import type { Page, PageRequest, User } from "./types.js";

export class UserService {
  private readonly store = new MemoryStore<User>();

  async createUser(email: string, displayName: string): Promise<User> {
    try {
      const user: User = {
        id: makeId("usr"),
        email: validateEmail(email),
        displayName: validateDisplayName(displayName),
        createdAt: new Date().toISOString(),
      };
      const saved = await this.store.insert(user);
      logInfo("created user", { id: saved.id });
      return saved;
    } catch (error) {
      logInfo("createUser failed", { email });
      throw error;
    }
  }

  async getUser(id: string): Promise<User> {
    try {
      return await this.store.findById(id);
    } catch (error) {
      logInfo("getUser failed", { id });
      throw error;
    }
  }

  async listUsers(request: PageRequest): Promise<Page<User>> {
    try {
      validatePageRequest(request);
      const all = await this.store.list();
      return paginate(all, request);
    } catch (error) {
      logInfo("listUsers failed", { limit: request.limit });
      throw error;
    }
  }

  async deleteUser(id: string): Promise<void> {
    try {
      await this.store.remove(id);
      logInfo("deleted user", { id });
    } catch (error) {
      logInfo("deleteUser failed", { id });
      throw error;
    }
  }
}
