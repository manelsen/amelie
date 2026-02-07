const criarGerenciadorMensagens = require('./GerenciadorMensagens');

/**
 * Fábrica para o Adaptador de Gerenciador de Mensagens
 * Mantém a mesma API mas usa a implementação funcional.
 */
const criarAdaptadorGerenciadorMensagens = (registrador, clienteWhatsApp, gerenciadorConfig, gerenciadorAI, filasMidia, gerenciadorTransacoes, servicoMensagem) => {
  const dependencias = {
    registrador,
    clienteWhatsApp,
    gerenciadorConfig,
    gerenciadorAI,
    filasMidia,
    gerenciadorTransacoes,
    servicoMensagem
  };
  
  const gerenciador = criarGerenciadorMensagens(dependencias);
  
  return {
    processarMensagem: gerenciador.processarMensagem,
    iniciar: gerenciador.iniciar,
    registrarComoHandler: gerenciador.registrarComoHandler
  };
};

module.exports = { criarAdaptadorGerenciadorMensagens };
