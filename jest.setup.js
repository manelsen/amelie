// Configurações globais para todos os testes
jest.setTimeout(10000); // 10 segundos por padrão

// Silenciar console.log, console.warn e console.error durante os testes
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Limpar todos os mocks antes de cada teste
beforeEach(() => {
  jest.clearAllMocks();
});