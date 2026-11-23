"use strict";

// Prototype-based "class" written before ES2015.
function Counter(start) {
  this.value = start || 0;
}

Counter.prototype.inc = function () {
  this.value += 1;
  return this.report();
};

Counter.prototype.report = function () {
  return this.value;
};

Counter.create = function () {
  return new Counter(0);
};

module.exports = Counter;
