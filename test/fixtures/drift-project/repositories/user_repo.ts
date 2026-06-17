export class UserRepository {
  async create(data: { name: string; email: string }) {
    // Clean repository pattern
    return { id: '1', ...data, createdAt: new Date() };
  }

  async findById(id: string) {
    return { id, name: 'Test User', email: 'test@example.com' };
  }

  async findAll() {
    return [{ id: '1', name: 'Test User', email: 'test@example.com' }];
  }
}
