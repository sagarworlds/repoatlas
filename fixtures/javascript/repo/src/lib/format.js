"use strict";

const path = require("path");

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

exports.formatName = function formatName(name) {
  return titleCase(name.trim());
};

exports.shout = (text) => text.toUpperCase() + path.sep;

exports.titleCase = titleCase;
