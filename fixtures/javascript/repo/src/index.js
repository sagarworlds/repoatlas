"use strict";

const services = require("./services");
const Counter = require("./lib/legacy");
const cycle = require("./cycle/a");
const plugin = require(process.env.PLUGIN || "./plugins");

function start() {
  services.register("ada lovelace", "ada@example.com");
  const counter = new Counter();
  counter.inc();
  Counter.create().report();
  plugin.init();
  return cycle.ping(3);
}

module.exports = { start };
