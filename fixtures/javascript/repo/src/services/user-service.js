"use strict";

const _ = require("lodash");
const { shout: yell } = require("../lib/format");
const User = require("../models/user");
const Admin = require("../models/admin");

function register(name, email) {
  const user = User.create(name, email);
  const stored = user.save(new Map());
  return _.cloneDeep(stored);
}

function promote(name, email) {
  const admin = new Admin(name, email, 2);
  admin.label();
  return yell(admin.describe());
}

module.exports = { register, promote };
