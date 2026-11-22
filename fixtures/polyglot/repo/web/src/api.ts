import { chunk } from "lodash";
import { formatName } from "./util";

export function greet(name: string): string {
  const pieces = chunk(name.split(""), 3);
  return formatName(pieces.length > 0 ? name : "anonymous");
}
