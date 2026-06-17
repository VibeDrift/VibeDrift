export class ProductRepository {
  async create(data: { name: string; price: number }) {
    return { id: '1', ...data, createdAt: new Date() };
  }

  async findById(id: string) {
    return { id, name: 'Widget', price: 9.99 };
  }

  async findAll() {
    return [{ id: '1', name: 'Widget', price: 9.99 }];
  }
}
