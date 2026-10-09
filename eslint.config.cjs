const html = require("eslint-plugin-html")
module.exports = [
  {
    files: ["src/**/*.js", "src/**/*.ux", "tools/**/*.cjs"],
    plugins: {html},
    settings: {"html/html-extensions": [".ux"]},
    languageOptions: {ecmaVersion: 2022, sourceType: "module"},
    rules: {
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", {checkLoops: false}]
    }
  }
]
