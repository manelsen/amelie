/**
 * ComandoVideo - Implementação do comando video para ativar/desativar interpretação de vídeo
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoVideo = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  // Função helper para alternar configuração
  const alternarConfiguracaoMedia = (chatId, nomeRecurso) => 
    Trilho.encadear(
      // Obter configuração atual
      () => Trilho.dePromise(gerenciadorConfig.obterConfig(chatId)),
      
      // Alternar valor
      config => {
        const valorAtual = config.mediaVideo === true;
        const novoValor = !valorAtual;
        
        return Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaVideo', novoValor))
          .then(() => ({ novoValor }));
      },
      
      // Retornar resultado
      dados => Resultado.sucesso(dados.novoValor)
    )();
  
  const executar = (mensagem, args, chatId) => {
    return Trilho.encadear(
      // Alternar configuração
      () => alternarConfiguracaoMedia(chatId, 'interpretação de vídeo'),
      
      // Enviar mensagem de confirmação
      novoValor => {
        const mensagemStatus = novoValor ? 'ativada' : 'desativada';
        
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          `A interpretação de vídeo foi ${mensagemStatus} para este chat.`
        ));
      }
    )()
    .then(resultado => {
      if (resultado.sucesso) {
        const status = resultado.dados ? 'ativada' : 'desativada';
        registrador.debug(`Interpretação de vídeo ${status} para o chat ${chatId}`);
      }
      return resultado;
    });
  };
  
  return criarComando(
    'video', 
    'Liga/desliga a interpretação de vídeo', 
    executar
  );
};

module.exports = criarComandoVideo;