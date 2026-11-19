import { register } from "./index";
import { ping } from "./ping";

export function main(): string {
  ping(1);
  return register("alice");
}

const sample = {
  run() {
    return register("object-literal");
  },
};

sample.run();
main();
