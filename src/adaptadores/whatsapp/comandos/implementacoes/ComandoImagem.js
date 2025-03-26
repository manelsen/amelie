/**
 * ComandoImagem - Implementação do comando imagem para ativar/desativar descrição de imagem
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoImagem = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  // Função helper para alternar configuração
  const alternarConfiguracaoMedia = (chatId, nomeRecurso) => 
    Trilho.encadear(
      // Obter configuração atual
      () => Trilho.dePromise(gerenciadorConfig.obterConfig(chatId)),
      
      // Alternar valor
      config => {
        const valorAtual = config.mediaImage === true;
        const novoValor = !valorAtual;
        
        return Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaImage', novoValor))
          .then(() => ({ novoValor }));
      },
      
      // Retornar resultado
      dados => Resultado.sucesso(dados.novoValor)
    )();
  
  const executar = (mensagem, args, chatId) => {
    return Trilho.encadear(
      // Alternar configuração
      () => alternarConfiguracaoMedia(chatId, 'descrição de imagem'),
      
      // Enviar mensagem de confirmação
      novoValor => {
        const mensagemStatus = novoValor ? 'ativada' : 'desativada';
        
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          `A descrição de imagem foi ${mensagemStatus} para este chat.`
        ));
      }
    )()
    .then(resultado => {
      if (resultado.sucesso) {
        const status = resultado.dados ? 'ativada' : 'desativada';
        registrador.debug(`Descrição de imagem ${status} para o chat ${chatId}`);
      }
      return resultado;
    });
  };
  
  return criarComando(
    'imagem', 
    'Liga/desliga a descrição de imagem', 
    executar
  );
};

module.exports = criarComandoImagem;