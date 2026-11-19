import { User } from "./models/user";
import { register } from "./service";

function testRegister(): void {
  register("bob");
  const u = new User("bob");
  u.save();
}

testRegister();
