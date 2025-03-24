/**
 * ComandoAudio - Implementação do comando audio para ativar/desativar transcrição de áudio
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoAudio = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  // Função helper para alternar configuração
  const alternarConfiguracaoMedia = (chatId, nomeRecurso) => 
    Trilho.encadear(
      // Obter configuração atual
      () => Trilho.dePromise(gerenciadorConfig.obterConfig(chatId)),
      
      // Alternar valor
      config => {
        const valorAtual = config.mediaAudio === true;
        const novoValor = !valorAtual;
        
        return Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaAudio', novoValor))
          .then(() => ({ novoValor }));
      },
      
      // Retornar resultado
      dados => Resultado.sucesso(dados.novoValor)
    )();
  
  const executar = (mensagem, args, chatId) => {
    return Trilho.encadear(
      // Alternar configuração
      () => alternarConfiguracaoMedia(chatId, 'transcrição de áudio'),
      
      // Enviar mensagem de confirmação
      novoValor => {
        const mensagemStatus = novoValor ? 'ativada' : 'desativada';
        
        return Trilho.dePromise(servicoMensagem.enviarResposta(
          mensagem, 
          `A transcrição de áudio foi ${mensagemStatus} para este chat.`
        ));
      }
    )()
    .then(resultado => {
      if (resultado.sucesso) {
        const status = resultado.dados ? 'ativada' : 'desativada';
        registrador.debug(`Transcrição de áudio ${status} para o chat ${chatId}`);
      }
      return resultado;
    });
  };
  
  return criarComando(
    '.audio', 
    'Liga/desliga a transcrição de áudio', 
    executar
  );
};

module.exports = criarComandoAudio;