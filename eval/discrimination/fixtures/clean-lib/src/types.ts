// Domain types shared across the library. PascalCase types throughout.

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface Project {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly archived: boolean;
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export interface Page<TItem> {
  readonly items: readonly TItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}
