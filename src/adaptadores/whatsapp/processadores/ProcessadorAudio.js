/**
 * ProcessadorAudio - Processamento específico para mensagens de áudio
 */
const _ = require('lodash/fp');
const { Resultado, Trilho } = require('../../../utilitarios/Ferrovia');
const crypto = require('crypto');
const { obterOuCriarUsuario } = require('../dominio/OperacoesChat');

const criarProcessadorAudio = (dependencias) => {
  const { 
    registrador, 
    adaptadorIA, 
    gerenciadorConfig, 
    gerenciadorTransacoes, 
    servicoMensagem, 
    clienteWhatsApp 
  } = dependencias;

  // Verifica se o áudio está dentro do limite de tamanho permitido
  const verificarTamanhoAudio = _.curry((dadosAnexo, limiteMB = 20) => {
    const tamanhoAudioMB = dadosAnexo.data.length / (1024 * 1024);
    
    if (tamanhoAudioMB > limiteMB) {
      return Resultado.falha(new Error(`Áudio muito grande (${tamanhoAudioMB.toFixed(2)}MB). Limite: ${limiteMB}MB`));
    }
    
    return Resultado.sucesso(dadosAnexo);
  });

  // Processa mensagem de áudio usando padrão Railway
  const processarMensagemAudio = async (dados) => {
    const { mensagem, chatId, dadosAnexo } = dados;

    return Trilho.encadear(
      // Verificar configuração e obter chat
      () => Promise.all([
        gerenciadorConfig.obterConfig(chatId),
        mensagem.getChat()
      ]),
      
      // Verificar se a transcrição de áudio está habilitada
      ([config, chat]) => {
        if (!config.mediaAudio) {
          registrador.debug(`Transcrição de áudio desabilitada para o chat ${chatId}`);
          return Resultado.falha(new Error("Transcrição de áudio desabilitada"));
        }
        
        return Resultado.sucesso({ config, chat });
      },
      
      // Obter informações do remetente
      dados => 
        obterOuCriarUsuario(gerenciadorConfig, clienteWhatsApp, registrador)(
          mensagem.author || mensagem.from, 
          dados.chat
        )
        .then(remetente => ({ ...dados, remetente: remetente.dados })),
      
      // Verificar tamanho do áudio
      dados => {
        const resultadoTamanho = verificarTamanhoAudio(dadosAnexo);
        
        if (!resultadoTamanho.sucesso) {
          return Trilho.dePromise(
            servicoMensagem.enviarResposta(
              mensagem, 
              'Desculpe, só posso processar áudios de até 20MB.'
            )
          )
          .then(() => resultadoTamanho);
        }
        
        return Resultado.sucesso(dados);
      },
      
      // Preparar dados para processamento
      dados => {
        const ehPTT = dadosAnexo.mimetype === 'audio/ogg; codecs=opus';
        registrador.debug(`Processando arquivo de áudio: ${ehPTT ? 'PTT' : 'Áudio regular'}`);
        
        const hashAudio = crypto.createHash('md5').update(dadosAnexo.data).digest('hex');
        
        return Resultado.sucesso({ ...dados, hashAudio });
      },
      
      // Criar transação
      dados => Trilho.dePromise(
        gerenciadorTransacoes.criarTransacao(mensagem, dados.chat)
      )
      .then(transacao => ({ ...dados, transacao })),
      
      // Marcar como processando
      dados => Trilho.dePromise(
        gerenciadorTransacoes.marcarComoProcessando(dados.transacao.id)
      )
      .then(() => dados),
      
      // Processar áudio com IA
      dados => adaptadorIA.processarAudio(dadosAnexo, dados.hashAudio, dados.config)
        .then(resultado => ({ ...dados, resposta: resultado.dados })),
      
      // Adicionar resposta à transação
      dados => Trilho.dePromise(
        gerenciadorTransacoes.adicionarRespostaTransacao(dados.transacao.id, dados.resposta)
      )
      .then(() => dados),
      
      // Enviar resposta
      dados => Trilho.dePromise(
        servicoMensagem.enviarResposta(mensagem, dados.resposta, dados.transacao.id)
      )
      .then(() => dados),
      
      // Marcar como entregue
      dados => Trilho.dePromise(
        gerenciadorTransacoes.marcarComoEntregue(dados.transacao.id)
      )
      .then(() => Resultado.sucesso({ 
        transacao: dados.transacao, 
        resultado: dados.resposta 
      }))
    )()
    .catch(erro => {
      // Se não for um erro de "Transcrição desabilitada", enviar mensagem de falha
      if (erro.message !== "Transcrição de áudio desabilitada" &&
          erro.message !== "Áudio muito grande") {
        registrador.error(`Erro ao processar mensagem de áudio: ${erro.message}`);
        
        return Trilho.dePromise(
          servicoMensagem.enviarResposta(
            mensagem, 
            'Desculpe, ocorreu um erro ao processar o áudio. Por favor, tente novamente.'
          )
        )
        .then(() => Resultado.falha(erro));
      }
      
      return Resultado.falha(erro);
    });
  };

  return { processarMensagemAudio };
};

module.exports = criarProcessadorAudio;