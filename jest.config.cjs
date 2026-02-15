module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json", useESM: false, diagnostics: { ignoreCodes: [151002] } }] },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1"
  }
};
