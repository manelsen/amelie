/**
 * ComandoBase - Estrutura base para implementação de comandos
 */
const _ = require('lodash/fp');

// Factory de comandos usando padrão funcional
const criarComando = (nome, descricao, executor) => ({
  nome,
  descricao,
  corresponde: cmd => cmd.toLowerCase() === nome.toLowerCase(),
  executar: executor
});

module.exports = { criarComando };