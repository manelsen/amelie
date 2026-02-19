module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:prettier/recommended',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    // Erros
    'no-console': 'off', // Permitir console.log (importante para logs)
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-var': 'error',
    'prefer-const': 'error',
    'no-throw-literal': 'error',
    
    // Estilo
    'prefer-arrow-callback': 'warn',
    'prefer-template': 'warn',
    'object-shorthand': ['warn', 'properties'],
    'no-param-reassign': 'off', // Necessário para factories
    
    // Assíncrono
    'no-return-await': 'off', // Permitir return await em Railway Pattern
    'require-await': 'warn',
    
    // Melhores práticas
    'eqeqeq': ['error', 'always'],
    'curly': ['error', 'all'],
    'default-case': 'warn',
    'no-else-return': 'warn',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-multi-spaces': 'error',
    'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1 }],
    'no-shadow': 'warn',
    'no-trailing-spaces': 'error',
    'no-undef-init': 'error',
    'array-callback-return': 'warn',
    'consistent-return': 'off', // Necessário para Railway Pattern
    
    // Comentários
    'spaced-comment': ['error', 'always'],
    'capitalized-comments': 'off',
  },
  overrides: [
    {
      files: ['tests/**/*.js'],
      rules: {
        'no-unused-vars': 'off',
        'max-len': 'off',
      },
    },
  ],
};
