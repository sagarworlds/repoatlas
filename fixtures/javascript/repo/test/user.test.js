"use strict";

const assert = require("assert");
const User = require("../src/models/user");

describe("User", () => {
  it("describes itself", () => {
    const user = new User("ada", "ada@example.com");
    assert.strictEqual(user.describe(), "Ada <ada@example.com>");
  });
});
