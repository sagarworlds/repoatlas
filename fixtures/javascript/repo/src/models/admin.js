"use strict";

const User = require("./user");

class Admin extends User {
  constructor(name, email, level) {
    super(name, email);
    this.level = level;
  }

  describe() {
    return `[admin ${this.level}] ${super.describe()}`;
  }

  label() {
    return this.displayName();
  }
}

module.exports = Admin;
