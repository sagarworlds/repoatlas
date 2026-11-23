const { shout } = require("./format");

function banner(name) {
  return shout(name);
}

module.exports = { banner };
