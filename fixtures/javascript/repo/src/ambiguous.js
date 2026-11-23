"use strict";

class Cat {
  speak() {
    return "meow";
  }
}

class Dog {
  speak() {
    return "woof";
  }
}

// The receiver is a Cat or a Dog, so the call below can reach either method.
function chorus(flag) {
  const animal = flag ? new Cat() : new Dog();
  return animal.speak();
}

module.exports = { chorus };
