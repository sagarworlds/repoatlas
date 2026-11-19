import { Entity } from "./base";
import type { Serializable } from "./types";

export class User extends Entity implements Serializable {
  constructor(public name: string) {
    super(name);
  }

  static create(name: string): User {
    return new User(name);
  }

  save(): string {
    this.validate();
    return this.describe();
  }

  validate(): boolean {
    return this.name.length > 0;
  }

  protected override format(): string {
    return `user:${super.format()}`;
  }

  serialize(): string {
    return JSON.stringify({ name: this.name });
  }
}
