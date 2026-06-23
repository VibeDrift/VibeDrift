import { NotFoundError } from "./errors.js";
import { logDebug } from "./logger.js";

// A tiny generic in-memory store. Every method is async/await with try/catch.

export class MemoryStore<TEntity extends { readonly id: string }> {
  private readonly entities = new Map<string, TEntity>();

  async insert(entity: TEntity): Promise<TEntity> {
    try {
      this.entities.set(entity.id, entity);
      logDebug("inserted entity", { id: entity.id });
      return entity;
    } catch (error) {
      logDebug("insert failed", { id: entity.id });
      throw error;
    }
  }

  async findById(id: string): Promise<TEntity> {
    try {
      const found = this.entities.get(id);
      if (found === undefined) {
        throw new NotFoundError("entity", `no entity with id ${id}`);
      }
      return found;
    } catch (error) {
      logDebug("findById failed", { id });
      throw error;
    }
  }

  async list(): Promise<readonly TEntity[]> {
    try {
      return Array.from(this.entities.values());
    } catch (error) {
      logDebug("list failed", { size: this.entities.size });
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      if (!this.entities.delete(id)) {
        throw new NotFoundError("entity", `no entity with id ${id}`);
      }
      logDebug("removed entity", { id });
    } catch (error) {
      logDebug("remove failed", { id });
      throw error;
    }
  }
}
