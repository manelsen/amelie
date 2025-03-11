module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.js?(x)', '**/?(*.)+(spec|test).js?(x)'],
    collectCoverage: true,
    coverageDirectory: 'coverage',
    collectCoverageFrom: ['src/**/*.js'],
    coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
    coverageThreshold: {
      global: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
    testTimeout: 10000, // 10s
    verbose: true,
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  };