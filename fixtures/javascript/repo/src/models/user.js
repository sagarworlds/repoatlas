"use strict";

const { formatName } = require("../lib/format");

class User {
  constructor(name, email) {
    this.name = name;
    this.email = email;
  }

  static create(name, email) {
    return new User(name, email);
  }

  displayName() {
    return formatName(this.name);
  }

  describe() {
    return `${this.displayName()} <${this.email}>`;
  }

  save(store) {
    store.set(this.email, this);
    return this;
  }
}

module.exports = User;
