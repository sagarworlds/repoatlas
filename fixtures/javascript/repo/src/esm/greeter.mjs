export function greet(name) {
  return `Hello, ${name}`;
}

export default class Greeter {
  constructor(prefix) {
    this.prefix = prefix;
  }

  say(name) {
    return this.prefix + greet(name);
  }
}
