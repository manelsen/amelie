/**
 * ComandoLegenda - Implementação do comando legenda para ativar/desativar modo de legendagem
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../../utilitarios/Ferrovia');
const { criarComando } = require('../ComandoBase');

const criarComandoLegenda = (dependencias) => {
  const { registrador, gerenciadorConfig, servicoMensagem } = dependencias;
  
  const executar = (mensagem, args, chatId) => {
    return Trilho.encadear(
      // Obter a configuração atual para verificar o estado
      () => Trilho.dePromise(gerenciadorConfig.obterConfig(chatId)),
      
      // Verificar estado atual e decidir ação
      config => {
        const legendaAtiva = config.usarLegenda === true || config.modoDescricao === 'legenda';
        
        if (legendaAtiva) {
          // DESATIVAR o modo legenda
          return Trilho.encadear(
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'usarLegenda', false)),
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'modoDescricao', 'curto')),
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaVideo', true)),
            () => Resultado.sucesso(false) // Indica que a legenda foi desativada
          )();
        } else {
          // ATIVAR o modo legenda
          return Trilho.encadear(
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'mediaVideo', true)),
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'modoDescricao', 'legenda')),
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'usarLegenda', true)),
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'descricaoLonga', false)),
            () => Trilho.dePromise(gerenciadorConfig.definirConfig(chatId, 'descricaoCurta', false)),
            () => Resultado.sucesso(true) // Indica que a legenda foi ativada
          )();
        }
      },
      
      // Enviar mensagem de confirmação
      foiAtivada => {
        if (foiAtivada) {
          registrador.info(`✅ MODO LEGENDA ATIVADO para ${chatId}`);
          
          return Trilho.dePromise(servicoMensagem.enviarResposta(
            mensagem,
            'Modo de legendagem ativado! ✅\n\n' +
            'Agora, os vídeos que você enviar serão transcritos com timecodes precisos, identificação de quem fala e sons importantes - perfeito para pessoas surdas ou com deficiência auditiva.\n\n' +
            'Basta enviar seu vídeo para receber a legenda detalhada!'
          ));
        } else {
          registrador.info(`🎬 Modo legenda DESATIVADO para ${chatId}`);
          
          return Trilho.dePromise(servicoMensagem.enviarResposta(
            mensagem,
            'Modo de legendagem desativado! ✅\n\n' +
            'Os vídeos agora voltarão a ser processados nos modos normal, curto ou longo.\n\n' +
            'Use .curto ou .longo para escolher o nível de detalhamento da descrição.'
          ));
        }
      }
    )();
  };
  
  return criarComando(
    '.legenda', 
    'Ativa/desativa o modo de legendagem para vídeos', 
    executar
  );
};

module.exports = criarComandoLegenda;