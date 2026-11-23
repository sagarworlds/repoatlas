import Greeter, { greet as hello } from "./greeter.mjs";
import { readFile } from "node:fs/promises";
import { formatName } from "../lib/format.js";

export function run() {
  const greeter = new Greeter("> ");
  greeter.say("bob");
  hello(formatName("amy"));
  return readFile("greeting.txt");
}
