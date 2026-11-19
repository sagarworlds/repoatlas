import fs from "node:fs";
import { chunk } from "lodash";
import { helper as h } from "@lib/strings";
import { slugify } from "@acme/shared";
import { User } from "./models/user";

export function register(name: string): string {
  const clean = h(name);
  const u = new User(clean);
  u.save();
  User.create(slugify(clean));
  chunk([1, 2, 3], 2);
  return fs.existsSync(clean) ? "exists" : "new";
}

const handlers: Record<string, () => void> = {
  ping: () => {},
};

/** The callee depends on a runtime string, so it cannot be resolved statically. */
export function dispatch(name: string): void {
  handlers[name]();
}
