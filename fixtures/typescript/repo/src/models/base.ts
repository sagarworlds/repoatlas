export class Entity {
  constructor(public id: string) {}

  describe(): string {
    return this.format();
  }

  protected format(): string {
    return `entity:${this.id}`;
  }
}
