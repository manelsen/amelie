const criarGerenciadorMensagens = require('./GerenciadorMensagens');

// Classe adaptadora que mantém a mesma API mas usa a implementação funcional
class AdaptadorGerenciadorMensagens {
  constructor(registrador, clienteWhatsApp, gerenciadorConfig, gerenciadorAI, filasMidia, gerenciadorTransacoes, servicoMensagem) {
    const dependencias = {
      registrador,
      clienteWhatsApp,
      gerenciadorConfig,
      gerenciadorAI,
      filasMidia,
      gerenciadorTransacoes,
      servicoMensagem
    };
    
    this.gerenciador = criarGerenciadorMensagens(dependencias);
    this.processarMensagem = this.gerenciador.processarMensagem;
    this.iniciar = this.gerenciador.iniciar;
    this.registrarComoHandler = this.gerenciador.registrarComoHandler;
  }
}

module.exports = AdaptadorGerenciadorMensagens;